import type { WebContents } from 'electron'
import { getDb, newId, nowIso } from '../db'
import type { ChatMessage, ChatSession } from '@shared/types'
import { IPC } from '@shared/ipc-contract'
import { appendFileSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { getTask, refreshClaudeMd } from './tasks'
import { getSettings } from './settings'
import { paneManager } from './panes'
import { runClaudeStream, type ClaudeStreamHandle } from './claude'
import { logUsage } from './usage'
import { clearActivity, reportActivity } from './activity'
import { bus } from './bus'
import { watchTaskActions } from './actions'
import { authorizeSendsFromUserMessage } from './guardrails'

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
// The agent's real work is the ACTIONS it dispatches — "Editing actions.ndjson"
// told the user nothing. Parse what it just wrote and say it in plain words.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

function describeAction(a: Record<string, unknown>): string | null {
  const s = (v: unknown, n = 40): string => String(v ?? '').replace(/\s+/g, ' ').slice(0, n)
  const where = a.workspace ? ` in ${s(a.workspace, 24)}` : ''
  switch (a.action) {
    case 'send_whatsapp':
      return `📨 Sending WhatsApp to ${s(a.target ?? a.title, 30)}`
    case 'fetch':
      return `📧 Searching your email for "${s(a.query ?? a.value, 40)}"`
    case 'add_url':
      return `🔗 Saving "${s(a.title, 30)}"${where}`
    case 'open':
      return `📂 Opening ${s(a.target, 30)}${where}`
    case 'add_questions':
      return `🧠 Adding ${Array.isArray(a.questions) ? a.questions.length : ''} questions${where}`
    case 'generate_questions':
      return `🧠 Generating questions from ${s(Array.isArray(a.sources) ? a.sources[0] : '', 30)}`
    case 'set_task':
      return `✏️ Updating workspace details${where}`
    case 'save_skill':
      return `⚡ Saving skill "${s(a.name, 30)}"`
    case 'watch':
      return `👁 Watching for ${s(a.label ?? a.text ?? a.gone_label ?? a.gone_text, 40)}`
    case 'navigate':
      return `🌐 Opening ${hostOf(String(a.url ?? ''))}${where}`
    case 'page_click':
      return `🖱 Clicking "${s(a.label ?? a.ref, 30)}"${where}`
    case 'page_fill':
      return `⌨ Filling "${s(a.label ?? a.ref, 24)}"${where}`
    case 'page_select':
      return `🔽 Choosing "${s(a.value, 24)}"${where}`
    case 'page_key':
      return `⌨ Pressing ${s(a.key, 20)}${where}`
    case 'page_type':
      return `⌨ Typing into the page${where}`
    case 'page_snapshot':
      return '📸 Re-reading the page'
    case 'wait':
      return `⏳ Waiting ${Math.round(Number(a.ms ?? 0) / 100) / 10}s`
    default:
      return null
  }
}

function describeDispatch(text: string): string | null {
  const described: string[] = []
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const d = describeAction(JSON.parse(t) as Record<string, unknown>)
      if (d) described.push(d)
    } catch {
      // partial/!JSON line — ignore
    }
  }
  if (described.length === 0) return null
  const last = described[described.length - 1]
  return described.length > 1 ? `${last}  (+${described.length - 1} more)` : last
}

export function toolStatus(name: string, input: Record<string, unknown>): string {
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  const file = path ? basename(path) : ''

  // Dispatching app actions: name the actual action, not the file write.
  if ((name === 'Edit' || name === 'Write') && file === 'actions.ndjson') {
    const payload =
      typeof input.new_string === 'string'
        ? input.new_string
        : typeof input.content === 'string'
          ? input.content
          : ''
    const described = describeDispatch(payload)
    if (described) return described
  }

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
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    const cmd = String(input.command).replace(/\s+/g, ' ').trim()
    const nap = cmd.match(/^(?:start-)?sleep\s+(?:-seconds\s+)?([\d.]+)/i)
    if (nap) return `⏳ Waiting ${nap[1]}s`
    return `Running: ${cmd.slice(0, 70)}`
  }
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

// Live per-workspace turn state, so the phone (or any other surface) can
// watch and steer a workspace chat instead of only the desktop panel.
export interface ChatLive {
  chatSessionId: string
  taskId: string
  prompt: string
  reply: string
  status: string | null
  running: boolean
  error: string | null
  startedAt: number
}
const liveChats = new Map<string, ChatLive>() // keyed by taskId

export function chatLive(taskId: string): ChatLive | null {
  return liveChats.get(taskId) ?? null
}

let chatNotifyAt = 0
function publishChat(force = false): void {
  const now = Date.now()
  if (!force && now - chatNotifyAt < 400) return
  chatNotifyAt = now
  bus.emit('changed', 'chat')
}

