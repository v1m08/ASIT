import type { BrowserWindow } from 'electron'
import { getDb, newId, nowIso } from '../db'
import { IPC } from '@shared/ipc-contract'
import type {
  Workflow,
  WorkflowParam,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult
} from '@shared/types'
import {
  FLOW_FORBIDDEN,
  beginUnattended,
  endUnattended,
  executeAction,
  watchTaskActions,
  type AppAction
} from './actions'
import { getOrCreateJarvis, getTask, jarvisTaskId, refreshClaudeMd } from './tasks'
import { extractFlow, listSkills } from './skills'
import { paneManager } from './panes'
import { runClaudeStream } from './claude'
import { clearSendAuthorization, filterSensitiveLines } from './guardrails'
import { getSettings } from './settings'
import { logUsage } from './usage'
import { clearActivity, reportActivity } from './activity'
import { toolStatus } from './chat'
import { bus } from './bus'

// First-class workflows: the executable automation the fenced-skill "flow"
// never grew into. A workflow is a DB entity with params and a step list —
// deterministic action steps (cheap replay), bounded MODEL steps for the
// parts needing judgment, confirm gates that pause for a real click, and
// wait_for/assert conditions over the owner's own panes.
//
// Containment (all enforced HERE and in actions.ts, never by prompt):
//  * Identity comes from the workflow ROW: task_id set → that workspace's
//    agent (cwd, pane ownership, verb set); NULL → the universal agent's
//    identity for its global verbs. The caller can never pick.
//  * FLOW_FORBIDDEN verbs and the `workspace` field are refused at save time
//    AND at run time (a hand-edited row is still refused).
//  * Model steps run unattended: send authority is CLEARED (a workflow prompt
//    is not the user's live words — invariant 19), Bash is never granted even
//    for coding tasks, and beginUnattended() strips the flow-forbidden verbs
//    from the action channel for the duration.
//  * Global workflows may not contain model steps in v1: an unattended
//    universal-agent turn would carry re-targeting surface into a
//    no-user-present context.
//  * NO action verb can approve a confirm gate — approval arrives only via
//    the renderer's WORKFLOWS_CONFIRM (absence doctrine, like session-stop).
//  * Private workspaces can neither own nor run workflows.
//
// Durability: the run row is updated at every step transition, so the history
// survives anything; the in-memory run does not survive an app restart
// (panes don't either — "resuming" step 7 against a blank browser would be
// fake safety). Startup sweeps running → interrupted.

const MAX_STEPS = 100
const MAX_MODEL_STEPS = 10
/** Model turns actually executed in one run (a prompt step inside a loop
 *  runs once per item — 10 written steps must not become 1,000 turns). */
const MAX_MODEL_RUNS = 30
const MAX_DEPTH = 3 // foreach/if nesting
const DEFAULT_MAX_ITEMS = 25
const HARD_MAX_ITEMS = 100
const MAX_RUN_MS = 30 * 60_000
const VAR_NAME = /^[a-z0-9_]{1,40}$/i
const MODEL_STEP_TOOLS = 'Read(**),Glob,Grep(**),Edit(**),Write(**)' // never Bash

let getWindow: (() => BrowserWindow | null) | null = null

export function initWorkflows(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
}

function pushEvent(payload: Record<string, unknown>): void {
  try {
    getWindow?.()?.webContents.send(IPC.WORKFLOWS_EVENT, payload)
  } catch {
    // renderer gone — the DB row still records everything
  }
  bus.emit('changed', 'workflows')
}

// ---------------------------------------------------------------------------
// CRUD + validation

function rowToWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    taskId: (row.task_id as string) ?? null,
    params: JSON.parse((row.params_json as string) || '[]') as WorkflowParam[],
    steps: JSON.parse(row.steps_json as string) as WorkflowStep[],
    source: (row.source as Workflow['source']) ?? 'ui',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function rowToRun(row: Record<string, unknown>): WorkflowRun {
  const wf = getDb()
    .prepare('SELECT name FROM workflows WHERE id = ?')
    .get(row.workflow_id as string) as { name: string } | undefined
  const results = JSON.parse((row.step_results_json as string) || '[]') as WorkflowStepResult[]
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    workflowName: wf?.name ?? '(deleted workflow)',
    taskId: (row.task_id as string) ?? null,
    status: row.status as WorkflowRunStatus,
    trigger: row.trigger as string,
    params: row.params_json ? (JSON.parse(row.params_json as string) as Record<string, string>) : null,
    currentStep: (row.current_step as number) ?? 0,
    totalSteps: results.length, // superseded by live state while running
    stepResults: results,
    costUsd: (row.cost_usd as number) ?? 0,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string) ?? null,
    confirmMessage:
      activeRun && activeRun.runId === (row.id as string) ? activeRun.confirmMessage : null
  }
}

