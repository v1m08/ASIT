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
}

const sessions = new Map<string, Session>()
let counter = 0

const MAX_BUFFER = 200_000 // ~200KB of scrollback per terminal
const MAX_AGENT_READ = 8_000 // what a single agent read may return
const MAX_TERMINALS_PER_TASK = 4

/** Windows shells we're willing to launch, resolved to real paths. */
function resolveShell(requested?: string): { file: string; args: string[] } | null {
  const sys = process.env.SystemRoot ?? 'C:\\Windows'
  const known: Record<string, { file: string; args: string[] }> = {
    cmd: { file: `${sys}\\System32\\cmd.exe`, args: [] },
    powershell: {
      file: `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoLogo']
    },
    pwsh: { file: 'pwsh.exe', args: ['-NoLogo'] },
    wsl: { file: `${sys}\\System32\\wsl.exe`, args: [] },
    bash: { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
  }
  const pick = known[(requested ?? 'powershell').toLowerCase()]
  if (!pick) return null
  // pwsh/bash may not be installed — fall back rather than throwing at the user.
  if (pick.file.includes('\\') && !existsSync(pick.file)) {
    return requested === 'powershell' ? null : known.powershell
  }
  return pick
}

export function listShells(): string[] {
  return ['powershell', 'cmd', 'bash', 'wsl', 'pwsh'].filter((s) => resolveShell(s) !== null)
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

  const session: Session = { id, owner: taskId, pty, buffer: '', exited: false }
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
    s.pty.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
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
  // A shell echoes tokens, keys and env dumps — same protected-topic wall as mail.
  const { kept, removed } = filterSensitiveLines(text.split('\n'))
  const body = kept.join('\n').trim()
  const note = removed > 0 ? `\n\n_(${removed} line(s) hidden — protected topics)_` : ''
  return body.length > 0
    ? `Terminal ${target.id}${target.exited ? ' (exited)' : ''} — last ${kept.length} lines:\n\n${body}${note}`
    : `Terminal ${target.id} has produced no readable output yet.${note}`
}
