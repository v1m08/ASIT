import { execFile } from 'child_process'
import { delimiter } from 'path'

// ---------------------------------------------------------------------------
// Login-shell PATH for GUI launches on macOS.
//
// A packaged .app started from Finder/Dock inherits launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — not the one the user's shell builds. So
// the `claude` CLI (a `#!/usr/bin/env node` script), Homebrew's python, nvm's
// node etc. all fail to resolve from a child process even though they work in
// Terminal. We ask the user's login shell once, in the background, and merge
// its PATH into ours (theirs first, ours kept as a fallback).
//
// Never blocks boot: fire-and-forget with a hard timeout; any failure leaves
// process.env.PATH exactly as it was. Windows inherits the user PATH already.
// ---------------------------------------------------------------------------

const MARK = '__ASIT_PATH__'
const TIMEOUT_MS = 4000

let started = false

export function mergeLoginShellPath(): Promise<void> {
  if (started || process.platform !== 'darwin') return Promise.resolve()
  started = true
  const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh'
  return new Promise((resolve) => {
    try {
      execFile(
        shell,
        // -i so ~/.zshrc (where most people put PATH edits) is read too; the
        // markers fence off whatever banner/prompt noise an rc file prints.
        ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
        {
          encoding: 'utf-8',
          timeout: TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
          // No TTY and nothing on stdin: an rc file waiting for input gets EOF.
          env: { ...process.env, TERM: 'dumb' }
        },
        (_err, stdout) => {
          try {
            const out = typeof stdout === 'string' ? stdout : ''
            const a = out.indexOf(MARK)
            const b = out.indexOf(MARK, a + MARK.length)
            if (a >= 0 && b > a) {
              const fromShell = out.slice(a + MARK.length, b).trim()
              if (fromShell) process.env.PATH = mergePaths(fromShell, process.env.PATH ?? '')
            }
          } catch {
            // silent: PATH stays as launchd gave it
          }
          resolve()
        }
      ).stdin?.end()
    } catch {
      resolve()
    }
  })
}

/** Login-shell entries first, then any of ours it didn't have. No duplicates. */
export function mergePaths(first: string, second: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [...first.split(delimiter), ...second.split(delimiter)]) {
    if (p && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out.join(delimiter)
}