export function listWorkflows(): Workflow[] {
  return (
    getDb().prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as Record<
      string,
      unknown
    >[]
  ).map(rowToWorkflow)
}

export function getWorkflow(idOrName: string): Workflow | null {
  const row = getDb()
    .prepare('SELECT * FROM workflows WHERE id = ? OR name = ?')
    .get(idOrName, idOrName) as Record<string, unknown> | undefined
  return row ? rowToWorkflow(row) : null
}

/** Validate a step list. Returns a human reason, or null when acceptable. */
export function validateWorkflow(input: {
  name: string
  taskId: string | null
  steps: WorkflowStep[]
  params?: WorkflowParam[]
}): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(input.name))
    return 'name must be a slug: lowercase letters, digits, dashes'
  if (!Array.isArray(input.steps) || input.steps.length === 0) return 'a workflow needs steps'
  if (input.taskId) {
    const owner = getTask(input.taskId)
    if (!owner) return 'owning workspace not found'
    if (owner.aiDisabled) return 'private workspaces cannot own workflows'
  }
  const count = { steps: 0, model: 0 }
  const reason = validateSteps(input.steps, input.taskId, count, 1, '')
  if (reason) return reason
  if (count.steps > MAX_STEPS) return `too many steps (max ${MAX_STEPS}, counting nested ones)`
  if (count.model > MAX_MODEL_STEPS) return `too many model steps (max ${MAX_MODEL_STEPS})`
  for (const p of input.params ?? []) {
    if (!VAR_NAME.test(p.name)) return `bad param name "${p.name}"`
  }
  return null
}

/** One block (top level, a loop body, an if branch). Recursive, depth-capped. */
function validateSteps(
  steps: WorkflowStep[],
  taskId: string | null,
  count: { steps: number; model: number },
  depth: number,
  prefix: string
): string | null {
  if (!Array.isArray(steps)) return `${prefix || 'steps'}: must be a list of steps`
  for (const [i, step] of steps.entries()) {
    count.steps++
    const at = `step ${prefix}${i + 1}`
    if (!step || typeof step !== 'object') return `${at}: not a step object`
    if (step.kind === 'action') {
      const a = step.action
      if (!a || typeof a.action !== 'string') return `${at}: action step needs an action object`
      if (FLOW_FORBIDDEN.has(a.action))
        return `${at}: "${a.action}" is not allowed inside a workflow`
      if ('workspace' in a && a.workspace !== undefined)
        return `${at}: workflow steps may not re-target another workspace`
    } else if (step.kind === 'prompt') {
      count.model++
      if (!step.prompt?.trim()) return `${at}: prompt step needs prompt text`
      if (!taskId)
        return `${at}: global workflows cannot contain model steps — attach the workflow to a workspace`
      if (step.into !== undefined && !VAR_NAME.test(step.into)) return `${at}: bad variable name "${step.into}"`
    } else if (step.kind === 'confirm') {
      if (!step.message?.trim()) return `${at}: confirm step needs a message`
    } else if (step.kind === 'wait_for') {
      if (!step.label && !step.text && !step.gone_label && !step.gone_text)
        return `${at}: wait_for needs label, text, gone_label or gone_text`
    } else if (step.kind === 'assert') {
      if (!step.label && !step.text) return `${at}: assert needs label or text`
    } else if (step.kind === 'fill_form') {
      if (!step.fields || typeof step.fields !== 'object' || Array.isArray(step.fields))
        return `${at}: fill_form needs a fields object ({"Label": "value"})`
      const n = Object.keys(step.fields).length
      if (n === 0 || n > 60) return `${at}: fill_form needs 1–60 fields`
      if (Object.values(step.fields).some((v) => typeof v !== 'string'))
        return `${at}: fill_form values must be text`
    } else if (step.kind === 'extract') {
      if (!VAR_NAME.test(step.into ?? '')) return `${at}: extract needs a variable name in "into"`
      if (!step.label && !step.selector && !step.pattern && !step.from)
        return `${at}: extract needs label, selector, pattern or from`
      if (step.from && step.from !== 'url' && step.from !== 'title') return `${at}: from must be url or title`
      if (step.pattern) {
        try {
          new RegExp(step.pattern)
        } catch {
          return `${at}: pattern is not a valid regular expression`
        }
      }
    } else if (step.kind === 'set') {
      if (!VAR_NAME.test(step.name ?? '')) return `${at}: set needs a variable name`
      if (typeof step.value !== 'string') return `${at}: set needs a text value`
    } else if (step.kind === 'foreach') {
      if (depth >= MAX_DEPTH) return `${at}: loops/branches nest at most ${MAX_DEPTH - 1} deep`
      if (typeof step.items !== 'string' || !step.items.trim()) return `${at}: foreach needs items`
      if (!VAR_NAME.test(step.as ?? '')) return `${at}: foreach needs a variable name in "as"`
      if (!Array.isArray(step.steps) || step.steps.length === 0) return `${at}: foreach needs steps`
      const r = validateSteps(step.steps, taskId, count, depth + 1, `${prefix}${i + 1}.`)
      if (r) return r
    } else if (step.kind === 'if') {
      if (depth >= MAX_DEPTH) return `${at}: loops/branches nest at most ${MAX_DEPTH - 1} deep`
      if (!step.label && !step.text && !step.url_contains && !step.var)
        return `${at}: if needs label, text, url_contains or var`
      if (step.var !== undefined && !VAR_NAME.test(step.var)) return `${at}: bad variable name "${step.var}"`
      if (!Array.isArray(step.then)) return `${at}: if needs a "then" list`
      const r =
        validateSteps(step.then, taskId, count, depth + 1, `${prefix}${i + 1}.then.`) ??
        (step.else ? validateSteps(step.else, taskId, count, depth + 1, `${prefix}${i + 1}.else.`) : null)
      if (r) return r
    } else {
      return `${at}: unknown step kind "${(step as { kind?: string }).kind}"`
    }
  }
  return null
}

