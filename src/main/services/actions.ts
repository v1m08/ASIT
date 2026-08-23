import type { BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc-contract'
import type { UpdateTaskInput } from '@shared/types'
import { getDb, newId, nowIso } from '../db'
import {
  createTask,
  deleteTask,
  getTask,
  jarvisTaskId,
  listTasks,
  refreshClaudeMd,
  resolveWorkspace,
  updateTask
} from './tasks'
import { recipientAllowed, sendAuthorized, sendRefusalReason } from './guardrails'
import {
  addNoteResource,
  addUrlResource,
  listResources,
  removeResource,
  renameResource,
  reorderResources
} from './resources'
import { addTodo, deleteTodo, listTodos, setTodoDone } from './todos'
import { timer } from './timer'
import { paneManager } from './panes'
import { enqueueCustomGeneration, type CustomQuestionParams } from './questions'
import { saveSkill } from './skills'
import { quickFetch } from './quickfetch'
// Read only — `writeFromUser` is deliberately NOT imported here, and must
// never be: actions.ts is the agent's hands.
import { readForAgent } from './terminal'
import { forgetFact, rememberFact } from './memory'
import { addSchedule, listSchedules, removeSchedule } from './scheduler'

// ---------------------------------------------------------------------------
// App-action protocol: the Claude CLI (which only has file tools) controls the
// app by appending one JSON object per line to <task>/.asit/actions.ndjson.
// We watch that file and execute new lines immediately. This is deliberately
// file-based: no MCP server, no sockets, near-zero latency, and it composes
// with the existing Write permission — the simplest thing that works.
// ---------------------------------------------------------------------------

export interface AppAction {
  action: string
  target?: string
  url?: string
  title?: string
  questions?: {
    q: string
    a: string
    source_ref?: string
    choices?: string[]
    correct_index?: number
  }[]
  priority?: number
  due_date?: string
  status?: string
  ref?: string
  value?: string
  sources?: string[]
  answers_source?: string
  mode?: string
  instructions?: string
  count?: number
  name?: string
  content?: string
  key?: string
  skill?: string
  timeout_min?: number
  prompt?: string
  label?: string
  page?: number
  ms?: number
  // Universal-agent (Jarvis) only: act inside a named workspace. Rejected for
  // every other agent — a workspace agent must never cross into another.
  workspace?: string
  query?: string // fetch action: what to grep from the user's logged-in mail
  text?: string
  gone_label?: string
  gone_text?: string
  order?: string[] // reorder_pins: pin titles, in the order the user should see them
}

let getWindow: (() => BrowserWindow | null) | null = null

const MUTATING_ACTIONS = new Set([
  'page_click',
  'page_fill',
  'page_select',
  'page_key',
  'page_type',
  'navigate'
])

export function initActions(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
}

/**
 * Resolve a pin by what a person would call it. Exact title wins, then a
 * substring, then the filename — `open`, `unpin`, `rename_pin` and
 * `reorder_pins` all go through this so "it opened X but couldn't unpin X"
 * can't happen.
 */
function findPin(taskId: string, target?: string): { id: string; title: string } | null {
  const q = (target ?? '').trim().toLowerCase()
  if (!q) return null
  const rows = getDb()
    .prepare('SELECT id, title, file_path AS filePath FROM resources WHERE task_id = ? ORDER BY position')
    .all(taskId) as { id: string; title: string; filePath: string | null }[]
  const base = (r: { filePath: string | null }): string =>
    (r.filePath ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return (
    rows.find((r) => r.title.toLowerCase() === q) ??
    rows.find((r) => base(r) === q) ??
    rows.find((r) => r.title.toLowerCase().includes(q)) ??
    rows.find((r) => base(r).includes(q)) ??
    null
  )
}

function push(payload: Record<string, unknown>): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.APP_EVENT, payload)
}

export function actionsFileFor(taskFolder: string): string {
  return join(taskFolder, '.asit', 'actions.ndjson')
}

