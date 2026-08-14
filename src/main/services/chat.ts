import type { WebContents } from 'electron'
import { getDb, newId, nowIso } from '../db'
import type { ChatMessage, ChatSession } from '@shared/types'
import { IPC } from '@shared/ipc-contract'
import { appendFileSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { getTask } from './tasks'
import { getSettings } from './settings'
import { paneManager } from './panes'
import { runClaudeStream, type ClaudeStreamHandle } from './claude'
import { logUsage } from './usage'
import { clearActivity, reportActivity } from './activity'
import { bus } from './bus'
import { watchTaskActions } from './actions'

// Rolling cross-chat memory: every completed turn is appended here, and each
// task's CLAUDE.md tells the model to read it — so a brand-new chat knows what
// was already done without the user re-explaining.
function appendWorklog(folderPath: string, userText: string, assistantText: string): void {
  try {
    const dir = join(folderPath, '.asit')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    appendFileSync(
      join(dir, 'worklog.md'),
      `\n## ${stamp} — ${userText.replace(/\s+/g, ' ').slice(0, 120)}\n\n${assistantText.slice(0, 600)}\n`
    )
  } catch (err) {
    console.error('worklog append failed:', err)
  }
}

// Specific, human-readable enumeration of what the agent is doing — shown
// live as a step trail in the chat and on the activity pill hover.
export function toolStatus(name: string, input: Record<string, unknown>): string {
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  const file = path ? basename(path) : ''

  if (name === 'Read') {
    if (file === 'actions-result.md') return 'Checking results of its app actions…'
    if (path.includes('pages')) return `Reading page snapshot: ${file.replace(/^page-\d+-|\.md$/g, '')}…`
    if (file === 'worklog.md') return 'Reviewing what was done in past chats…'
    if (file === 'actions.ndjson') return 'Preparing to send app commands…'
    if (file === 'notes.md') return 'Reading your notes…'
    if (file === 'CLAUDE.md') return 'Reading task overview…'
    return `Reading ${file || 'a file'}…`
  }
  if (name === 'Edit' || name === 'Write') {
    if (file === 'actions.ndjson') return 'Dispatching app commands (clicks/keys/watch)…'
    if (file === 'notes.md') return 'Writing to your notes…'
    return `Editing ${file || 'files'}…`
  }
  if (name === 'Grep' && typeof input.pattern === 'string')
    return `Searching files for "${String(input.pattern).slice(0, 40)}"…`
  if (name === 'Glob') return 'Listing files…'
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string')
    return `Running: ${String(input.command).replace(/\s+/g, ' ').slice(0, 70)}`
  return `Using ${name}…`
}

function rowToSession(row: Record<string, unknown>): ChatSession {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    claudeSessionId: (row.claude_session_id as string) ?? null,
    title: (row.title as string) ?? null,
    createdAt: row.created_at as string,
    lastMessageAt: (row.last_message_at as string) ?? null
  }
}

function rowToMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    chatSessionId: row.chat_session_id as string,
    role: row.role as 'user' | 'assistant',
    content: row.content as string,
    createdAt: row.created_at as string
  }
}

export function listChatSessions(taskId: string): ChatSession[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM chat_sessions WHERE task_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC'
    )
    .all(taskId) as Record<string, unknown>[]
  return rows.map(rowToSession)
}

export function newChatSession(taskId: string): ChatSession {
  const session: ChatSession = {
    id: newId(),
    taskId,
    claudeSessionId: null,
    title: null,
    createdAt: nowIso(),
    lastMessageAt: null
  }
  getDb()
    .prepare(
      'INSERT INTO chat_sessions (id, task_id, claude_session_id, title, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(session.id, session.taskId, null, null, session.createdAt, null)
  return session
}

export function chatHistory(chatSessionId: string): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_messages WHERE chat_session_id = ? ORDER BY created_at ASC')
    .all(chatSessionId) as Record<string, unknown>[]
  return rows.map(rowToMessage)
}

function insertMessage(chatSessionId: string, role: 'user' | 'assistant', content: string): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO chat_messages (id, chat_session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(newId(), chatSessionId, role, content, nowIso())
  db.prepare('UPDATE chat_sessions SET last_message_at = ? WHERE id = ?').run(
    nowIso(),
    chatSessionId
  )
}

// One in-flight turn per chat session.
const running = new Map<string, ClaudeStreamHandle>()

