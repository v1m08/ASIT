import { isAbsolute } from 'path'
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import { BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { IPC } from '@shared/ipc-contract'
import { getTask } from './tasks'
import { filterSensitiveLines } from './guardrails'

// Real terminals inside a workspace (ConPTY via a prebuilt addon).
//
// CONTAINMENT — the whole point of this file:
//
//   1. There is NO agent write path. `write()` is reachable only from the
//      renderer's keystroke handler. No action, no flow, no service calls it.
//      An agent cannot type into a shell because the code to do so does not
//      exist — this is absence, not a permission check that could be flipped.
//   2. Reading is opt-in per workspace (`tasks.terminal_ai_read`, default 0)
//      and owner-scoped: a workspace only ever sees its own terminals.
//   3. Private workspaces (invariant 8) are never readable.
//   4. What an agent reads is ANSI-stripped, capped, and passed through the
//      same protected-topic filter as mail (invariant 14) — a shell prints
//      tokens and keys, and that must not become an exfiltration channel.
//
// Honest limit: this does not sandbox the SHELL. A terminal you open runs as
// you, with your privileges — ASIT hosts it, it does not contain it. What is
// contained is the MODEL's reach into it.

interface Session {
  id: string
  owner: string // taskId that opened it — never widened
  pty: IPty
  buffer: string // rolling scrollback, capped
  exited: boolean
  /** Current width. Needed to rejoin rows the pty hard-wrapped (see unwrap). */
  cols: number
}

const sessions = new Map<string, Session>()
let counter = 0

const MAX_BUFFER = 200_000 // ~200KB of scrollback per terminal
const MAX_AGENT_READ = 8_000 // what a single agent read may return
const MAX_TERMINALS_PER_TASK = 4

const IS_WINDOWS = process.platform === 'win32'

/** The shells we're willing to launch, resolved to real paths. */
function shellTable(): Record<string, { file: string; args: string[] }> {
  if (IS_WINDOWS) {
    const sys = process.env.SystemRoot ?? 'C:\\Windows'
    return {
      cmd: { file: `${sys}\\System32\\cmd.exe`, args: [] },
      powershell: {
        file: `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        args: ['-NoLogo']
      },
      pwsh: { file: 'pwsh.exe', args: ['-NoLogo'] },
      wsl: { file: `${sys}\\System32\\wsl.exe`, args: [] },
      bash: { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
    }
  }
  // macOS/Linux. -l so the user's PATH and aliases are actually present: a GUI
  // app inherits launchd's environment, not the one their shell sets up.
  return {
    zsh: { file: '/bin/zsh', args: ['-l'] },
    bash: { file: '/bin/bash', args: ['-l'] },
    sh: { file: '/bin/sh', args: ['-l'] },
    fish: { file: '/opt/homebrew/bin/fish', args: ['-l'] },
    pwsh: { file: '/usr/local/bin/pwsh', args: ['-NoLogo'] }
  }
}

/** What we open when the user hasn't chosen. */
function defaultShell(): string {
  if (IS_WINDOWS) return 'powershell'
  // $SHELL is the user's real login shell when it's set.
  const fromEnv = (process.env.SHELL ?? '').split('/').pop()
  return fromEnv && fromEnv in shellTable() ? fromEnv : 'zsh'
}

function resolveShell(requested?: string): { file: string; args: string[] } | null {
  const known = shellTable()
  const fallback = defaultShell()
  const pick = known[(requested ?? fallback).toLowerCase()]
  if (!pick) return null
  // Not every shell is installed — fall back rather than throwing at the user.
  if (isAbsolute(pick.file) && !existsSync(pick.file)) {
    return requested === fallback ? null : (known[fallback] ?? null)
  }
  return pick
}

export function listShells(): string[] {
  return Object.keys(shellTable()).filter((s) => resolveShell(s) !== null)
}

export function openTerminal(
  taskId: string,
  shell: string | undefined,
  getWindow: () => BrowserWindow | null
): { id: string } | { error: string } {
  const task = getTask(taskId)
  if (!task) return { error: 'unknown workspace' }

  const mine = [...sessions.values()].filter((s) => s.owner === taskId && !s.exited)
  if (mine.length >= MAX_TERMINALS_PER_TASK) {
    return { error: `at most ${MAX_TERMINALS_PER_TASK} terminals per workspace` }
  }

  const resolved = resolveShell(shell)
  if (!resolved) return { error: `unsupported shell: ${shell}` }

  const id = `term-${++counter}-${Date.now().toString(36)}`
  let pty: IPty
  try {
    pty = ptySpawn(resolved.file, resolved.args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      // The workspace folder — same cwd the agent's CLI gets (invariant 1).
      cwd: task.folderPath,
      env: process.env as Record<string, string>
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  const session: Session = { id, owner: taskId, pty, buffer: '', exited: false, cols: 80 }
  sessions.set(id, session)

  pty.onData((data) => {
    session.buffer = (session.buffer + data).slice(-MAX_BUFFER)
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.TERMINAL_DATA, id, data)
  })

  pty.onExit(({ exitCode }) => {
    session.exited = true
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.TERMINAL_EXIT, id, exitCode)
    // Keep the buffer briefly so a last read still works, then drop it.
    setTimeout(() => sessions.delete(id), 30_000)
  })

  return { id }
}

/**
 * USER KEYSTROKES ONLY. Called from exactly one place: the IPC handler behind
 * the focused xterm view. Never call this from a service, action, or flow —
 * doing so would hand an agent a shell.
 */
export function writeFromUser(id: string, data: string): void {
  const s = sessions.get(id)
  if (!s || s.exited) return
  s.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s || s.exited) return
  try {
    const width = Math.max(2, Math.floor(cols))
    s.pty.resize(width, Math.max(1, Math.floor(rows)))
    s.cols = width
  } catch {
    // the pty can exit between the check and the resize
  }
}

export function closeTerminal(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.pty.kill()
  } catch {
    // already gone
  }
  sessions.delete(id)
}

export function closeTerminalsForTask(taskId: string): void {
  for (const s of [...sessions.values()]) if (s.owner === taskId) closeTerminal(s.id)
}

export function shutdownTerminals(): void {
  for (const s of [...sessions.values()]) closeTerminal(s.id)
}

/** Scrollback for the RENDERER (unfiltered — it's the user's own screen). */
export function replayBuffer(id: string): string {
  return sessions.get(id)?.buffer ?? ''
}

export function terminalsForTask(taskId: string): { id: string; exited: boolean }[] {
  return [...sessions.values()]
    .filter((s) => s.owner === taskId)
    .map((s) => ({ id: s.id, exited: s.exited }))
}

// --- agent-facing read -----------------------------------------------------

/** Terminal control sequences make the text useless to a model — strip them. */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC (window titles)
    .replace(/\u001b[[\]][0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/**
 * The ONLY way any agent sees a terminal. Every gate is checked here, in main,
 * from database state the model cannot influence.
 */
/**
 * Rejoin rows a terminal hard-wrapped. A row of exactly the terminal width
 * was almost certainly continued on the next one — there is no marker for it,
 * width is the only signal a pty leaves behind.
 *
 * Being wrong here is safe in the direction that matters: joining two lines
 * that were genuinely separate can only cause MORE redaction, never less.
 */
function unwrap(lines: string[], cols: number): string[] {
  if (!Number.isFinite(cols) || cols < 20) return lines
  const out: string[] = []
  for (const line of lines) {
    const previous = out[out.length - 1]
    if (previous !== undefined && previous.length >= cols) out[out.length - 1] = previous + line
    else out.push(line)
  }
  return out
}

export function readForAgent(taskId: string, terminalId?: string): string {
  const task = getTask(taskId)
  if (!task) return 'BLOCKED: unknown workspace.'
  if (task.aiDisabled) return 'BLOCKED: this is a private workspace.'
  if (!task.terminalAiRead) {
    return 'BLOCKED: reading this workspace\'s terminal is turned off. The user can enable it in the workspace ⋯ menu → "Let AI read terminal". You can never type into a terminal.'
  }

  const mine = [...sessions.values()].filter((s) => s.owner === taskId)
  if (mine.length === 0) return 'No terminal is open in this workspace.'

  const target = terminalId ? mine.find((s) => s.id === terminalId) : mine[mine.length - 1]
  if (!target) return 'BLOCKED: no terminal with that id in this workspace.'

  const text = stripAnsi(target.buffer).slice(-MAX_AGENT_READ)
  // A shell echoes tokens, keys and env dumps — same protected-topic wall as
  // mail. UNWRAP FIRST: a terminal hard-wraps at its column width, so a long
  // sensitive line arrives split across rows. Filtering the rows directly
  // removed the row holding the word "password" and happily returned the next
  // row holding the actual secret — found by pointing the smoke at a shell
  // that wraps. Rejoining continuations makes the filter see whole lines.
  const { kept, removed } = filterSensitiveLines(unwrap(text.split('\n'), target.cols))
  const body = kept.join('\n').trim()
  const note = removed > 0 ? `\n\n_(${removed} line(s) hidden — protected topics)_` : ''
  return body.length > 0
    ? `Terminal ${target.id}${target.exited ? ' (exited)' : ''} — last ${kept.length} lines:\n\n${body}${note}`
    : `Terminal ${target.id} has produced no readable output yet.${note}`
}