// One watcher instance per agent surface. The open workspace gets one that
// re-targets as the user navigates; the universal agent (Jarvis) holds its
// own permanent one. Each carries its own byte offset and feedback batches —
// the state was module-global before, which would have made two watchers
// corrupt each other's offsets.
class ActionsWatcher {
  private watcher: FSWatcher | null = null
  private taskId: string | null = null
  private processedBytes = 0
  private debounceTimer: NodeJS.Timeout | null = null
  // Feedback loop: every processed batch is echoed to .asit/actions-result.md
  // with per-action outcomes so the MODEL can verify what happened. Without
  // this it was acting blind — the single biggest reason agent flows failed.
  private batchCounter = 0
  private recentBatches: string[] = []
  private chain: Promise<void> = Promise.resolve()

  start(taskId: string): void {
    if (this.taskId === taskId && this.watcher) return
    this.stop()

    const task = getTask(taskId)
    if (!task) return
    const dir = join(task.folderPath, '.asit')
    mkdirSync(dir, { recursive: true })
    const file = actionsFileFor(task.folderPath)
    if (!existsSync(file)) {
      try {
        writeFileSync(file, '')
      } catch {
        // best-effort
      }
    }

    // Skip anything already in the file — only NEW commands run.
    this.processedBytes = existsSync(file) ? statSync(file).size : 0
    this.taskId = taskId
    this.batchCounter = 0
    this.recentBatches = []

    this.watcher = watch(dir, (_event, filename) => {
      if (filename !== 'actions.ndjson') return
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      // Serialize batches: processNewLines awaits page settles/snapshots, and
      // a second fs event mid-run must not interleave its actions with ours.
      // Just long enough to coalesce the write events one Write produces.
      // This is dead time on every batch, so it is as short as it can be.
      this.debounceTimer = setTimeout(() => {
        this.chain = this.chain.then(() => this.processNewLines(taskId, file)).catch(() => undefined)
      }, 40)
    })
    // Windows fs.watch emits 'error' (EPERM) if the watched dir is deleted or
    // renamed; without a handler that would crash the main process.
    this.watcher.on('error', () => this.stop())
  }

  current(): string | null {
    return this.taskId
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    this.taskId = null
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
  }

  private async processNewLines(taskId: string, file: string): Promise<void> {
    if (!existsSync(file)) return
    // Offsets are BYTES (statSync.size) — slice the raw buffer, never the
    // decoded string, or any non-ASCII character shifts every later offset.
    const buf = readFileSync(file)
    if (buf.length <= this.processedBytes) {
      this.processedBytes = Math.min(this.processedBytes, buf.length)
      return
    }
    const fresh = buf.subarray(this.processedBytes).toString('utf-8')
    this.processedBytes = buf.length

    const results: { line: string; result: string }[] = []
    let mutated = false
    for (const line of fresh.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const action = JSON.parse(trimmed) as AppAction
        const result = await executeAction(taskId, action) // sequential, ordered
        results.push({ line: trimmed.slice(0, 160), result })
        if (MUTATING_ACTIONS.has(action.action)) mutated = true
      } catch {
        results.push({ line: trimmed.slice(0, 160), result: 'ignored: not valid JSON' })
      }
    }
    if (results.length === 0) return

    // Close the loop: settle, refresh what the model sees, then report.
    const task = getTask(taskId)
    if (mutated) {
      // Let the page react before snapshotting it. Capturing the DOM costs
      // ~2ms, so this pause IS the post-batch cost — keep it to what a page
      // actually needs to run its handlers and repaint.
      await new Promise((r) => setTimeout(r, 250))
      try {
        if (task && !task.aiDisabled) await paneManager.snapshotAll(task.folderPath, taskId)
      } catch {
        // snapshot refresh is best-effort
      }
    }
    this.batchCounter++
    const section = [
      `## Batch ${this.batchCounter} — processed, ${results.length} action(s)${mutated ? ' — page snapshots in .asit/pages/ were REFRESHED after these actions' : ''}`,
      ...results.map((r) => `- \`${r.line}\`\n  → ${r.result}`)
    ].join('\n')
    this.recentBatches = [...this.recentBatches.slice(-9), section]
    if (task) {
      try {
        writeFileSync(
          join(task.folderPath, '.asit', 'actions-result.md'),
          [
            '# Action results (newest batch LAST)',
            'Read this after appending actions. If your newest batch is missing, execution is still running — read again.',
            '',
            ...this.recentBatches
          ].join('\n\n')
        )
      } catch {
        // best-effort
      }
    }
  }
}

