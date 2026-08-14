import type { BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc-contract'
import type { UpdateTaskInput } from '@shared/types'
import { getDb, newId, nowIso } from '../db'
import { getTask, jarvisTaskId, refreshClaudeMd, resolveWorkspace, updateTask } from './tasks'
import { recipientAllowed, sendAuthorized, sendRefusalReason } from './guardrails'
import { addUrlResource } from './resources'
import { paneManager } from './panes'
import { enqueueCustomGeneration, type CustomQuestionParams } from './questions'
import { saveSkill } from './skills'

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
      this.debounceTimer = setTimeout(() => {
        this.chain = this.chain.then(() => this.processNewLines(taskId, file)).catch(() => undefined)
      }, 120)
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
      await new Promise((r) => setTimeout(r, 450)) // let the page react
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
    if (taskId !== jarvisTaskId())
      return 'workspace targeting is only available to the universal agent'
    const target = resolveWorkspace(String(action.workspace))
    if (!target) return `no workspace matching "${String(action.workspace).slice(0, 60)}"`
    return executeAction(target.id, { ...action, workspace: undefined })
  }

  const task = getTask(taskId)
  if (!task) return 'task not found'

  switch (action.action) {
    case 'open': {
      const target = (action.target ?? '').toLowerCase()
      if (!target) return 'open: no target'
      if (target === 'notes' || target === 'notes.md') {
        push({ type: 'open-resource', id: 'builtin-notes' })
        return 'opened notes'
      }
      const db = getDb()
      const rows = db
        .prepare('SELECT id, title FROM resources WHERE task_id = ?')
        .all(taskId) as { id: string; title: string }[]
      const match =
        rows.find((r) => r.title.toLowerCase() === target) ??
        rows.find((r) => r.title.toLowerCase().includes(target))
      if (!match) return `open: no resource matching "${action.target}"`
      push({ type: 'open-resource', id: match.id })
      return `opened ${match.title}`
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
const FLOW_FORBIDDEN = new Set(['send_whatsapp'])

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
