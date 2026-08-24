import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSettings } from './settings'

// ---------------------------------------------------------------------------
// Binary resolution. The native installer drops the CLI in ~/.local/bin and it
// is NOT on PATH in non-interactive shells, so we resolve an absolute path
// ourselves. GUI apps on macOS inherit launchd's PATH, not your shell's, so
// `which` misses Homebrew and nvm installs too — hence the explicit list.
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32'

/** Where each platform's installers actually put it. */
function claudeCandidates(): string[] {
  const home = homedir()
  if (IS_WINDOWS) {
    return [
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd')
    ]
  }
  return [
    join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude', // Apple silicon Homebrew
    '/usr/local/bin/claude', // Intel Homebrew, and most installers
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
    '/usr/bin/claude'
  ]
}

let cachedPath: string | null | undefined

export function resolveClaudePath(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const settingsPath = getSettings().claudePath
  for (const c of [settingsPath, ...claudeCandidates()]) {
    if (c && existsSync(c)) {
      cachedPath = c
      return c
    }
  }
  try {
    // Last resort: ask the OS. On macOS a login shell is used so the user's
    // PATH (nvm, asdf, Homebrew) is actually in scope — the app's own PATH
    // usually isn't.
    const out = IS_WINDOWS
      ? execFileSync('where.exe', ['claude'], { encoding: 'utf-8' })
      : execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf-8' })
    const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
    if (first) {
      cachedPath = first.trim()
      return cachedPath
    }
  } catch {
    // not on PATH either
  }
  cachedPath = null
  return null
}

export function invalidateClaudePathCache(): void {
  cachedPath = undefined
}

export class ClaudeNotFoundError extends Error {
  constructor() {
    super(
      "ASIT's AI runs on the free Claude Code app, which isn't installed yet. Click “⚠ AI setup needed” in the top bar (or open Settings → AI engine) to set it up."
    )
  }
}

function isAuthError(text: string): boolean {
  return /invalid api key|please run \/login|not logged in|authentication|oauth token/i.test(text)
}

const AUTH_HINT =
  'Claude Code is installed but not signed in yet. Open the Claude Code app once, sign in when it asks, then try again here.'

// ---------------------------------------------------------------------------
// NDJSON line parser (stdout arrives in arbitrary chunks; buffer partials).
// ---------------------------------------------------------------------------

export function createLineBuffer(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string): void => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) onLine(line)
    }
  }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

// Every live CLI child, so app quit can reap them — on Windows children
// outlive the parent, and an orphaned generation job would keep burning
// tokens after the app closes.
const activeChildren = new Set<ChildProcess>()

export function killAllClaudeChildren(): void {
  for (const child of [...activeChildren]) killTree(child)
  activeChildren.clear()
}