// One PERSISTENT watcher per task, never stopped by navigation. Chats keep
// running in main after the user leaves a workspace; with a single re-homing
// watcher (the old design), a background agent's dispatched actions were
// executed by nobody — and worse, silently skipped when the user returned
// (start() fast-forwarded past them). Watchers are only stopped explicitly
// (task deleted / made private) or LRU-evicted well above any real fan-out.
const taskWatchers = new Map<string, ActionsWatcher>()
const MAX_TASK_WATCHERS = 12
const jarvisWatcher = new ActionsWatcher()

export function watchTaskActions(taskId: string): void {
  const existing = taskWatchers.get(taskId)
  if (existing) {
    existing.start(taskId) // no-op if already live; resumes at stored offset
    // TRUE LRU: re-insert so recency — not first-open order — decides
    // eviction. Without this the scratchpad (watched at startup, so always
    // oldest-inserted) was first out the door.
    taskWatchers.delete(taskId)
    taskWatchers.set(taskId, existing)
    return
  }
  if (taskWatchers.size >= MAX_TASK_WATCHERS) {
    const oldest = taskWatchers.keys().next().value
    if (oldest) {
      taskWatchers.get(oldest)?.stop()
      taskWatchers.delete(oldest)
    }
  }
  const w = new ActionsWatcher()
  w.start(taskId)
  taskWatchers.set(taskId, w)
}

export function watchedTaskId_(): string | null {
  // Compat shim for lifecycle call sites: "is this task being watched".
  return null
}

export function isWatchingTask(taskId: string): boolean {
  return taskWatchers.has(taskId)
}

export function stopWatchingTask(taskId: string): void {
  taskWatchers.get(taskId)?.stop()
  taskWatchers.delete(taskId)
}

export function stopWatching(): void {
  for (const w of taskWatchers.values()) w.stop()
  taskWatchers.clear()
}

export function watchJarvisActions(taskId: string): void {
  jarvisWatcher.start(taskId)
}

