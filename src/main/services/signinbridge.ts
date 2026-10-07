import { app, session } from 'electron'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { Readable, Writable } from 'stream'

// Sign in with a REAL browser, keep the session in ASIT's.
//
// Google refuses to run its sign-in ceremony inside an embedded browser (the
// "this browser or app may not be secure" wall — see useragent.ts). Arc,
// Brave and Edge never see it because they ARE Chromium browsers, not
// webviews. ASIT can't become one, but it can borrow one for the ninety
// seconds sign-in takes:
//
//   1. launch the user's installed Chrome / Edge / Brave on a THROWAWAY
//      profile ASIT owns (userData/signin-bridge — never the user's real
//      profile, whose cookies are app-bound-encrypted and off limits, see
//      CLAUDE.md invariant 7) with NO debugging pipe or port: during sign-in
//      it is just a browser, which is the whole point;
//   2. the user signs in there — a real browser, so Google is satisfied;
//   3. once signed in (cookie names in the profile's store, a click on
//      "I'm signed in", or the window closing), ASIT lets it quit, reopens
//      the profile off screen with --remote-debugging-pipe (inherited fds —
//      no port any other process could reach) on about:blank, reads the
//      cookies, writes them into persist:asit-browse, and deletes the profile.
//
// Device-bound session credentials are switched off in the borrowed browser:
// a DBSC-bound Google cookie refreshes only with a key held by THAT browser,
// so a bound session would silently die in ASIT a few minutes later. Google
// falls back to ordinary cookies for browsers without DBSC (Firefox, Safari).
//
// Containment: this is user-driven only. There is no action verb, no flow
// verb and no agent-reachable IPC (same absence doctrine as the vault); the
// cookies never touch disk outside the borrowed profile, which is deleted.

const BROWSE_PARTITION = 'persist:asit-browse'
const POLL_MS = 1000
/** After the "signed in" marker appears, Google still redirects through a few
 * more hosts setting cookies — give the chain a moment before reading. */
const SETTLE_MS = 2500
const TIMEOUT_MS = 10 * 60_000

export interface BridgeBrowser {
  name: string
  path: string
}

function windowsCandidates(): BridgeBrowser[] {
  const roots = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA']
  ].filter((r): r is string => !!r)
  const rel: [string, string][] = [
    ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
    ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ['Vivaldi', 'Vivaldi\\Application\\vivaldi.exe'],
    ['Chromium', 'Chromium\\Application\\chrome.exe']
  ]
  const out: BridgeBrowser[] = []
  for (const [name, r] of rel) for (const root of roots) out.push({ name, path: join(root, r) })
  return out
}

function macCandidates(): BridgeBrowser[] {
  const apps: [string, string][] = [
    ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['Vivaldi', 'Vivaldi.app/Contents/MacOS/Vivaldi'],
    ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
    // Last: Arc's handling of --user-data-dir / the debugging pipe is the least
    // proven of these, so it is used only when nothing stock is installed.
    ['Arc', 'Arc.app/Contents/MacOS/Arc']
  ]
  const roots = ['/Applications', join(app.getPath('home'), 'Applications')]
  const out: BridgeBrowser[] = []
  for (const [name, r] of apps) for (const root of roots) out.push({ name, path: join(root, r) })
  return out
}