export async function sendChat(
  chatSessionId: string,
  text: string,
  sender: WebContents
): Promise<void> {
  const db = getDb()
  const sessionRow = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(chatSessionId) as
    | Record<string, unknown>
    | undefined
  if (!sessionRow) {
    sender.send(IPC.CHAT_ERROR, { chatSessionId, message: 'Chat session not found.' })
    return
  }
  const session = rowToSession(sessionRow)
  const task = getTask(session.taskId)
  if (!task) {
    sender.send(IPC.CHAT_ERROR, { chatSessionId, message: 'Task not found.' })
    return
  }
  if (task.aiDisabled) {
    sender.send(IPC.CHAT_ERROR, {
      chatSessionId,
      message: 'This task is private — AI is disabled for it.'
    })
    return
  }
  if (running.has(chatSessionId)) {
    sender.send(IPC.CHAT_ERROR, { chatSessionId, message: 'A reply is already in progress.' })
    return
  }
  // Claim the slot BEFORE any await — two rapid sends must not both pass the
  // guard and spawn two competing CLI processes.
  running.set(chatSessionId, { cancel: () => undefined })
  const activityLabel = `${task.coding ? '⌨ ' : ''}${task.title}`
  reportActivity(chatSessionId, {
    kind: 'chat',
    taskId: task.id,
    label: activityLabel,
    detail: 'Thinking…'
  })

  // The folder is the AI context; re-provision if it was deleted externally.
  try {
    mkdirSync(task.folderPath, { recursive: true })
  } catch {
    // spawn will surface a real error
  }

  // A chat turn IS activity on this task's action channel: bump its watcher's
  // LRU recency (and create it if missing) so a long-running background chat
  // can never have its channel evicted mid-turn.
  watchTaskActions(task.id)

  // Snapshot the open web panes (text + interactive element refs) into
  // .asit/pages/ so "this page" always means something to the model.
  try {
    await paneManager.snapshotAll(task.folderPath, task.id)
  } catch (err) {
    console.error('page snapshot failed:', err)
  }

  insertMessage(chatSessionId, 'user', text)
  if (!session.title) {
    db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(
      text.slice(0, 60),
      chatSessionId
    )
  }

  // Coding tasks get the coding agent: Fable 5, command execution, and a
  // longer leash (installs/tests take time). Normal tasks stay read+write
  // scoped to the folder with no command execution.
  const handle = runClaudeStream(
    {
      cwd: task.folderPath,
      prompt: text,
      resumeSessionId: session.claudeSessionId,
      model: task.coding ? getSettings().codingModel : getSettings().chatModel,
      // ALL file access scoped to the task folder (cwd-relative ** patterns,
      // verified: absolute paths outside cwd are denied). Glob stays unscoped
      // (filenames only). Coding mode adds Bash — real command execution, the
      // user's explicit choice when flagging a task as coding.
      allowedTools: task.coding
        ? 'Read(**),Glob,Grep(**),Edit(**),Write(**),Bash'
        : 'Read(**),Glob,Grep(**),Edit(**),Write(**)',
      timeoutMs: task.coding ? 15 * 60 * 1000 : undefined
    },
    {
      onInit: (claudeSessionId) => {
        db.prepare('UPDATE chat_sessions SET claude_session_id = ? WHERE id = ?').run(
          claudeSessionId,
          chatSessionId
        )
      },
      onDelta: (delta) => {
        if (!sender.isDestroyed()) sender.send(IPC.CHAT_STREAM, { chatSessionId, delta })
        reportActivity(chatSessionId, { kind: 'chat', label: activityLabel, detail: 'Writing reply…' })
      },
      onToolUse: (name, input) => {
        const status = toolStatus(name, input)
        reportActivity(chatSessionId, { kind: 'chat', label: activityLabel, detail: status })
        if (!sender.isDestroyed()) sender.send(IPC.CHAT_STATUS, { chatSessionId, status })
      },
      onUsageTick: (outputTokens) => {
        if (!sender.isDestroyed()) sender.send(IPC.CHAT_USAGE, { chatSessionId, outputTokens })
      },
      onResult: ({ text: result, isError, usage }) => {
        running.delete(chatSessionId)
        clearActivity(chatSessionId)
        logUsage(session.taskId, 'chat', usage)
        if (isError) {
          if (!sender.isDestroyed())
            sender.send(IPC.CHAT_ERROR, { chatSessionId, message: result || 'Claude returned an error.' })
          return
        }
        insertMessage(chatSessionId, 'assistant', result)
        appendWorklog(task.folderPath, text, result)
        if (!sender.isDestroyed()) sender.send(IPC.CHAT_DONE, { chatSessionId, text: result, usage })
        bus.emit('chat-done', { taskId: task.id, title: task.title })
      },
      onError: (message) => {
        running.delete(chatSessionId)
        clearActivity(chatSessionId)
        if (!sender.isDestroyed()) sender.send(IPC.CHAT_ERROR, { chatSessionId, message })
      }
    }
  )
  // onError can fire synchronously (CLI missing) and clear the slot — only
  // store the real handle if the turn is still alive. If the user cancelled
  // during the setup phase (placeholder was removed), kill the fresh spawn
  // immediately: Stop must always stop.
  if (running.has(chatSessionId)) running.set(chatSessionId, handle)
  else handle.cancel()
}

export function cancelChat(chatSessionId: string): void {
  const handle = running.get(chatSessionId)
  if (handle) {
    handle.cancel()
    running.delete(chatSessionId)
    clearActivity(chatSessionId)
  }
}

// Which chat sessions are mid-reply (renderer restores busy state on re-entry).
export function runningSessionIds(): string[] {
  return [...running.keys()]
}
