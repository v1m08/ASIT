import { app, session } from 'electron'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
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
//      CLAUDE.md invariant 7), talking CDP over --remote-debugging-pipe:
//      inherited fds, so no port exists for any other local process to reach;
//   2. the user signs in there — a real browser, so Google is satisfied;
//   3. ASIT reads that profile's cookies over the pipe, writes them into
//      persist:asit-browse, closes the browser and deletes the profile.
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
export function googleSignedIn(cookies: CdpCookie[]): boolean {
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
  cdp: CdpPipe
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

/**
 * Opens `url` in a borrowed real browser and resolves once the session has
 * been imported (or the user cancelled / closed it / the timeout hit).
 * `doneWhen` lets a known provider finish on its own (Google: SAPISID);
 * otherwise the user clicks Done in ASIT, or simply closes the browser.
 */
export async function signInWithRealBrowser(
  url: string,
  opts: {
    doneWhen?: (cookies: CdpCookie[]) => boolean
    headless?: boolean
    timeoutMs?: number
  } = {}
): Promise<BridgeResult> {
  if (!/^https?:\/\//i.test(url))
    return {
      ok: false,
      imported: 0,
      reason: 'only http(s) pages can be opened'
    }
  if (active)
    return {
      ok: false,
      imported: 0,
      reason: 'a sign-in is already open in your browser'
    }
  const browser = findBridgeBrowser()
  if (!browser)
    return {
      ok: false,
      imported: 0,
      reason: 'no Chrome, Edge or Brave installed'
    }

  const dir = profileDir()
  wipeProfile(dir)
  mkdirSync(dir, { recursive: true })

  const args = [
    `--user-data-dir=${dir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    // DBSC off (see top of file). Unknown feature names are ignored, so
    // listing both the Chrome-side and net-side names is harmless.
    '--disable-features=EnableBoundSessionCredentials,DeviceBoundSessions,DeviceBoundSessionCredentials',
    ...(opts.headless ? ['--headless=new', '--no-sandbox'] : ['--new-window']),
    url
  ]
  let child: ChildProcess
  try {
    child = spawn(browser.path, args, {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    wipeProfile(dir)
    return {
      ok: false,
      imported: 0,
      browser: browser.name,
      reason: `could not start ${browser.name}: ${String(err)}`
    }
  }
  const toBrowser = child.stdio[3] as Writable | null
  const fromBrowser = child.stdio[4] as Readable | null
  if (!toBrowser || !fromBrowser) {
    child.kill()
    wipeProfile(dir)
    return {
      ok: false,
      imported: 0,
      browser: browser.name,
      reason: 'debugging pipe unavailable'
    }
  }
  const cdp = new CdpPipe(toBrowser, fromBrowser)

  return new Promise<BridgeResult>((resolve) => {
    let last: CdpCookie[] = []
    let settled = false
    let markerAt = 0
    let exited = false

    const read = async (): Promise<boolean> => {
      try {
        const r = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies')
        last = r.cookies ?? []
        return true
      } catch {
        return false
      }
    }

    const end = async (mode: 'import' | 'cancel', reason?: string): Promise<void> => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timeout)
      if (mode === 'import' && !exited) await read()

      let imported = 0
      if (mode === 'import') {
        const ses = session.fromPartition(BROWSE_PARTITION)
        for (const c of last) {
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

      if (!exited) {
        await cdp.send('Browser.close').catch(() => undefined)
        await new Promise<void>((r) => {
          if (exited) return r()
          const t = setTimeout(() => {
            try {
              child.kill()
            } catch {
              /* already gone */
            }
            r()
          }, 5000)
          child.once('exit', () => {
            clearTimeout(t)
            r()
          })
        })
      }
      cdp.fail(new Error('done'))
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

    child.once('exit', () => {
      exited = true
      // The user closed the browser themselves: keep what we last saw.
      void end('import')
    })
    child.once('error', (err) => {
      exited = true
      void end('cancel', `could not start ${browser.name}: ${err.message}`)
    })

    const poll = setInterval(async () => {
      if (settled || !(await read())) return
      if (!opts.doneWhen || !opts.doneWhen(last)) return
      if (!markerAt) markerAt = Date.now()
      else if (Date.now() - markerAt >= SETTLE_MS) void end('import')
    }, POLL_MS)
    const timeout = setTimeout(() => void end('import', 'timed out'), opts.timeoutMs ?? TIMEOUT_MS)

    active = {
      child,
      cdp,
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