export function saveWorkflow(input: {
  name: string
  description?: string
  taskId?: string | null
  params?: WorkflowParam[]
  steps: WorkflowStep[]
  source?: Workflow['source']
}): { ok: true; workflow: Workflow; overwrote: boolean } | { ok: false; reason: string } {
  const taskId = input.taskId ?? null
  const reason = validateWorkflow({ name: input.name, taskId, steps: input.steps, params: input.params })
  if (reason) return { ok: false, reason }
  const db = getDb()
  const existing = db.prepare('SELECT id FROM workflows WHERE name = ?').get(input.name) as
    | { id: string }
    | undefined
  const now = nowIso()
  if (existing) {
    db.prepare(
      'UPDATE workflows SET description = ?, task_id = ?, params_json = ?, steps_json = ?, source = ?, updated_at = ? WHERE id = ?'
    ).run(
      (input.description ?? '').slice(0, 400),
      taskId,
      JSON.stringify(input.params ?? []),
      JSON.stringify(input.steps),
      input.source ?? 'ui',
      now,
      existing.id
    )
  } else {
    db.prepare(
      'INSERT INTO workflows (id, name, description, task_id, params_json, steps_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      newId(),
      input.name,
      (input.description ?? '').slice(0, 400),
      taskId,
      JSON.stringify(input.params ?? []),
      JSON.stringify(input.steps),
      input.source ?? 'ui',
      now,
      now
    )
  }
  bus.emit('changed', 'workflows')
  return { ok: true, workflow: getWorkflow(input.name)!, overwrote: !!existing }
}

export function deleteWorkflow(id: string): void {
  getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id)
  bus.emit('changed', 'workflows')
}

/** The save_workflow action verb — "save this as a workflow" from chat. */
export function saveWorkflowFromAgent(taskId: string, action: Record<string, unknown>): string {
  const name = String(action.name ?? '').trim()
  let steps: WorkflowStep[]
  try {
    steps =
      typeof action.steps === 'string'
        ? (JSON.parse(action.steps) as WorkflowStep[])
        : (action.steps as WorkflowStep[])
  } catch {
    return 'save_workflow: steps must be a JSON array of step objects'
  }
  const isJarvis = taskId === jarvisTaskId()
  const res = saveWorkflow({
    name,
    description: String(action.description ?? action.content ?? ''),
    // A workspace agent's workflow belongs to ITS workspace; Jarvis saves
    // global ones. Never caller-picked beyond that.
    taskId: isJarvis ? null : taskId,
    params: Array.isArray(action.params) ? (action.params as WorkflowParam[]) : [],
    steps,
    source: 'chat'
  })
  if (!res.ok) return `save_workflow refused: ${res.reason}`
  if (res.overwrote) {
    // Loud: quietly replacing an automation is how persistent injection hides.
    pushEvent({ type: 'workflow-overwritten', name })
  }
  return `${res.overwrote ? 'OVERWROTE existing' : 'saved'} workflow "${name}" (${steps.length} steps). The user can run it from Automations or ./${name} in chat.`
}

// ---------------------------------------------------------------------------
// Runner

interface ActiveRun {
  runId: string
  workflowId: string
  taskId: string | null
  cancelled: boolean
  confirmMessage: string | null
  resolveConfirm: ((approved: boolean) => void) | null
  cancelModelStep: (() => void) | null
  /** Model turns spent so far (see MAX_MODEL_RUNS). */
  modelRuns: number
}

let activeRun: ActiveRun | null = null

export function activeRunState(): WorkflowRun | null {
  if (!activeRun) return null
  return getRun(activeRun.runId)
}

export function getRun(runId: string): WorkflowRun | null {
  const row = getDb().prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined
  return row ? rowToRun(row) : null
}

