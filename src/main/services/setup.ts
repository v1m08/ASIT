import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { invalidateClaudePathCache, resolveClaudePath } from './claude'

// One-click first-run. Installing ASIT is already one click (NSIS oneClick /
// dmg); the friction was the SEPARATE Claude Code install + sign-in. This
// service closes that gap:
//
//  * installCli() runs Anthropic's official native installer — a standalone
//    binary, no Node/npm required — which lands in ~/.local/bin, the FIRST
//    place resolveClaudePath looks on every platform.
//  * openCliLogin() hands the user a real terminal running the CLI's own
//    OAuth flow. Login is interactive by design and that is a feature here:
//    the browser opens, the user clicks Allow, and ASIT never sees, handles,
//    or stores the credentials.
//  * cliLoginStatus() reads the CLI's own on-disk account state so the UI can
//    flip to ✓ on its own, no "check again" button hunt.

const INSTALL_TIMEOUT_MS = 5 * 60_000

let installing = false
let installLog = ''

export function cliInstallState(): { installing: boolean; log: string } {
  return { installing, log: installLog.slice(-2000) }
}

/** Run the official installer; resolves when the binary is (or isn't) there. */
export function installCli(): Promise<{ ok: boolean; path: string | null; detail: string }> {
  if (installing) return Promise.resolve({ ok: false, path: null, detail: 'already installing' })
  if (resolveClaudePath()) {
    return Promise.resolve({ ok: true, path: resolveClaudePath(), detail: 'already installed' })
  }
  installing = true
  installLog = ''
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              'irm https://claude.ai/install.ps1 | iex'
            ],
            { windowsHide: true }
          )
        : spawn('/bin/bash', ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'])

    const finish = (result: { ok: boolean; path: string | null; detail: string }): void => {
      if (!installing) return
      installing = false
      resolve(result)
    }
    const collect = (b: Buffer): void => {
      installLog += b.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => finish({ ok: false, path: null, detail: String(err) }))
    child.on('exit', (code) => {
      invalidateClaudePathCache()
      const path = resolveClaudePath()
      if (path) finish({ ok: true, path, detail: 'installed' })
      else
        finish({
          ok: false,
          path: null,
          detail: `installer exited ${code ?? '?'} without producing a binary — ${installLog.slice(-300).trim() || 'no output'}`
        })
    })
    // A hung download must fail visibly, not spin forever.
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      finish({ ok: false, path: null, detail: 'installer timed out (5 min) — check your connection' })
    }, INSTALL_TIMEOUT_MS)
  })
}

/**
 * Signed in? Read the CLI's OWN account state from disk — never spawn a model
 * turn just to probe auth. Heuristic by nature (an expired token still reads
 * as signed in; the chat error path covers that case with its own hint), and
 * `null` means "can't tell", which the UI treats as "show the sign-in button".
 */
export function cliLoginStatus(): { installed: boolean; loggedIn: boolean | null } {
  const path = resolveClaudePath()
  if (!path) return { installed: false, loggedIn: null }
  const home = homedir()
  try {
    // Windows/Linux store OAuth creds here; macOS uses the Keychain, so fall
    // through to the config file there.
    if (existsSync(join(home, '.claude', '.credentials.json')))
      return { installed: true, loggedIn: true }
    const cfg = join(home, '.claude.json')
    if (existsSync(cfg)) {
      const parsed = JSON.parse(readFileSync(cfg, 'utf-8')) as Record<string, unknown>
      if (parsed.oauthAccount) return { installed: true, loggedIn: true }
      return { installed: true, loggedIn: false }
    }
    return { installed: true, loggedIn: false }
  } catch {
    return { installed: true, loggedIn: null }
  }
}

/**
 * Open a real terminal running the CLI's sign-in. Per-platform, degrading to
 * a clear "do this by hand" message rather than a crash (platform rule).
 */
export function openCliLogin(): { ok: boolean; detail: string } {
  const path = resolveClaudePath()
  if (!path) return { ok: false, detail: 'Claude Code is not installed yet.' }
  try {
    if (process.platform === 'win32') {
      // A console-subsystem exe spawned detached from a GUI process gets its
      // own console window — exactly what we want.
      const child = spawn(path, ['/login'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      child.unref()
      return { ok: true, detail: 'terminal opened' }
    }
    if (process.platform === 'darwin') {
      const cmd = `'${path.replace(/'/g, `'\\''`)}' /login`
      const child = spawn(
        'osascript',
        [
          '-e',
          'tell application "Terminal" to activate',
          '-e',
          `tell application "Terminal" to do script ${JSON.stringify(cmd)}`
        ],
        { detached: true, stdio: 'ignore' }
      )
      child.unref()
      return { ok: true, detail: 'Terminal opened' }
    }
    // Linux: no single terminal emulator to rely on.
    return { ok: false, detail: `Run this in a terminal: ${path} /login` }
  } catch (err) {
    return {
      ok: false,
      detail: `Couldn't open a terminal — run this yourself: ${path} /login (${err instanceof Error ? err.message : String(err)})`
    }
  }
}