export async function sendChat(
  chatSessionId: string,
  text: string,
  sender: WebContents | null
): Promise<void> {
  // One emit point: a headless caller (the phone) passes null and only the
  // live-state mirror is updated.
  const emit = (channel: string, payload: unknown): void => {
    if (sender && !sender.isDestroyed()) sender.send(channel, payload)
  }
  const db = getDb()
  const sessionRow = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(chatSessionId) as
    | Record<string, unknown>
    | undefined
  if (!sessionRow) {
    emit(IPC.CHAT_ERROR, { chatSessionId, message: 'Chat session not found.' })
    return
  }
  const session = rowToSession(sessionRow)
  const task = getTask(session.taskId)
  if (!task) {
    emit(IPC.CHAT_ERROR, { chatSessionId, message: 'Task not found.' })
    return
  }
  if (task.aiDisabled) {
    emit(IPC.CHAT_ERROR, {
      chatSessionId,
      message: 'This task is private — AI is disabled for it.'
    })
    return
  }
  if (running.has(chatSessionId)) {
    emit(IPC.CHAT_ERROR, { chatSessionId, message: 'A reply is already in progress.' })
    return
  }
  // Claim the slot BEFORE any await — two rapid sends must not both pass the
  // guard and spawn two competing CLI processes.
  running.set(chatSessionId, { cancel: () => undefined })
  liveChats.set(task.id, {
    chatSessionId,
    taskId: task.id,
    prompt: text,
    reply: '',
    status: null,
    running: true,
    error: null,
    startedAt: Date.now()
  })
  publishChat(true)
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

  // Workspace agents can't send_whatsapp, but they CAN drive a logged-in
  // Gmail pane — same deny-by-default gate, opened only by the user's words.
  authorizeSendsFromUserMessage(text)

  // A chat turn IS activity on this task's action channel: bump its watcher's
  // LRU recency (and create it if missing) so a long-running background chat
  // can never have its channel evicted mid-turn.
  watchTaskActions(task.id)

  // Anti-persistence: CLAUDE.md is APP-GENERATED, but agents hold Write(**) —
  // a prompt-injected turn could plant instructions in it that every future
  // session obeys (stored injection). Regenerating from the database right
  // before each spawn caps any tampering to the single turn that did it.
  try {
    refreshClaudeMd(task.id)
  } catch {
    // regeneration is defense-in-depth, never a blocker
  }

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
        const lv = liveChats.get(task.id)
        if (lv && lv.chatSessionId === chatSessionId) lv.reply += delta
        publishChat()
        emit(IPC.CHAT_STREAM, { chatSessionId, delta })
        reportActivity(chatSessionId, { kind: 'chat', label: activityLabel, detail: 'Writing reply…' })
      },
      onToolUse: (name, input) => {
        const status = toolStatus(name, input)
        reportActivity(chatSessionId, { kind: 'chat', label: activityLabel, detail: status })
        const ls = liveChats.get(task.id)
        if (ls && ls.chatSessionId === chatSessionId) ls.status = status
        publishChat(true)
        emit(IPC.CHAT_STATUS, { chatSessionId, status })
      },
      onUsageTick: (outputTokens) => {
        emit(IPC.CHAT_USAGE, { chatSessionId, outputTokens })
      },
      onResult: ({ text: result, isError, usage }) => {
        running.delete(chatSessionId)
        clearActivity(chatSessionId)
        logUsage(session.taskId, 'chat', usage)
        if (isError) {
          const le = liveChats.get(task.id)
          if (le && le.chatSessionId === chatSessionId) {
            le.running = false
            le.error = result || 'Claude returned an error.'
          }
          publishChat(true)
          emit(IPC.CHAT_ERROR, { chatSessionId, message: result || 'Claude returned an error.' })
          return
        }
        insertMessage(chatSessionId, 'assistant', result)
        appendWorklog(task.folderPath, text, result)
        const ld = liveChats.get(task.id)
        if (ld && ld.chatSessionId === chatSessionId) {
          ld.reply = result || ld.reply
          ld.status = null
          ld.running = false
        }
        publishChat(true)
        emit(IPC.CHAT_DONE, { chatSessionId, text: result, usage })
        bus.emit('chat-done', { taskId: task.id, title: task.title })
      },
      onError: (message) => {
        running.delete(chatSessionId)
        clearActivity(chatSessionId)
        const lx = liveChats.get(task.id)
        if (lx && lx.chatSessionId === chatSessionId) {
          lx.running = false
          lx.error = message
        }
        publishChat(true)
        emit(IPC.CHAT_ERROR, { chatSessionId, message })
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

/**
 * Start a turn in a workspace's own chat with no renderer attached — this is
 * how the phone gets the workspace agent (the thing that can actually drive
 * the app) rather than only the cross-workspace assistant.
 */
export async function startWorkspaceChat(
  taskId: string,
  text: string
): Promise<{ started: boolean; chatSessionId?: string; reason?: string }> {
  const task = getTask(taskId)
  if (!task) return { started: false, reason: 'no such workspace' }
  if (task.aiDisabled) return { started: false, reason: 'this workspace is private — AI is disabled' }
  const existing = listChatSessions(taskId)
  const session = existing[0] ?? newChatSession(taskId)
  if (running.has(session.id)) return { started: false, reason: 'a reply is already in progress' }
  void sendChat(session.id, text, null)
  return { started: true, chatSessionId: session.id }
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