export function listRuns(limit = 50): WorkflowRun[] {
  return (
    getDb()
      .prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
  ).map(rowToRun)
}

/** App start: anything still "running" died with the previous process. */
export function sweepInterruptedRuns(): number {
  const r = getDb()
    .prepare(
      "UPDATE workflow_runs SET status = 'interrupted', finished_at = ? WHERE status IN ('running','waiting_confirm')"
    )
    .run(nowIso())
  return r.changes
}

export function confirmRun(runId: string, approved: boolean): string {
  if (!activeRun || activeRun.runId !== runId || !activeRun.resolveConfirm)
    return 'no run is waiting for confirmation'
  const resolve = activeRun.resolveConfirm
  activeRun.resolveConfirm = null
  activeRun.confirmMessage = null
  resolve(approved)
  return approved ? 'approved' : 'rejected'
}

export function cancelRun(runId: string): string {
  if (!activeRun || activeRun.runId !== runId) return 'no such running workflow'
  activeRun.cancelled = true
  activeRun.cancelModelStep?.()
  // A run parked on a confirm gate resolves as rejected so the loop exits.
  activeRun.resolveConfirm?.(false)
  activeRun.resolveConfirm = null
  return 'cancelling'
}

/** `{{var}}` substitution — string VALUE fields only, in main. The verb
 *  (`action`), step `kind`, `workspace`, and every variable NAME (`into`,
 *  `as`, `name`, `var`) can never be smuggled in. Nested blocks (loop body,
 *  branches) are substituted when they run, with the variables of that
 *  moment — so `{{job}}` means the current item. */
function substitute(step: WorkflowStep, vars: Record<string, string>): WorkflowStep {
  const sub = (s: string): string =>
    s.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, name: string) => vars[name] ?? _m)
  const subFields = <T extends object>(obj: T, keys: string[]): T => {
    const next = { ...obj } as Record<string, unknown>
    for (const k of keys) if (typeof next[k] === 'string') next[k] = sub(next[k] as string)
    return next as T
  }
  switch (step.kind) {
    case 'prompt':
      return { ...step, prompt: sub(step.prompt) }
    case 'confirm':
      return { ...step, message: sub(step.message) }
    case 'wait_for':
    case 'assert':
      return subFields(step, ['label', 'text', 'gone_label', 'gone_text'])
    case 'fill_form': {
      const fields: Record<string, string> = {}
      for (const [k, v] of Object.entries(step.fields)) fields[sub(k)] = sub(String(v))
      return { ...step, fields }
    }
    case 'extract':
      return subFields(step, ['label', 'selector', 'pattern'])
    case 'set':
      return { ...step, value: sub(step.value) }
    case 'foreach':
      return { ...step, items: sub(step.items) }
    case 'if':
      return subFields(step, ['label', 'text', 'url_contains'])
    case 'action': {
      // every string field EXCEPT the verb itself.
      const action = { ...step.action }
      for (const [k, v] of Object.entries(action)) {
        if (k === 'action' || k === 'workspace') continue
        if (typeof v === 'string') (action as Record<string, unknown>)[k] = sub(v)
      }
      return { ...step, action }
    }
  }
  return step
}

/** A foreach list: one item per line, or comma-separated on a single line. */
export function splitItems(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const items = lines.length === 1 && lines[0].includes(',') && !/^https?:/i.test(lines[0])
    ? lines[0].split(',').map((x) => x.trim()).filter(Boolean)
    : lines
  return items.map((x) => x.replace(/^[-*•]\s+/, ''))
}

/** Values read off pages pass the same sensitive-term filter as every other
 *  agent-bound text (invariant 14): they can reach a model step later. */
function screenValue(value: string): string {
  return filterSensitiveLines(value.split('\n')).kept.join('\n').slice(0, 4000)
}

/** executeAction reports failures as prose; classify well-known shapes. */
function looksFailed(result: string, verb: string): boolean {
  if (/^FAILED/i.test(result)) return true
  if (/^refused|refused:/i.test(result) || result.includes('is not allowed')) return true
  if (/^unknown action/.test(result)) return true
  if (/not found$/.test(result)) return true
  if (result.startsWith(`${verb}:`)) return true // arg errors: "add_todo: needs …"
  if (/^no (visible element|workspace|browser pane|matching|such)/i.test(result)) return true
  if (/^BLOCKED/i.test(result)) return true
  return false
}

function failurePolicy(f: WorkflowStepFailure | undefined): {
  retries: number
  delayMs: number
  continueOnFail: boolean
} {
  if (f === 'continue') return { retries: 0, delayMs: 0, continueOnFail: true }
  if (f && typeof f === 'object')
    return {
      retries: Math.min(5, Math.max(0, f.retry)),
      delayMs: Math.min(60_000, Math.max(0, f.delay_ms ?? 2000)),
      continueOnFail: false
    }
  return { retries: 0, delayMs: 0, continueOnFail: false } // 'stop' / default
}

