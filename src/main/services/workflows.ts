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
import { clearSendAuthorization } from './guardrails'
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
const MAX_RUN_MS = 30 * 60_000
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
  if (input.steps.length > MAX_STEPS) return `too many steps (max ${MAX_STEPS})`
  if (input.taskId) {
    const owner = getTask(input.taskId)
    if (!owner) return 'owning workspace not found'
    if (owner.aiDisabled) return 'private workspaces cannot own workflows'
  }
  let modelSteps = 0
  for (const [i, step] of input.steps.entries()) {
    const at = `step ${i + 1}`
    if (step.kind === 'action') {
      const a = step.action
      if (!a || typeof a.action !== 'string') return `${at}: action step needs an action object`
      if (FLOW_FORBIDDEN.has(a.action))
        return `${at}: "${a.action}" is not allowed inside a workflow`
      if ('workspace' in a && a.workspace !== undefined)
        return `${at}: workflow steps may not re-target another workspace`
    } else if (step.kind === 'prompt') {
      modelSteps++
      if (!step.prompt?.trim()) return `${at}: prompt step needs prompt text`
      if (!input.taskId)
        return `${at}: global workflows cannot contain model steps — attach the workflow to a workspace`
    } else if (step.kind === 'confirm') {
      if (!step.message?.trim()) return `${at}: confirm step needs a message`
    } else if (step.kind === 'wait_for') {
      if (!step.label && !step.text && !step.gone_label && !step.gone_text)
        return `${at}: wait_for needs label, text, gone_label or gone_text`
    } else if (step.kind === 'assert') {
      if (!step.label && !step.text) return `${at}: assert needs label or text`
    } else {
      return `${at}: unknown step kind "${(step as { kind?: string }).kind}"`
    }
  }
  if (modelSteps > MAX_MODEL_STEPS) return `too many model steps (max ${MAX_MODEL_STEPS})`
  for (const p of input.params ?? []) {
    if (!/^[a-z0-9_]{1,40}$/i.test(p.name)) return `bad param name "${p.name}"`
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

/** `{{param}}` substitution — string VALUE fields only, in main. The verb
 *  (`action`), step `kind`, and `workspace` can never be smuggled in. */
function substitute(step: WorkflowStep, params: Record<string, string>): WorkflowStep {
  const sub = (s: string): string =>
    s.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, name: string) => params[name] ?? _m)
  if (step.kind === 'prompt') return { ...step, prompt: sub(step.prompt) }
  if (step.kind === 'confirm') return { ...step, message: sub(step.message) }
  if (step.kind === 'wait_for' || step.kind === 'assert') {
    const next = { ...step } as Record<string, unknown>
    for (const k of ['label', 'text', 'gone_label', 'gone_text']) {
      if (typeof next[k] === 'string') next[k] = sub(next[k] as string)
    }
    return next as WorkflowStep
  }
  // action step: every string field EXCEPT the verb itself.
  const action = { ...step.action }
  for (const [k, v] of Object.entries(action)) {
    if (k === 'action' || k === 'workspace') continue
    if (typeof v === 'string') (action as Record<string, unknown>)[k] = sub(v)
  }
  return { ...step, action }
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
  timeoutMin: number | undefined
): Promise<{ ok: boolean; outcome: string; costUsd: number }> {
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
            'Do exactly this step, verify it via the action result file if you acted, then STOP and summarize the outcome in one short paragraph.',
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
              costUsd: usage.costUsd
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

async function runStep(
  run: ActiveRun,
  wf: Workflow,
  taskId: string,
  step: WorkflowStep,
  index: number,
  total: number
): Promise<{ ok: boolean; outcome: string; costUsd: number }> {
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
    return runModelStep(run, taskId, wf, index, total, step.prompt, step.timeout_min)
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
      await new Promise((r) => setTimeout(r, 4000))
    }
  }

  // assert
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
    cancelModelStep: null
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

async function executeRun(
  run: ActiveRun,
  wf: Workflow,
  runTaskId: string,
  params: Record<string, string>
): Promise<void> {
  const results: WorkflowStepResult[] = []
  const startedAt = Date.now()
  let status: WorkflowRunStatus = 'succeeded'
  let cost = 0
  try {
    for (const [index, raw] of wf.steps.entries()) {
      if (run.cancelled) {
        status = 'cancelled'
        break
      }
      if (Date.now() - startedAt > MAX_RUN_MS) {
        results.push({ index, kind: raw.kind, outcome: 'run exceeded 30 minutes', ok: false, ms: 0 })
        status = 'failed'
        break
      }
      const step = substitute(raw, params)
      const policy = failurePolicy('on_failure' in step ? step.on_failure : undefined)
      const t0 = Date.now()
      let result = await runStep(run, wf, runTaskId, step, index, wf.steps.length)
      cost += result.costUsd
      for (let attempt = 0; !result.ok && attempt < policy.retries && !run.cancelled; attempt++) {
        await new Promise((r) => setTimeout(r, policy.delayMs))
        result = await runStep(run, wf, runTaskId, step, index, wf.steps.length)
        cost += result.costUsd
      }
      results.push({
        index,
        kind: step.kind,
        outcome: result.outcome,
        ok: result.ok,
        ms: Date.now() - t0
      })
      updateRun(run.runId, {
        current_step: index + 1,
        step_results_json: JSON.stringify(results),
        cost_usd: cost
      })
      pushEvent({
        type: 'step-done',
        runId: run.runId,
        index,
        ok: result.ok,
        outcome: result.outcome.slice(0, 200)
      })
      reportActivity(`wf-${run.runId}`, {
        kind: 'chat',
        taskId: run.taskId,
        label: `⚙ ${wf.name}`,
        detail: `${result.ok ? '✓' : '✗'} step ${index + 1}/${wf.steps.length}`
      })
      if (run.cancelled) {
        status = 'cancelled'
        break
      }
      if (!result.ok && !policy.continueOnFail) {
        // A rejected confirm reads as a cancel, not a failure.
        status = step.kind === 'confirm' ? 'cancelled' : 'failed'
        break
      }
    }
  } catch (err) {
    results.push({
      index: results.length,
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
      step_results_json: JSON.stringify(results),
      cost_usd: cost
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