function linuxCandidates(): BridgeBrowser[] {
  const bins: [string, string][] = [
    ['Google Chrome', 'google-chrome'],
    ['Google Chrome', 'google-chrome-stable'],
    ['Microsoft Edge', 'microsoft-edge'],
    ['Brave', 'brave-browser'],
    ['Chromium', 'chromium'],
    ['Chromium', 'chromium-browser']
  ]
  const out: BridgeBrowser[] = []
  for (const [name, bin] of bins) {
    try {
      const p = execFileSync('which', [bin], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (p) out.push({ name, path: p })
    } catch {
      // not installed
    }
  }
  return out
}

/**
 * The first installed Chromium-family browser, or null (the caller then
 * degrades to the plain "open in my browser" handoff). ASIT_SIGNIN_BROWSER
 * overrides — the smoke test points it at a bundled Chromium.
 */
export function findBridgeBrowser(): BridgeBrowser | null {
  const override = process.env.ASIT_SIGNIN_BROWSER
  if (override) return existsSync(override) ? { name: 'Chromium', path: override } : null
  const list =
    process.platform === 'win32'
      ? windowsCandidates()
      : process.platform === 'darwin'
        ? macCandidates()
        : linuxCandidates()
  return list.find((b) => existsSync(b.path)) ?? null
}

/** CDP over --remote-debugging-pipe: fd 3 in, fd 4 out, NUL-delimited JSON. */
class CdpPipe {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  private closed = false

  constructor(
    private readonly out: Writable,
    input: Readable
  ) {
    input.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8')
      let i: number
      while ((i = this.buf.indexOf('\0')) >= 0) {
        const raw = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        try {
          const msg = JSON.parse(raw) as {
            id?: number
            result?: unknown
            error?: { message: string }
          }
          if (msg.id === undefined) continue // an event; we only ever poll
          const p = this.pending.get(msg.id)
          if (!p) continue
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message))
          else p.resolve(msg.result)
        } catch {
          // a malformed frame is dropped, not fatal
        }
      }
    })
    const shut = (): void => this.fail(new Error('browser closed'))
    input.on('close', shut)
    input.on('error', shut)
    out.on('error', shut)
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('browser closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject
      })
      this.out.write(JSON.stringify({ id, method, params }) + '\0')
    })
  }

  fail(err: Error): void {
    this.closed = true
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}

/** The subset of Network.Cookie we use. */
export interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number // seconds since epoch; -1 for a session cookie
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  partitionKey?: unknown
}

/** Translates one CDP cookie into Electron's cookies.set shape. Exported for the smoke test. */
export function toElectronCookie(c: CdpCookie): Electron.CookiesSetDetails {
  const host = c.domain.replace(/^\./, '')
  const details: Electron.CookiesSetDetails = {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite:
      c.sameSite === 'Strict'
        ? 'strict'
        : c.sameSite === 'Lax'
          ? 'lax'
          : c.sameSite === 'None'
            ? 'no_restriction'
            : 'unspecified'
  }
  // A leading dot is how CDP marks a DOMAIN cookie; without it the cookie is
  // host-only, and passing `domain` would silently widen it to subdomains
  // (and __Host- cookies would be rejected outright).
  if (c.domain.startsWith('.')) details.domain = c.domain
  if (!c.session && c.expires > 0) details.expirationDate = c.expires
  return details
}

/** True once Google has issued the cookies that only exist after a real sign-in. */
export function googleSignedIn(cookies: CookieName[]): boolean {
  return cookies.some(
    (c) =>
      /(^|\.)google\.com$/.test(c.domain) && (c.name === 'SAPISID' || c.name === '__Secure-1PSID')
  )
}

export interface BridgeResult {
  ok: boolean
  imported: number
  browser?: string
  reason?: string
}

interface Active {
  child: ChildProcess
  profileDir: string
  finishNow: () => void
  cancelNow: () => void
}
let active: Active | null = null

function profileDir(): string {
  return join(app.getPath('userData'), 'signin-bridge')
}

function wipeProfile(dir: string): void {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    })
  } catch {
    // Windows can hold a lock briefly after exit; the next run (and startup) retries.
  }
}

/** Startup hygiene: a crash mid-bridge must not leave a signed-in profile on disk. */
export function sweepBridgeProfile(): void {
  if (!active) wipeProfile(profileDir())
}

export function bridgeActive(): boolean {
  return active !== null
}

/** "I'm done" — import whatever the borrowed browser holds now. */
export function finishBridge(): void {
  active?.finishNow()
}

/** Abandon: close the borrowed browser, import nothing. */
export function cancelBridge(): void {
  active?.cancelNow()
}

/** Just enough of a cookie to recognise a sign-in: what the on-disk store
 *  shows without decrypting anything (names and hosts are stored in clear). */
export interface CookieName {
  domain: string
  name: string
}

/**
 * Cookie NAMES in a (running) profile, read from a copy of its SQLite store —
 * the browser holds the live file, so we never open it in place. Values are
 * encrypted at rest and never read here. Best-effort: [] on any failure.
 */