function updateRun(runId: string, patch: Record<string, unknown>): void {
  const sets = Object.keys(patch)
    .map((k) => `${k} = ?`)
    .join(', ')
  getDb()
    .prepare(`UPDATE workflow_runs SET ${sets} WHERE id = ?`)
    .run(...Object.values(patch), runId)
}

/** One bounded model turn as the owning workspace's agent. */
async function runModelStep(
  run: ActiveRun,
  taskId: string,
  wf: Workflow,
  stepIndex: number,
  totalSteps: number,
  prompt: string,
  timeoutMin: number | undefined,
  into?: string
): Promise<{ ok: boolean; outcome: string; costUsd: number; text?: string }> {
  const task = getTask(taskId)
  if (!task || task.aiDisabled) return { ok: false, outcome: 'workspace unavailable', costUsd: 0 }

  // A workflow prompt is NOT the user's live words — no send authority, ever
  // (invariant 19), and the flow-forbidden verbs vanish from the action
  // channel while this step runs.
  clearSendAuthorization()
  watchTaskActions(taskId)
  try {
    refreshClaudeMd(taskId)
  } catch {
    // defense-in-depth, never a blocker
  }
  try {
    await paneManager.snapshotAll(task.folderPath, taskId)
  } catch {
    // best-effort
  }
  beginUnattended(taskId)
  try {
    return await new Promise((resolve) => {
      const handle = runClaudeStream(
        {
          cwd: task.folderPath,
          prompt: [
            `You are executing ONE step of the saved workflow "${wf.name}" (step ${stepIndex + 1} of ${totalSteps}), unattended — the user is not watching.`,
            into
              ? `Do exactly this step, then STOP. Your final message is stored VERBATIM as the workflow variable "${into}" and pasted into later steps (e.g. typed into a form) — so reply with ONLY that content: no preamble, no summary, no quotes.`
              : 'Do exactly this step, verify it via the action result file if you acted, then STOP and summarize the outcome in one short paragraph.',
            '',
            prompt
          ].join('\n'),
          model: getSettings().chatModel, // never the coding model: no Bash unattended
          allowedTools: MODEL_STEP_TOOLS,
          timeoutMs: Math.min(30, Math.max(1, timeoutMin ?? 10)) * 60_000
        },
        {
          onInit: () => undefined,
          onDelta: () => undefined,
          onToolUse: (name, input) => {
            reportActivity(`wf-${run.runId}`, {
              kind: 'chat',
              taskId,
              label: `⚙ ${wf.name}`,
              detail: toolStatus(name, input)
            })
          },
          onResult: ({ text, isError, usage }) => {
            logUsage(taskId, 'workflow', usage)
            resolve({
              ok: !isError,
              outcome: (text || (isError ? 'model step failed' : 'done')).slice(0, 500),
              costUsd: usage.costUsd,
              text: text ?? ''
            })
          },
          onError: (message) => resolve({ ok: false, outcome: message.slice(0, 300), costUsd: 0 })
        }
      )
      run.cancelModelStep = () => handle.cancel()
    })
  } finally {
    run.cancelModelStep = null
    endUnattended(taskId)
    clearSendAuthorization() // belt-and-braces: nothing a step did leaves authority behind
  }
}

type StepOutcome = { ok: boolean; outcome: string; costUsd: number }