function spawnClaude(args: string[], cwd: string, prompt: string): ChildProcess {
  const exe = resolveClaudePath()
  if (!exe) throw new ClaudeNotFoundError()
  const useShell = exe.toLowerCase().endsWith('.cmd')
  const child = spawn(exe, args, {
    cwd,
    windowsHide: true,
    shell: useShell,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  activeChildren.add(child)
  child.once('close', () => activeChildren.delete(child))
  // Prompt goes through stdin: no Windows arg-quoting pain, no length limits.
  // A broken/locked exe can fail AFTER spawn returns; the buffered write then
  // EPIPEs on a stream with no error listener — an uncaught crash of main.
  child.stdin!.on('error', () => undefined)
  child.stdin!.write(prompt)
  child.stdin!.end()
  return child
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return
  try {
    if (process.platform === 'win32') {
      // The CLI spawns helpers; taskkill /T takes the whole tree down.
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      // Unix: the child was spawned into its own process group, so a negative
      // pid signals the group. Killing only the leader would orphan its
      // helpers, which is exactly what taskkill /T avoids on Windows.
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    child.kill()
  }
}

export interface ClaudeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  model: string | null
}

function parseUsage(evt: Record<string, unknown>): ClaudeUsage {
  const usage = (evt.usage ?? {}) as Record<string, unknown>
  const models = Object.keys((evt.modelUsage ?? {}) as Record<string, unknown>)
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
    cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
    costUsd: Number(evt.total_cost_usd ?? 0),
    model: models.length > 0 ? models.join('+') : null
  }
}

export interface StreamHandlers {
  onInit?: (claudeSessionId: string) => void
  onDelta?: (text: string) => void
  onToolUse?: (name: string, input: Record<string, unknown>) => void
  onUsageTick?: (outputTokens: number) => void
  onResult: (result: { text: string; isError: boolean; usage: ClaudeUsage }) => void
  onError: (message: string) => void
}

export interface ClaudeStreamHandle {
  cancel: () => void
}

// IDLE timeout, not a wall-clock one. The old 5-minute total killed turns
// that were still actively streaming — a long agent run (reading PDFs,
// driving pages, generating questions) legitimately exceeds five minutes and
// was being executed mid-thought. What we actually want to catch is a HUNG
// process, so the clock restarts on every byte the CLI produces.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
// Absolute backstop so a process that chatters forever still can't run away.
const MAX_TURN_MS = 60 * 60 * 1000

// Streaming chat turn. Read-only tools, cwd = task folder (context source).
export function runClaudeStream(
  opts: {
    cwd: string
    prompt: string
    resumeSessionId?: string | null
    model?: string
    allowedTools?: string
    timeoutMs?: number
  },
  handlers: StreamHandlers
): ClaudeStreamHandle {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--allowedTools',
    opts.allowedTools ?? 'Read(**),Glob,Grep(**)'
  ]
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model)

  let child: ChildProcess
  try {
    child = spawnClaude(args, opts.cwd, opts.prompt)
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : String(err))
    return { cancel: (): void => undefined }
  }

  let finished = false
  let stderrText = ''
  let sawResult = false

  const idleMs = opts.timeoutMs ?? IDLE_TIMEOUT_MS
  const startedAt = Date.now()
  let timeout: NodeJS.Timeout

  const giveUp = (reason: string): void => {
    if (finished) return
    finished = true
    killTree(child)
    handlers.onError(reason)
  }

  // Restarted by `touch()` on every chunk of CLI output.
  const arm = (): void => {
    timeout = setTimeout(() => {
      giveUp(
        `Claude went quiet for ${Math.round(idleMs / 60000)} minutes with no output, so the turn was stopped. It was probably stuck rather than thinking — try again, or narrow the request.`
      )
    }, idleMs)
  }

  /** Any output means it's alive: reset the idle clock. */
  const touch = (): void => {
    if (finished) return
    clearTimeout(timeout)
    if (Date.now() - startedAt > MAX_TURN_MS) {
      giveUp('Claude ran for over an hour on a single turn and was stopped.')
      return
    }
    arm()
  }
  arm()

  const feed = createLineBuffer((line) => {
    if (finished) return
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line)
    } catch {
      return // non-JSON noise on stdout
    }
    const type = evt.type as string

    if (type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
      handlers.onInit?.(evt.session_id)
    } else if (type === 'stream_event' && evt.parent_tool_use_id == null) {
      const event = evt.event as {
        type?: string
        delta?: { type?: string; text?: string }
        usage?: { output_tokens?: number }
      }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        handlers.onDelta?.(event.delta.text ?? '')
      } else if (event?.type === 'message_delta' && event.usage?.output_tokens !== undefined) {
        handlers.onUsageTick?.(event.usage.output_tokens)
      }
    } else if (type === 'assistant' && evt.parent_tool_use_id == null) {
      // Full per-turn messages: surface tool calls so the UI can show activity.
      const message = evt.message as {
        content?: { type: string; name?: string; input?: Record<string, unknown> }[]
      }
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use' && block.name) {
          handlers.onToolUse?.(block.name, block.input ?? {})
        }
      }
    } else if (type === 'result') {
      sawResult = true
      finished = true
      clearTimeout(timeout)
      const isError = evt.is_error === true
      const text = typeof evt.result === 'string' ? evt.result : ''
      if (isError && isAuthError(text + stderrText)) {
        handlers.onError(AUTH_HINT)
      } else {
        handlers.onResult({ text, isError, usage: parseUsage(evt) })
      }
    }
  })

  child.stdout!.setEncoding('utf-8')
  child.stdout!.on('data', (chunk: string) => {
    touch() // still producing output → still working
    feed(chunk)
  })
  child.stderr!.setEncoding('utf-8')
  child.stderr!.on('data', (chunk: string) => {
    touch()
    stderrText += chunk
  })

  child.on('error', (err) => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    handlers.onError(`Failed to start Claude CLI: ${err.message}`)
  })

  child.on('close', (code) => {
    clearTimeout(timeout)
    if (finished || sawResult) return
    finished = true
    const detail = stderrText.trim().slice(0, 500)
    if (isAuthError(detail)) handlers.onError(AUTH_HINT)
    else
      handlers.onError(
        `The AI stopped unexpectedly (exit code ${code})${detail ? ` — ${detail}` : ''}. Try again; if it keeps happening, restart ASIT.`
      )
  })

  return {
    cancel: (): void => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      killTree(child)
    }
  }
}

// ---------------------------------------------------------------------------
// One-shot JSON call (question generation, grading). Resolves with the
// `result` text of the final JSON object.
// ---------------------------------------------------------------------------

export function runClaudeOnce(opts: {
  cwd: string
  prompt: string
  allowedTools?: string
  maxTurns?: number
  timeoutMs?: number
}): Promise<{ text: string; claudeSessionId: string | null; usage: ClaudeUsage }> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--max-turns', String(opts.maxTurns ?? 10)]
    if (opts.allowedTools !== undefined) args.push('--allowedTools', opts.allowedTools)

    let child: ChildProcess
    try {
      child = spawnClaude(args, opts.cwd, opts.prompt)
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(
      () => {
        if (!settled) {
          settled = true
          killTree(child)
          reject(new Error('Claude timed out.'))
        }
      },
      opts.timeoutMs ?? 10 * 60 * 1000
    )

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (c: string) => (stdout += c))
    child.stderr!.setEncoding('utf-8')
    child.stderr!.on('data', (c: string) => (stderr += c))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Failed to start Claude CLI: ${err.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>
        const text = typeof parsed.result === 'string' ? parsed.result : ''
        if (parsed.is_error === true) {
          reject(new Error(isAuthError(text + stderr) ? AUTH_HINT : `Claude error: ${text.slice(0, 300)}`))
        } else {
          resolve({
            text,
            claudeSessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
            usage: parseUsage(parsed)
          })
        }
      } catch {
        const detail = (stderr || stdout).trim().slice(0, 500)
        reject(
          new Error(
            isAuthError(detail)
              ? AUTH_HINT
              : `Claude CLI exited (code ${code}) with unparseable output. ${detail}`
          )
        )
      }
    })
  })
}
