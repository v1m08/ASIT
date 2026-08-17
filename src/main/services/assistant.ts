import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { getDb, newId, nowIso } from '../db'
import { tasksRoot, writeTasksIndex } from './tasks'
import { runClaudeStream, type ClaudeStreamHandle } from './claude'
import { logUsage } from './usage'
import { clearActivity, reportActivity } from './activity'

// Global quick assistant: haiku (fastest model), cwd = the tasks ROOT so it
// can read every task's CLAUDE.md / notes / worklog. Read-only. One rolling
// conversation per app run (resume keeps follow-ups snappy and contextual).

let lastSessionId: string | null = null
let running: ClaudeStreamHandle | null = null

export function askAssistant(prompt: string, sender: WebContents): void {
  if (running) {
    sender.send(IPC.ASSISTANT_ERROR, { message: 'Already answering — cancel first.' })
    return
  }
  writeTasksIndex() // make sure the index reflects this second

  // Claim the slot before spawning; onError can fire synchronously and clear it.
  running = { cancel: () => undefined }
  reportActivity('assistant', { kind: 'assistant', label: '⚡ Quick assistant' })
  const handle = runClaudeStream(
    {
      cwd: tasksRoot(),
      prompt,
      resumeSessionId: lastSessionId,
      model: 'haiku',
      allowedTools: 'Read(**),Glob,Grep(**)'
    },
    {
      onInit: (id) => {
        lastSessionId = id
      },
      onDelta: (delta) => {
        if (!sender.isDestroyed()) sender.send(IPC.ASSISTANT_STREAM, { delta })
      },
      onToolUse: (name) => {
        if (!sender.isDestroyed()) sender.send(IPC.ASSISTANT_STATUS, { status: `${name}…` })
      },
      onResult: ({ text, isError, usage }) => {
        running = null
        clearActivity('assistant')
        logUsage(null, 'assistant', usage)
        if (!isError) {
          getDb()
            .prepare('INSERT INTO assistant_log (id, prompt, reply, created_at) VALUES (?, ?, ?, ?)')
            .run(newId(), prompt.slice(0, 2000), text.slice(0, 8000), nowIso())
        }
        if (!sender.isDestroyed()) {
          if (isError) sender.send(IPC.ASSISTANT_ERROR, { message: text || 'Assistant error.' })
          else sender.send(IPC.ASSISTANT_DONE, { text, costUsd: usage.costUsd })
        }
      },
      onError: (message) => {
        running = null
        clearActivity('assistant')
        if (!sender.isDestroyed()) sender.send(IPC.ASSISTANT_ERROR, { message })
      }
    }
  )
  if (running) running = handle
  else handle.cancel() // cancelled during setup — kill the fresh spawn
}

/** One shared conversation log — Jarvis writes here too, so the history the
 *  user browses is every question they've asked, not just the old quick bar's. */
export function logExchange(prompt: string, reply: string): void {
  try {
    getDb()
      .prepare('INSERT INTO assistant_log (id, prompt, reply, created_at) VALUES (?, ?, ?, ?)')
      .run(newId(), prompt.slice(0, 2000), reply.slice(0, 8000), nowIso())
  } catch {
    // history is a convenience; never let it break a turn
  }
}

export function assistantHistory(limit = 30): { id: string; prompt: string; reply: string; createdAt: string }[] {
  const rows = getDb()
    .prepare('SELECT * FROM assistant_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    prompt: r.prompt as string,
    reply: r.reply as string,
    createdAt: r.created_at as string
  }))
}

export function cancelAssistant(): void {
  running?.cancel()
  running = null
  clearActivity('assistant')
}