async function runStep(
  run: ActiveRun,
  wf: Workflow,
  taskId: string,
  step: WorkflowStep,
  index: number,
  total: number,
  vars: Record<string, string>
): Promise<StepOutcome> {
  if (step.kind === 'action') {
    const a = step.action as AppAction
    if (FLOW_FORBIDDEN.has(a.action) || a.workspace !== undefined) {
      // Save-time validation should have caught this; a hand-edited row must
      // still be refused.
      return { ok: false, outcome: `refused: "${a.action}" is not allowed in a workflow`, costUsd: 0 }
    }
    if (a.action === 'wait') {
      const ms = Math.min(120_000, Math.max(0, Number(a.ms) || 0))
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true, outcome: `waited ${ms}ms`, costUsd: 0 }
    }
    const result = await executeAction(taskId, a)
    return { ok: !looksFailed(result, a.action), outcome: result.slice(0, 500), costUsd: 0 }
  }

  if (step.kind === 'prompt') {
    if (run.modelRuns >= MAX_MODEL_RUNS)
      return { ok: false, outcome: `model-turn budget for one run used up (${MAX_MODEL_RUNS})`, costUsd: 0 }
    run.modelRuns++
    const r = await runModelStep(run, taskId, wf, index, total, step.prompt, step.timeout_min, step.into)
    if (r.ok && step.into) {
      vars[step.into] = screenValue((r.text ?? '').trim())
      return { ok: true, outcome: `{{${step.into}}} = ${preview(vars[step.into])}`, costUsd: r.costUsd }
    }
    return r
  }

  if (step.kind === 'confirm') {
    updateRun(run.runId, { status: 'waiting_confirm' })
    run.confirmMessage = step.message
    pushEvent({ type: 'waiting-confirm', runId: run.runId, message: step.message })
    reportActivity(`wf-${run.runId}`, {
      kind: 'chat',
      taskId: run.taskId,
      label: `⚙ ${wf.name}`,
      detail: `⏸ needs your OK: ${step.message.slice(0, 80)}`
    })
    const approved = await new Promise<boolean>((resolve) => {
      run.resolveConfirm = resolve
    })
    updateRun(run.runId, { status: 'running' })
    return approved
      ? { ok: true, outcome: 'approved by user', costUsd: 0 }
      : { ok: false, outcome: 'rejected by user', costUsd: 0 }
  }

  if (step.kind === 'wait_for') {
    const timeoutMs = Math.min(10, Math.max(0.1, step.timeout_min ?? 2)) * 60_000
    const deadline = Date.now() + timeoutMs
    const wantGone = !!(step.gone_label || step.gone_text)
    const cond = wantGone
      ? { label: step.gone_label, text: step.gone_text }
      : { label: step.label, text: step.text }
    for (;;) {
      if (run.cancelled) return { ok: false, outcome: 'cancelled', costUsd: 0 }
      const present = await paneManager.existsCondition(taskId, cond, step.page)
      if (wantGone ? !present : present)
        return { ok: true, outcome: `condition met after ${Math.round((Date.now() - deadline + timeoutMs) / 1000)}s`, costUsd: 0 }
      if (Date.now() > deadline)
        return { ok: false, outcome: `timed out after ${Math.round(timeoutMs / 1000)}s`, costUsd: 0 }
      // Poll fast at first (most pages settle in a second or two), then back off.
      await new Promise((r) => setTimeout(r, Date.now() - (deadline - timeoutMs) < 10_000 ? 700 : 3000))
    }
  }

  if (step.kind === 'fill_form') {
    const r = await paneManager.fillForm(taskId, step.fields, step.page)
    const parts = [`filled ${r.filled.length}/${Object.keys(step.fields).length}`]
    if (r.missing.length) parts.push(`not found: ${r.missing.join(', ')}`)
    if (r.refused.length) parts.push(`skipped: ${r.refused.join(', ')}`)
    const complete = r.missing.length === 0 && r.refused.length === 0
    return {
      ok: r.filled.length > 0 && (complete || !!step.allow_missing),
      outcome: parts.join(' · ').slice(0, 500),
      costUsd: 0
    }
  }

  if (step.kind === 'extract') {
    const v = await paneManager.readValue(
      taskId,
      { label: step.label, selector: step.selector, pattern: step.pattern, from: step.from },
      step.page
    )
    if (v === null || !v.trim())
      return { ok: false, outcome: `nothing found for {{${step.into}}}`, costUsd: 0 }
    vars[step.into] = screenValue(v.trim())
    return { ok: true, outcome: `{{${step.into}}} = ${preview(vars[step.into])}`, costUsd: 0 }
  }

  if (step.kind === 'set') {
    vars[step.name] = step.value.slice(0, 4000)
    return { ok: true, outcome: `{{${step.name}}} = ${preview(vars[step.name])}`, costUsd: 0 }
  }

  if (step.kind === 'assert') {
    const present = await paneManager.existsCondition(taskId, { label: step.label, text: step.text })
    const ok = step.invert ? !present : present
    return {
      ok,
      outcome: ok
        ? 'assertion held'
        : `assertion failed: ${step.invert ? 'still present' : 'not found'}: ${(step.label ?? step.text ?? '').slice(0, 60)}`,
      costUsd: 0
    }
  }

  // foreach / if are blocks — runBlock handles them, never runStep.
  return { ok: false, outcome: `internal: ${step.kind} is not a leaf step`, costUsd: 0 }
}

function preview(v: string): string {
  const one = v.replace(/\s+/g, ' ')
  return `"${one.length > 120 ? one.slice(0, 117) + '…' : one}"`
}

async function evalCondition(
  taskId: string,
  step: Extract<WorkflowStep, { kind: 'if' }>,
  vars: Record<string, string>
): Promise<boolean> {
  let hit: boolean
  if (step.var) hit = !!vars[step.var]?.trim()
  else if (step.url_contains) {
    const url = (await paneManager.readValue(taskId, { from: 'url' }, step.page)) ?? ''
    hit = url.toLowerCase().includes(step.url_contains.toLowerCase())
  } else hit = await paneManager.existsCondition(taskId, { label: step.label, text: step.text }, step.page)
  return step.invert ? !hit : hit
}