export async function profileCookieNames(dir: string): Promise<CookieName[]> {
  const candidates = [join(dir, 'Default', 'Network', 'Cookies'), join(dir, 'Default', 'Cookies')]
  const src = candidates.find((p) => existsSync(p))
  if (!src) return []
  const tmp = join(dir, '..', `signin-bridge-peek-${process.pid}`)
  try {
    copyFileSync(src, tmp)
    if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${tmp}-wal`)
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(tmp, { readonly: true, fileMustExist: true })
    try {
      return (db.prepare('SELECT host_key AS domain, name FROM cookies').all() as CookieName[]) ?? []
    } finally {
      db.close()
    }
  } catch {
    return [] // locked or mid-write — the next poll tries again
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true })
  }
}

/** DBSC off (see top of file). Unknown feature names are ignored. Chromium
 *  refuses to start as root without --no-sandbox (CI containers only). */
const COMMON_ARGS = [
  ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=EnableBoundSessionCredentials,DeviceBoundSessions,DeviceBoundSessionCredentials'
]

/**
 * Wait until the profile's cookie store on disk shows the sign-in.
 *
 * Measured (signin smoke + a direct probe): Chrome batches cookie writes and
 * commits them about every 30s; a SIGTERM shutdown exits cleanly WITHOUT that
 * final commit, so a cookie set eight seconds earlier is simply lost. Closing
 * the window the normal way does commit. Where we can't close it the normal
 * way (macOS/Linux — no window-close message), we wait for the periodic
 * commit to land on disk first, bounded.
 */
async function waitForCommit(
  dir: string,
  ready: (names: CookieName[]) => boolean,
  ms = 33_000
): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ready(await profileCookieNames(dir))) return
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Ask a browser to quit, forcing it only if it ignores us. On Windows the
 *  ask is a window-close message — the same flushing shutdown as a user
 *  closing the window. On POSIX it is SIGTERM, which does NOT flush pending
 *  cookies (see waitForCommit), so callers wait for the commit first. */
async function closeGracefully(child: ChildProcess, ms = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  try {
    if (process.platform === 'win32' && child.pid) {
      // No /F: WM_CLOSE to its windows — a normal, flushing shutdown.
      spawn('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM') // Chrome treats SIGTERM as a clean quit on POSIX
    }
  } catch {
    /* already gone */
  }
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), ms))
  ])
  if (timedOut) {
    try {
      if (process.platform === 'win32' && child.pid)
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill('SIGKILL')
    } catch {
      /* gone */
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
  }
}

/**
 * Phase 2: reopen the (now closed) profile with the debugging pipe and read
 * its cookies. Nothing is navigated — the window shows about:blank and is
 * parked off screen — so no website ever sees a DevTools-attached browser.
 * Headful rather than headless on purpose: headless Chrome may use a mock
 * keychain on macOS/Linux and could not decrypt what phase 1 stored.
 */
async function harvestCookies(
  browser: BridgeBrowser,
  dir: string,
  headless: boolean
): Promise<CdpCookie[]> {
  const args = [
    `--user-data-dir=${dir}`,
    '--remote-debugging-pipe',
    ...COMMON_ARGS,
    ...(headless
      ? ['--headless=new']
      : ['--window-position=-32000,-32000', '--window-size=1,1', '--no-startup-window']),
    'about:blank'
  ]
  const child = spawn(browser.path, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  child.on('error', () => undefined)
  const toBrowser = child.stdio[3] as Writable | null
  const fromBrowser = child.stdio[4] as Readable | null
  if (!toBrowser || !fromBrowser) {
    child.kill()
    return []
  }
  const cdp = new CdpPipe(toBrowser, fromBrowser)
  try {
    // The pipe answers once the browser is up; retry briefly while it boots.
    for (let i = 0; i < 40; i++) {
      try {
        const r = await Promise.race([
          cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), 1500))
        ])
        return r.cookies ?? []
      } catch {
        if (child.exitCode !== null) return []
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    return []
  } finally {
    await cdp.send('Browser.close').catch(() => undefined)
    await closeGracefully(child, 5000)
    cdp.fail(new Error('done'))
  }
}

/**
 * Opens `url` in a borrowed real browser and resolves once the session has
 * been imported (or the user cancelled / the timeout hit).
 *
 * TWO PHASES, deliberately. While the user signs in, the browser runs with
 * NO debugging pipe or port — it is an ordinary Chrome on a fresh profile,
 * the thing Google's sign-in accepts. (A DevTools-attached Chrome is exactly
 * what Google's "browser may not be secure" check refuses: it is how
 * credential-phishing automation works.) Only after it has quit does phase 2
 * reopen the profile with the pipe to read the cookies.
 *
 * Done is detected from cookie NAMES in the profile's store (`doneWhen`,
 * Google: SAPISID), by the user clicking "I'm signed in", or by the browser
 * exiting because the user closed it.
 */
export async function signInWithRealBrowser(
  url: string,
  opts: {
    doneWhen?: (cookies: CookieName[]) => boolean
    headless?: boolean
    timeoutMs?: number
  } = {}
): Promise<BridgeResult> {
  if (!/^https?:\/\//i.test(url))
    return { ok: false, imported: 0, reason: 'only http(s) pages can be opened' }
  if (active)
    return { ok: false, imported: 0, reason: 'a sign-in is already open in your browser' }
  const browser = findBridgeBrowser()
  if (!browser) return { ok: false, imported: 0, reason: 'no Chrome, Edge or Brave installed' }

  const dir = profileDir()
  wipeProfile(dir)
  mkdirSync(dir, { recursive: true })

  const args = [
    `--user-data-dir=${dir}`,
    ...COMMON_ARGS,
    ...(opts.headless
      ? ['--headless=new']
      : ['--new-window']),
    url
  ]
  let child: ChildProcess
  try {
    child = spawn(browser.path, args, { stdio: 'ignore' })
  } catch (err) {
    wipeProfile(dir)
    return {
      ok: false,
      imported: 0,
      browser: browser.name,
      reason: `could not start ${browser.name}: ${String(err)}`
    }
  }

  return new Promise<BridgeResult>((resolve) => {
    let settled = false
    let markerAt = 0
    let polling = false

    const end = async (mode: 'import' | 'cancel', reason?: string): Promise<void> => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timeout)
      // Phase 1 over: get the cookies onto disk, then let the browser quit.
      if (mode === 'import' && child.exitCode === null && process.platform !== 'win32')
        await waitForCommit(dir, (names) =>
          opts.doneWhen ? opts.doneWhen(names) : names.length > 0
        )
      await closeGracefully(child)

      let imported = 0
      if (mode === 'import') {
        const cookies = await harvestCookies(browser, dir, !!opts.headless)
        const ses = session.fromPartition(BROWSE_PARTITION)
        for (const c of cookies) {
          if (c.partitionKey) continue // CHIPS cookies don't map onto cookies.set
          try {
            await ses.cookies.set(toElectronCookie(c))
            imported++
          } catch {
            // e.g. a cookie Chromium itself would reject; skip it, keep the rest
          }
        }
        await ses.cookies.flushStore().catch(() => undefined)
      }
      wipeProfile(dir)
      active = null
      resolve({
        ok: mode === 'import' && imported > 0,
        imported,
        browser: browser.name,
        reason:
          reason ??
          (mode === 'import' && imported === 0
            ? 'nothing to import — the sign-in was not completed'
            : undefined)
      })
    }

    // The user closed the browser themselves: take what the profile holds.
    child.once('exit', () => void end('import'))
    child.once('error', (err) =>
      void end('cancel', `could not start ${browser.name}: ${err.message}`)
    )

    const poll = setInterval(async () => {
      if (settled || polling || !opts.doneWhen) return
      polling = true
      try {
        const names = await profileCookieNames(dir)
        if (!opts.doneWhen(names)) return
        if (!markerAt) markerAt = Date.now()
        else if (Date.now() - markerAt >= SETTLE_MS) void end('import')
      } finally {
        polling = false
      }
    }, POLL_MS)
    const timeout = setTimeout(() => void end('import', 'timed out'), opts.timeoutMs ?? TIMEOUT_MS)

    active = {
      child,
      profileDir: dir,
      finishNow: () => void end('import'),
      cancelNow: () => void end('cancel', 'cancelled')
    }
  })
}

/** Google-flavoured entry point: finishes on its own once the account cookies land. */
export function signInToGoogle(url = 'https://accounts.google.com/'): Promise<BridgeResult> {
  return signInWithRealBrowser(url, { doneWhen: googleSignedIn })
}