export async function executeAction(taskId: string, action: AppAction): Promise<string> {
  // `workspace` re-targeting: Jarvis names a workspace and the action executes
  // exactly as if that workspace's own agent issued it — same pane-ownership
  // scope, same folder, no special powers. Every other agent is refused: a
  // workspace agent must never reach into another workspace.
  if (action.workspace !== undefined) {
    // Terminal output is never reachable across workspaces — not even by
    // Jarvis. A shell's scrollback is the most sensitive surface in the app,
    // so it stays readable only by the workspace that owns it, and only when
    // that workspace opted in.
    if (action.action === 'read_terminal')
      return 'read_terminal cannot be re-targeted at another workspace'
    if (taskId !== jarvisTaskId())
      return 'workspace targeting is only available to the universal agent'
    const target = resolveWorkspace(String(action.workspace))
    if (!target) return `no workspace matching "${String(action.workspace).slice(0, 60)}"`
    return executeAction(target.id, { ...action, workspace: undefined })
  }

  const task = getTask(taskId)
  if (!task) return 'task not found'

  switch (action.action) {
    // READ ONLY, and deliberately the only terminal verb that exists. There is
    // no write/run counterpart anywhere in the protocol — an agent cannot type
    // into a shell because no such code path was written. Every gate (opt-in
    // flag, ownership, private workspaces, protected-topic filtering) lives in
    // terminal.readForAgent, in main, on data the model can't influence.
    case 'read_terminal':
      return readForAgent(taskId, action.ref)

    // Cross-workspace memory. Main owns the file, so a workspace agent still
    // cannot write outside its own folder — it asks, and main appends.
    case 'remember': {
      const text = (action.value ?? action.content ?? '').trim()
      if (!text) return 'remember: nothing to remember'
      if (task.aiDisabled) return 'remember: private workspaces do not contribute to shared memory'
      const added = rememberFact(text, task.title)
      if (added) push({ type: 'toast', text: `🧠 Remembered: ${text.slice(0, 60)}` })
      return added
        ? `remembered (every workspace assistant will know this now): "${text.slice(0, 120)}"`
        : 'already remembered — no change'
    }

    case 'forget': {
      const text = (action.value ?? action.content ?? '').trim()
      if (!text) return 'forget: nothing specified'
      return forgetFact(text) ? `forgot: "${text.slice(0, 120)}"` : 'no matching remembered fact'
    }

    // Make a whole new workspace. Without this the agent had to tell the user
    // to go and create one by hand, which is exactly the "I can't do that"
    // dead end that makes it feel weak.
    case 'create_workspace': {
      const title = (action.title ?? action.value ?? '').trim()
      if (!title) return 'create_workspace: needs a title'
      const created = createTask({
        title: title.slice(0, 80),
        description: (action.content ?? '').slice(0, 400),
        priority: typeof action.priority === 'number' ? action.priority : 2,
        dueDate: action.due_date ?? null
      })
      push({ type: 'task-updated' })
      push({ type: 'toast', text: `Created workspace "${created.title}"` })
      return `created workspace "${created.title}" (id ${created.id}). Add resources to it with {"action":"add_url","workspace":"${created.title}",...}`
    }

    // ----- app command surface: the agent can do what the user can do in the
    // UI, so "make me a workspace with a plan and three to-dos" is one prompt.
    // The walls stay: private workspaces are invisible (resolveWorkspace and
    // listTasks-filter both exclude them), the vault/terminal/settings have no
    // verbs, sends stay user-authorized, and NOTHING here can release a
    // lockdown (invariant 3 — start_focus exists, no stop counterpart). -----

    case 'add_todo': {
      const text = (action.value ?? action.content ?? action.title ?? '').trim()
      if (!text) return 'add_todo: needs the to-do text in "value"'
      const made = addTodo({
        text,
        dueDate: action.due_date ?? null,
        priority: typeof action.priority === 'number' ? action.priority : 2,
        taskId: taskId === jarvisTaskId() ? null : taskId
      })
      if (!made) return 'add_todo: empty after trimming'
      push({ type: 'toast', text: `☑ Added to-do: ${text.slice(0, 60)}` })
      return `added to-do "${text.slice(0, 100)}"${made.dueDate ? ` due ${made.dueDate}` : ''}`
    }

    case 'complete_todo':
    case 'delete_todo': {
      const q = (action.target ?? action.value ?? '').trim().toLowerCase()
      if (!q) return `${action.action}: name the to-do (a distinctive part of its text)`
      const open = listTodos(action.action === 'delete_todo')
      const hit =
        open.find((t) => t.text.toLowerCase() === q) ??
        open.find((t) => t.text.toLowerCase().includes(q))
      if (!hit) return `${action.action}: no to-do matching "${q.slice(0, 60)}"`
      if (action.action === 'complete_todo') {
        setTodoDone(hit.id, true)
        push({ type: 'toast', text: `☑ Completed: ${hit.text.slice(0, 60)}` })
        return `completed "${hit.text.slice(0, 100)}"`
      }
      deleteTodo(hit.id)
      push({ type: 'toast', text: `☑ Deleted to-do: ${hit.text.slice(0, 60)}` })
      return `deleted to-do "${hit.text.slice(0, 100)}"`
    }

    case 'list_todos': {
      const todos = listTodos()
      if (todos.length === 0) return 'no open to-dos'
      return todos
        .slice(0, 40)
        .map((t) => `- ${t.text}${t.dueDate ? ` (due ${t.dueDate})` : ''}`)
        .join('\n')
    }

    // A named note file in this workspace, optionally with starting content.
    // The agent could already Write files; this one also pins it to the rail
    // and refreshes context, so the note is visible and citable immediately.
    case 'add_note': {
      const title = (action.title ?? action.target ?? '').trim()
      if (!title) return 'add_note: needs a title'
      const resource = addNoteResource(taskId, task.folderPath, title.slice(0, 80))
      const content = (action.content ?? '').trim()
      if (content && resource.filePath) {
        writeFileSync(resource.filePath, `# ${title}\n\n${content}\n`)
      }
      refreshClaudeMd(taskId)
      push({ type: 'resources-changed' })
      push({ type: 'toast', text: `✎ Claude added note: ${title.slice(0, 50)}` })
      return `note "${title}" created${content ? ' with content' : ''} — it's pinned to the rail`
    }

    // Private workspaces are structurally absent from this list — same rule
    // as every other surface.
    case 'list_workspaces': {
      const all = listTasks().filter((t) => !t.aiDisabled)
      if (all.length === 0) return 'no workspaces yet — create one with create_workspace'
      return all
        .map(
          (t) =>
            `- ${t.title} (${t.status}${t.dueDate ? `, due ${t.dueDate}` : ''}, priority ${t.priority})`
        )
        .join('\n')
    }

    // Bring a workspace on screen. Universal-agent only: cross-workspace
    // navigation is Jarvis's job, a workspace agent has no business stealing
    // the screen.
    case 'open_workspace': {
      if (taskId !== jarvisTaskId()) return 'open_workspace is only available to the universal agent'
      const target = resolveWorkspace(String(action.target ?? action.value ?? ''))
      if (!target) return `no workspace matching "${String(action.target ?? '').slice(0, 60)}"`
      push({ type: 'open-workspace', taskId: target.id })
      return `opened workspace "${target.title}"`
    }

    // Jarvis-only, and REVERSIBLE by construction: deleteTask moves the folder
    // to Documents\ASIT\.trash (invariant 5), never erases. Loud toast so a
    // deletion can't happen quietly.
    case 'delete_workspace': {
      if (taskId !== jarvisTaskId())
        return 'delete_workspace is only available to the universal agent'
      const target = resolveWorkspace(String(action.target ?? action.value ?? ''))
      if (!target) return `no workspace matching "${String(action.target ?? '').slice(0, 60)}"`
      const res = deleteTask(target.id)
      if (!res.ok) return `could not delete "${target.title}": ${res.reason}`
      push({ type: 'task-updated' })
      push({ type: 'toast', text: `🗑 Agent deleted workspace "${target.title}" — files are in trash` })
      return `deleted workspace "${target.title}" (its files moved to trash and can be restored)`
    }

    // Start a focus session. There is DELIBERATELY no stop/release verb: the
    // lockdown's escape friction is validated in main from user input only
    // (invariant 3), and an agent must never be able to end a session.
    case 'start_focus': {
      const mode = action.mode === 'pomodoro' ? 'pomodoro' : 'stopwatch'
      const st = timer.start(taskId, mode)
      if (st.taskId !== taskId || st.phase === 'idle') {
        return 'a session is already running — finish it first (the agent cannot stop sessions)'
      }
      push({ type: 'open-workspace', taskId })
      push({ type: 'toast', text: `▶ Focus started (${mode})` })
      return `focus session started (${mode}). It ends only when the user releases it.`
    }

    // Explicit web search. `fetch` reads the user's own mail; this reads the
    // open web, agentlessly, and returns extracted lines.
    case 'search': {
      const q = (action.query ?? action.value ?? '').trim()
      if (!q) return 'search: needs a query'
      const found = await quickFetch(`g ${q}`)
      if (found.error) return `search failed: ${found.error}`
      const body = found.lines.slice(0, 20).join(String.fromCharCode(10))
      return body
        ? `search results for "${q}":` + String.fromCharCode(10) + body
        : `search for "${q}" returned nothing useful — try navigating to a site instead`
    }

    // Time-based automation. This is what lets the app act on its own:
    // "every weekday at 8, tell me what's due".
    case 'schedule': {
      const prompt = (action.prompt ?? action.value ?? action.content ?? '').trim()
      const when = (action.target ?? action.query ?? '').trim()
      if (!prompt || !when)
        return 'schedule: needs {"prompt":"what to do","target":"08:00 | weekdays 7:30 | in 30m | hourly"}'
      // Scoped to THIS workspace unless it is the universal agent, which
      // schedules cross-workspace runs.
      const owner = taskId === jarvisTaskId() ? null : taskId
      const made = addSchedule({ prompt, when, taskId: owner })
      if (!made.ok) return `schedule refused: ${made.reason}`
      push({ type: 'toast', text: `Scheduled: ${prompt.slice(0, 50)}` })
      return `scheduled "${prompt.slice(0, 80)}" — next run ${new Date(made.schedule.nextAt).toLocaleString()} (${made.schedule.repeat}). Sends stay blocked in scheduled runs unless the user asks live.`
    }

    case 'list_schedules': {
      const all = listSchedules()
      if (all.length === 0) return 'nothing scheduled'
      return all
        .map(
          (x) =>
            `${x.id} — "${x.prompt.slice(0, 60)}" ${x.repeat}, next ${new Date(x.nextAt).toLocaleString()}${x.enabled ? '' : ' (paused)'}`
        )
        .join(' | ')
    }

    case 'unschedule': {
      const id = (action.ref ?? action.target ?? '').trim()
      if (!id) return 'unschedule: needs the schedule id (use list_schedules)'
      removeSchedule(id)
      return `removed schedule ${id}`
    }

    case 'open': {
      const target = (action.target ?? '').toLowerCase()
      if (!target) return 'open: no target'
      if (target === 'notes' || target === 'notes.md') {
        push({ type: 'open-resource', id: 'builtin-notes' })
        return 'opened notes'
      }
      const match = findPin(taskId, action.target)
      if (!match) return `open: no resource matching "${action.target}"`
      push({ type: 'open-resource', id: match.id })
      return `opened ${match.title}`
    }

    // Unpin / rename / reorder: the other half of add_url, so the agent can
    // tidy a workspace instead of only ever adding to it. removeResource
    // drops the DB row and leaves every file in the task folder untouched —
    // that is what makes this safe to hand to a model (invariant 5).
    case 'unpin': {
      const match = findPin(taskId, action.target)
      if (!match) return `unpin: no pin matching "${action.target ?? ''}"`
      removeResource(match.id)
      refreshClaudeMd(taskId)
      push({ type: 'resources-changed' })
      push({ type: 'toast', text: `Claude unpinned: ${match.title}` })
      return `unpinned "${match.title}" (the file, if any, is still in the task folder)`
    }

    case 'rename_pin': {
      const match = findPin(taskId, action.target)
      if (!match) return `rename_pin: no pin matching "${action.target ?? ''}"`
      const title = (action.title ?? '').trim()
      if (!title) return 'rename_pin: no new title'
      renameResource(match.id, title)
      refreshClaudeMd(taskId)
      push({ type: 'resources-changed' })
      return `renamed "${match.title}" to "${title}"`
    }

    case 'reorder_pins': {
      const wanted = (action.order ?? []).filter((t) => typeof t === 'string')
      if (wanted.length === 0) return 'reorder_pins: no order given'
      const all = listResources(taskId)
      const ordered: string[] = []
      for (const name of wanted) {
        const hit = findPin(taskId, name)
        if (hit && !ordered.includes(hit.id)) ordered.push(hit.id)
      }
      if (ordered.length === 0) return `reorder_pins: none of those match a pin here`
      // Anything the agent didn't name keeps its relative order, after the
      // named ones — a partial list must never drop pins off the rail.
      for (const r of all) if (!ordered.includes(r.id)) ordered.push(r.id)
      reorderResources(taskId, ordered)
      push({ type: 'resources-changed' })
      return `reordered ${ordered.length} pins`
    }

    case 'add_url': {
      if (!action.url) return 'add_url: no url'
      addUrlResource(taskId, action.title ?? '', action.url)
      refreshClaudeMd(taskId)
      push({ type: 'resources-changed' })
      push({ type: 'toast', text: `Claude added resource: ${action.title ?? action.url}` })
      return 'url added'
    }

    case 'add_questions': {
      const questions = (action.questions ?? []).filter(
        (q) => typeof q.q === 'string' && typeof q.a === 'string'
      )
      if (questions.length === 0) return 'add_questions: none valid'
      const db = getDb()
      const insert = db.prepare(
        `INSERT INTO questions (id, task_id, resource_id, question, answer, source_ref, due_at, created_at, choices, correct_index)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
      )
      db.transaction(() => {
        for (const q of questions) {
          const mcValid =
            Array.isArray(q.choices) &&
            q.choices.length >= 2 &&
            q.choices.every((c) => typeof c === 'string') &&
            Number.isInteger(q.correct_index) &&
            (q.correct_index as number) >= 0 &&
            (q.correct_index as number) < q.choices.length
          insert.run(
            newId(),
            taskId,
            q.q,
            q.a,
            q.source_ref ?? null,
            nowIso(),
            nowIso(),
            mcValid ? JSON.stringify(q.choices) : null,
            mcValid ? q.correct_index : null
          )
        }
      })()
      push({ type: 'toast', text: `Claude added ${questions.length} recall questions` })
      return `${questions.length} questions added`
    }

    case 'set_task': {
      const patch: Record<string, unknown> = {}
      if (typeof action.title === 'string' && action.title.trim())
        patch.title = action.title.trim().slice(0, 120)
      if (action.priority !== undefined) patch.priority = Math.min(3, Math.max(1, action.priority))
      if (action.due_date !== undefined) patch.dueDate = action.due_date
      if (action.status === 'done' || action.status === 'active') patch.status = action.status
      if (Object.keys(patch).length === 0) return 'set_task: nothing to set'
      updateTask(taskId, patch as UpdateTaskInput)
      push({ type: 'task-updated' })
      push({ type: 'toast', text: 'Claude updated task details' })
      return 'task updated'
    }

    case 'save_skill': {
      if (!action.name || !action.content) return 'save_skill: name and content required'
      const result = saveSkill(action.name, action.content)
      if (result.startsWith('skill saved')) {
        push({ type: 'toast', text: `⚡ ${result} — invoke it with ./ in chat` })
      }
      return result
    }

    case 'generate_questions': {
      // Dispatch to the dedicated cross-document pipeline (background job).
      const result = enqueueCustomGeneration(taskId, {
        sources: action.sources ?? [],
        answers_source: action.answers_source,
        mode: action.mode === 'extract' ? 'extract' : 'generate',
        instructions: action.instructions,
        count: action.count
      } as CustomQuestionParams)
      return result
    }

    // --- live web-page interaction ---
    // Targeting is either a snapshot ref (p1e4) or, site-independently and
    // reload-proof, a LABEL matched against aria-label/visible text at
    // execution time. Labels are what make recorded flows replayable.
    case 'page_fill': {
      if (action.label)
        return paneManager.fillByLabel(taskId, action.label, action.value ?? '', action.page)
      if (!action.ref) return 'page_fill: no ref or label'
      return paneManager.interact(taskId, action.ref, 'fill', action.value ?? '')
    }
    case 'page_click': {
      if (action.label) return paneManager.clickByLabel(taskId, action.label, action.page)
      if (!action.ref) return 'page_click: no ref or label'
      return paneManager.interact(taskId, action.ref, 'click')
    }
    case 'page_select': {
      if (!action.ref) return 'page_select: no ref'
      return paneManager.interact(taskId, action.ref, 'select', action.value ?? '')
    }
    case 'page_key': {
      if (!action.key) return 'page_key: no key'
      if (action.ref) return paneManager.sendKey(taskId, action.ref, action.key)
      return paneManager.keyToPage(taskId, action.page, action.key)
    }
    case 'page_type': {
      if (action.value === undefined) return 'page_type: no value'
      if (action.ref) return paneManager.typeText(taskId, action.ref, action.value)
      return paneManager.typeToPage(taskId, action.page, action.value)
    }
    case 'navigate': {
      if (!action.url) return 'navigate: no url'
      // Visibility: agent-driven navigation of a logged-in pane is the classic
      // injection exfil channel — and the smuggled data lives in the PATH/query,
      // not the hostname, so the toast must show the whole URL.
      push({ type: 'toast', text: `🤖 Agent opening: ${action.url.slice(0, 160)}` })
      return paneManager.navigateFlow(taskId, action.url, action.page)
    }
    case 'wait': {
      const requested = Math.max(0, Number(action.ms) || 0)
      const ms = Math.min(10000, requested)
      await new Promise((r) => setTimeout(r, ms))
      return requested > ms
        ? `waited ${ms}ms (CAPPED from ${requested}ms — chat waits max out at 10s; for longer waits arm a watch instead)`
        : `waited ${ms}ms`
    }
    case 'page_snapshot': {
      const n = await paneManager.snapshotAll(task.folderPath, taskId)
      return `${n} page snapshots refreshed`
    }
    // Jarvis-only: messaging exfiltration via prompt injection is the risk —
    // agents that read arbitrary web-page snapshots must not be able to send
    // messages, so the verb is refused for workspace agents. Every send also
    // raises a visible toast naming the recipient.
    case 'send_whatsapp': {
      if (taskId !== jarvisTaskId()) return 'send_whatsapp is only available to the universal agent'
      const to = String(action.target ?? action.title ?? '')
      const msg = String(action.value ?? action.content ?? '')
      if (!to || !msg) return 'send_whatsapp: need target (recipient) and value (message)'
      // Deny-by-default: only the USER's own words (parsed in main) open the
      // gate, and only for this turn.
      if (!sendAuthorized('whatsapp')) {
        push({ type: 'toast', text: `🛑 Blocked an unrequested message to "${to.slice(0, 40)}"` })
        return sendRefusalReason('whatsapp')
      }
      const allow = recipientAllowed(to)
      if (!allow.ok) {
        push({ type: 'toast', text: `🛑 ${allow.reason}` })
        return allow.reason!
      }
      const { sendWhatsApp } = await import('./whatsapp')
      const res = await sendWhatsApp(to, msg)
      push({ type: 'toast', text: res.ok ? `📨 WhatsApp ${res.detail}` : `📨 WhatsApp send failed: ${res.detail}` })
      return res.ok ? res.detail : `FAILED: ${res.detail}`
    }
    // Agentless read of the user's OWN logged-in sources (Gmail etc.) — the
    // same hidden-window grep the ⚡ bar uses. This is how Jarvis reads email
    // WITHOUT an OAuth flow (it acts as an ASIT agent, not raw Claude). The
    // result lands in actions-result.md for the model to read back.
    case 'fetch': {
      const q = String(action.query ?? action.value ?? '').trim()
      if (!q) return 'fetch: no query (e.g. {"action":"fetch","query":"flight confirmation Atlanta"})'
      const { quickFetch } = await import('./quickfetch')
      const res = await quickFetch(q)
      if (res.otp) return `fetched OTP: ${res.otp} (${res.source})`
      if (res.error) return `fetch found nothing: ${res.error}`
      if (res.lines.length === 0) return `fetch: no matches in ${res.source || 'sources'}`
      return `fetched from ${res.source}:\n${res.lines.map((l) => `  ${l}`).join('\n')}`
    }
    case 'watch': {
      const { startWatch } = await import('./watchers')
      return startWatch(taskId, {
        label: action.label,
        text: action.text,
        gone_label: action.gone_label,
        gone_text: action.gone_text,
        page: action.page,
        prompt: action.prompt,
        skill: action.skill,
        timeout_min: action.timeout_min
      })
    }

    default:
      return `unknown action "${action.action}"`
  }
}

// Out-of-band events (watch fired/expired) also land in the results file so
// the next agent turn sees what happened while nothing was running.
export function appendResultNote(taskId: string, note: string): void {
  const task = getTask(taskId)
  if (!task) return
  try {
    const file = join(task.folderPath, '.asit', 'actions-result.md')
    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '# Action results\n'
    writeFileSync(file, `${existing}\n\n## Event\n- ${note}\n`.slice(-16000))
  } catch {
    // best-effort
  }
}

// Deterministic skill replay: run a recorded action sequence back-to-back —
// no model, no tokens, milliseconds per step (plus explicit waits). Snapshots
// refresh at the end so a follow-up model turn sees the outcome.
// Verbs a replayed skill flow may NOT contain. A skill runs with no model in
// the loop, so there is no live user intent behind its steps — anything that
// messages a person or crosses into another workspace is refused even if a
// poisoned flow encodes it. (Navigation/clicks stay allowed: that's what
// automation flows are for, and each navigate is toasted.)
// delete_workspace and start_focus join the list: a replayed flow could
// otherwise silently trash a workspace or trap the user in a locked session.
const FLOW_FORBIDDEN = new Set([
  'send_whatsapp',
  'read_terminal',
  'delete_workspace',
  'start_focus'
])

export async function runFlow(taskId: string, steps: AppAction[]): Promise<string[]> {
  const log: string[] = []
  for (const step of steps.slice(0, 60)) {
    try {
      if (FLOW_FORBIDDEN.has(step.action) || step.workspace !== undefined) {
        log.push(`step refused: "${step.action}" is not allowed inside a replayed skill flow`)
        continue
      }
      if (step.action === 'wait') {
        // Deterministic flows may legitimately wait long (server boots) —
        // higher cap than chat-dispatched waits.
        const ms = Math.min(120000, Math.max(0, Number(step.ms) || 0))
        await new Promise((r) => setTimeout(r, ms))
        log.push(`waited ${ms}ms`)
        continue
      }
      log.push(await executeAction(taskId, step))
    } catch (err) {
      log.push(`step failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }
  try {
    const task = getTask(taskId)
    if (task && !task.aiDisabled) await paneManager.snapshotAll(task.folderPath, taskId)
  } catch {
    // snapshot refresh is best-effort
  }
  return log
}