export async function runWorkflow(
  idOrName: string,
  opts: { params?: Record<string, string>; trigger?: string } = {}
): Promise<{ started: boolean; runId?: string; reason?: string }> {
  const wf = getWorkflow(idOrName)
  if (!wf) return { started: false, reason: `no workflow named "${idOrName.slice(0, 60)}"` }
  if (activeRun) return { started: false, reason: 'another workflow run is in progress' }

  // Identity from the ROW, never the caller (containment). Global workflows
  // run as the universal agent's task (its global verbs, no model steps).
  const runTaskId = wf.taskId ?? getOrCreateJarvis().id
  const owner = getTask(runTaskId)
  if (!owner) return { started: false, reason: 'owning workspace no longer exists' }
  if (owner.aiDisabled) return { started: false, reason: 'private workspaces cannot run workflows' }

  // Belt-and-braces re-validation: a row edited outside the app must not run.
  const invalid = validateWorkflow({ name: wf.name, taskId: wf.taskId, steps: wf.steps, params: wf.params })
  if (invalid) return { started: false, reason: `stored workflow is invalid: ${invalid}` }

  const params: Record<string, string> = {}
  for (const p of wf.params) {
    const v = opts.params?.[p.name] ?? p.default
    if (v === undefined && p.required) return { started: false, reason: `missing parameter "${p.name}"` }
    if (v !== undefined) params[p.name] = String(v).slice(0, 2000)
  }

  const runId = newId()
  getDb()
    .prepare(
      "INSERT INTO workflow_runs (id, workflow_id, task_id, status, trigger, params_json, current_step, step_results_json, cost_usd, started_at) VALUES (?, ?, ?, 'running', ?, ?, 0, '[]', 0, ?)"
    )
    .run(runId, wf.id, wf.taskId, opts.trigger ?? 'manual', JSON.stringify(params), nowIso())
  activeRun = {
    runId,
    workflowId: wf.id,
    taskId: wf.taskId,
    cancelled: false,
    confirmMessage: null,
    resolveConfirm: null,
    cancelModelStep: null,
    modelRuns: 0
  }
  pushEvent({ type: 'run-started', runId, name: wf.name })
  reportActivity(`wf-${runId}`, {
    kind: 'chat',
    taskId: wf.taskId,
    label: `⚙ ${wf.name}`,
    detail: 'Starting…'
  })

  void executeRun(activeRun, wf, runTaskId, params)
  return { started: true, runId }
}

interface RunCtx {
  run: ActiveRun
  wf: Workflow
  taskId: string
  vars: Record<string, string>
  results: WorkflowStepResult[]
  cost: number
  startedAt: number
  /** Top-level step currently executing (what the progress bar counts). */
  top: number
}

type BlockResult = 'ok' | 'failed' | 'rejected' | 'cancelled'

function record(ctx: RunCtx, path: string, kind: string, r: StepOutcome, ms: number): void {
  ctx.results.push({ index: ctx.top, path, kind, outcome: r.outcome, ok: r.ok, ms })
  // History is a log, not a dump: a 100-item loop keeps its last 400 lines.
  if (ctx.results.length > 400) ctx.results.splice(0, ctx.results.length - 400)
  updateRun(ctx.run.runId, {
    current_step: ctx.top + 1,
    step_results_json: JSON.stringify(ctx.results),
    cost_usd: ctx.cost
  })
  pushEvent({
    type: 'step-done',
    runId: ctx.run.runId,
    index: ctx.top,
    path,
    ok: r.ok,
    outcome: r.outcome.slice(0, 200)
  })
  reportActivity(`wf-${ctx.run.runId}`, {
    kind: 'chat',
    taskId: ctx.run.taskId,
    label: `⚙ ${ctx.wf.name}`,
    detail: `${r.ok ? '✓' : '✗'} step ${path} of ${ctx.wf.steps.length}`
  })
}

/** Run one block of steps (top level, a loop body, a branch). */
async function runBlock(ctx: RunCtx, steps: WorkflowStep[], path: string): Promise<BlockResult> {
  for (const [i, raw] of steps.entries()) {
    if (ctx.run.cancelled) return 'cancelled'
    if (!path) ctx.top = i
    const here = path ? `${path}.${i + 1}` : `${i + 1}`
    if (Date.now() - ctx.startedAt > MAX_RUN_MS) {
      record(ctx, here, raw.kind, { ok: false, outcome: 'run exceeded 30 minutes', costUsd: 0 }, 0)
      return 'failed'
    }
    const step = substitute(raw, ctx.vars)

    if (step.kind === 'foreach') {
      const cap = Math.min(HARD_MAX_ITEMS, Math.max(1, step.max_items ?? DEFAULT_MAX_ITEMS))
      const all = splitItems(step.items)
      const items = all.slice(0, cap)
      let failed = 0
      for (const [n, item] of items.entries()) {
        if (ctx.run.cancelled) return 'cancelled'
        ctx.vars[step.as] = item
        ctx.vars[`${step.as}_number`] = String(n + 1)
        const r = await runBlock(ctx, step.steps, `${here}[${n + 1}/${items.length}]`)
        if (r === 'cancelled') return r
        if (r !== 'ok') {
          failed++
          if (step.on_item_failure === 'stop') return r
        }
      }
      const note = all.length > items.length ? ` (${all.length - items.length} over the ${cap}-item cap skipped)` : ''
      record(
        ctx,
        here,
        'foreach',
        {
          ok: items.length > 0,
          outcome:
            items.length === 0
              ? 'the list was empty'
              : `${items.length - failed}/${items.length} item(s) completed${failed ? `, ${failed} skipped after failing` : ''}${note}`,
          costUsd: 0
        },
        0
      )
      if (items.length === 0) return 'failed'
      continue
    }

    if (step.kind === 'if') {
      const t0 = Date.now()
      const hit = await evalCondition(ctx.taskId, step, ctx.vars)
      record(ctx, here, 'if', { ok: true, outcome: hit ? 'condition true → then' : 'condition false → else', costUsd: 0 }, Date.now() - t0)
      const branch = hit ? step.then : (step.else ?? [])
      const r = await runBlock(ctx, branch, `${here}.${hit ? 'then' : 'else'}`)
      if (r !== 'ok') return r
      continue
    }

    const policy = failurePolicy('on_failure' in step ? step.on_failure : undefined)
    const t0 = Date.now()
    let result = await runStep(ctx.run, ctx.wf, ctx.taskId, step, ctx.top, ctx.wf.steps.length, ctx.vars)
    ctx.cost += result.costUsd
    for (let attempt = 0; !result.ok && attempt < policy.retries && !ctx.run.cancelled; attempt++) {
      await new Promise((r) => setTimeout(r, policy.delayMs))
      result = await runStep(ctx.run, ctx.wf, ctx.taskId, step, ctx.top, ctx.wf.steps.length, ctx.vars)
      ctx.cost += result.costUsd
    }
    record(ctx, here, step.kind, result, Date.now() - t0)
    if (ctx.run.cancelled) return 'cancelled'
    // A rejected confirm reads as a cancel, not a failure.
    if (!result.ok && !policy.continueOnFail) return step.kind === 'confirm' ? 'rejected' : 'failed'
  }
  return 'ok'
}

async function executeRun(
  run: ActiveRun,
  wf: Workflow,
  runTaskId: string,
  params: Record<string, string>
): Promise<void> {
  const ctx: RunCtx = {
    run,
    wf,
    taskId: runTaskId,
    vars: { ...params },
    results: [],
    cost: 0,
    startedAt: Date.now(),
    top: 0
  }
  let status: WorkflowRunStatus = 'succeeded'
  try {
    const r = await runBlock(ctx, wf.steps, '')
    status = r === 'ok' ? 'succeeded' : r === 'failed' ? 'failed' : 'cancelled'
  } catch (err) {
    ctx.results.push({
      index: ctx.top,
      kind: 'internal',
      outcome: err instanceof Error ? err.message : String(err),
      ok: false,
      ms: 0
    })
    status = 'failed'
  } finally {
    if (run.cancelled) status = 'cancelled'
    updateRun(run.runId, {
      status,
      finished_at: nowIso(),
      step_results_json: JSON.stringify(ctx.results),
      cost_usd: ctx.cost
    })
    // A follow-up model turn (or the user) sees the outcome, like runFlow.
    try {
      const t = getTask(runTaskId)
      if (t && !t.aiDisabled) await paneManager.snapshotAll(t.folderPath, runTaskId)
    } catch {
      // best-effort
    }
    clearActivity(`wf-${run.runId}`)
    if (activeRun?.runId === run.runId) activeRun = null
    pushEvent({ type: 'run-done', runId: run.runId, status })
  }
}

// ---------------------------------------------------------------------------
// Skill import — explicit, per-skill, validated. Never automatic: a poisoned
// asit-flow fence auto-promoted to a first-class entity would be persistent
// injection with better UI legitimacy.

export function importSkillAsWorkflow(skillName: string): { ok: boolean; reason?: string } {
  const skill = listSkills().find((s) => s.name === skillName)
  if (!skill) return { ok: false, reason: 'no such skill' }
  const flow = extractFlow(skill.content)
  if (!flow || flow.length === 0) return { ok: false, reason: 'this skill has no asit-flow fence' }
  const steps: WorkflowStep[] = flow.map((a) => ({
    kind: 'action',
    action: a as { action: string } & Record<string, unknown>
  }))
  const res = saveWorkflow({
    name: skillName,
    description: `Imported from the "${skillName}" skill`,
    taskId: null,
    steps,
    source: 'import'
  })
  return res.ok ? { ok: true } : { ok: false, reason: res.reason }
}
