import { useCallback, useEffect, useMemo, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { Workflow, WorkflowRun, WorkflowStep } from '@shared/types'
import { useStore } from '../store/useStore'
import { useOverlay } from '../hooks/useOverlay'
import WorkflowEditor from './WorkflowEditor'

// Automations: the one place to see and manage everything the app does on
// its own — saved workflows (run, edit, history, approve paused runs) and
// schedules (which previously had NO user-visible surface at all: an agent
// could arm one and the user couldn't even list them).

type Schedule = Awaited<ReturnType<typeof window.asit.schedules.list>>[number]

function stepSummary(step: WorkflowStep): string {
  switch (step.kind) {
    case 'action':
      return `⚙ ${step.action.action}${typeof step.action.label === 'string' ? ` "${step.action.label}"` : ''}`
    case 'prompt':
      return `✦ ${step.prompt.replace(/\s+/g, ' ').slice(0, 60)}${step.into ? ` → {{${step.into}}}` : ''}`
    case 'confirm':
      return `⏸ ${step.message.slice(0, 50)}`
    case 'wait_for':
      return `👁 wait for ${step.label ?? step.text ?? `gone: ${step.gone_label ?? step.gone_text}`}`
    case 'assert':
      return `✓ check ${step.invert ? 'absent' : 'present'}: ${step.label ?? step.text}`
    case 'fill_form':
      return `✎ fill ${Object.keys(step.fields).length} fields`
    case 'extract':
      return `⤓ {{${step.into}}}`
    case 'set':
      return `= {{${step.name}}}`
    case 'foreach':
      return `↻ each ${step.as} (${step.steps.length} steps)`
    case 'if':
      return `⑂ if ${step.text ?? step.label ?? step.url_contains ?? step.var ?? ''}`
  }
  return ''
}

function RunView({ run, live }: { run: WorkflowRun; live: boolean }): JSX.Element {
  return (
    <div className={`workflow-run ${live ? 'workflow-run-live' : ''}`}>
      <div className="workflow-run-head">
        <span className="workflow-run-name">{run.workflowName}</span>
        <span className={`badge run-${run.status}`}>{run.status.replace('_', ' ')}</span>
        <span className="workflow-run-meta">
          {new Date(run.startedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })}
          {run.costUsd >= 0.005 && ` · $${run.costUsd.toFixed(2)}`}
          {` · ${run.trigger}`}
        </span>
        {live && run.status === 'running' && (
          <button
            className="btn btn-ghost"
            onClick={() => void window.asit.workflows.cancel(run.id)}
          >
            ◼ Stop
          </button>
        )}
      </div>
      {run.stepResults.length > 0 && (
        <div className="workflow-run-steps">
          {run.stepResults.map((s, i) => (
            <div key={i} className="workflow-run-step">
              {s.ok ? '✓' : '✗'} <span className="workflow-run-path">{s.path ?? s.index + 1}</span>{' '}
              <b>{s.kind}</b> — {s.outcome.slice(0, 200)}
            </div>
          ))}
        </div>
      )}
      {run.status === 'waiting_confirm' && run.confirmMessage && (
        <div className="workflow-confirm">
          <span>⏸ {run.confirmMessage}</span>
          <button
            className="btn btn-primary"
            onClick={() => void window.asit.workflows.confirm(run.id, true)}
          >
            Approve
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void window.asit.workflows.confirm(run.id, false)}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  )
}

export default function AutomationsModal(): JSX.Element | null {
  const open = useStore((s) => s.automationsOpen)
  const setOpen = useStore((s) => s.setAutomationsOpen)
  const tasks = useStore((s) => s.tasks)
  const [tab, setTab] = useState<'workflows' | 'schedules'>('workflows')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [liveRun, setLiveRun] = useState<WorkflowRun | null>(null)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [skills, setSkills] = useState<{ name: string; content: string }[]>([])
  const [editing, setEditing] = useState<Workflow | null | 'new'>(null)
  const [runFor, setRunFor] = useState<Workflow | null>(null)
  const [runParams, setRunParams] = useState<Record<string, string>>({})
  const [note, setNote] = useState<string | null>(null)
  // Schedule creation
  const [schedWhen, setSchedWhen] = useState('')
  const [schedTarget, setSchedTarget] = useState('') // '' = prompt; else workflow id
  const [schedPrompt, setSchedPrompt] = useState('')

  useOverlay(open)

  const reload = useCallback(async (): Promise<void> => {
    const [wfs, runList, scheds, skillList, live] = await Promise.all([
      window.asit.workflows.list(),
      window.asit.workflows.runs(30),
      window.asit.schedules.list(),
      window.asit.skills.list(),
      window.asit.workflows.runState()
    ])
    setWorkflows(wfs)
    setRuns(runList)
    setSchedules(scheds)
    setSkills(skillList)
    setLiveRun(live)
  }, [])

  useEffect(() => {
    if (!open) return
    void reload()
    const offWf = window.asit.on(IPC.WORKFLOWS_EVENT, () => void reload())
    const offSched = window.asit.on(IPC.SCHEDULES_CHANGED, () => void reload())
    return () => {
      offWf()
      offSched()
    }
  }, [open, reload])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !editing && !runFor) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen, editing, runFor])

  const importableSkills = useMemo(
    () =>
      skills.filter(
        (s) => s.content.includes('```asit-flow') && !workflows.some((w) => w.name === s.name)
      ),
    [skills, workflows]
  )

  if (!open) return null

  async function startRun(wf: Workflow, params: Record<string, string>): Promise<void> {
    const res = await window.asit.workflows.run(wf.id, params)
    setNote(res.started ? `Running "${wf.name}"…` : `Couldn't start: ${res.reason}`)
    setRunFor(null)
    setRunParams({})
    await reload()
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal automations-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <button
              className={`history-tab ${tab === 'workflows' ? 'history-tab-on' : ''}`}
              onClick={() => setTab('workflows')}
            >
              Workflows
            </button>
            <button
              className={`history-tab ${tab === 'schedules' ? 'history-tab-on' : ''}`}
              onClick={() => setTab('schedules')}
            >
              Schedules
            </button>
          </h2>
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>

        {note && <p className="transfer-note">{note}</p>}
        {liveRun && (liveRun.status === 'running' || liveRun.status === 'waiting_confirm') && (
          <RunView run={liveRun} live />
        )}

        {tab === 'workflows' && (
          <div className="automations-body">
            {editing !== null ? (
              <WorkflowEditor
                existing={editing === 'new' ? null : editing}
                tasks={tasks}
                onClose={(saved, runName) => {
                  setEditing(null)
                  if (!saved) return
                  void reload().then(async () => {
                    if (!runName) return
                    const wf = (await window.asit.workflows.list()).find((w) => w.name === runName)
                    if (!wf) return
                    if (wf.params.some((p) => p.required && !p.default)) {
                      setRunFor(wf)
                      setRunParams({})
                    } else void startRun(wf, {})
                  })
                }}
              />
            ) : runFor ? (
              <div className="workflow-editor">
                <div className="rail-header">Run “{runFor.name}”</div>
                {runFor.params.map((p) => (
                  <label key={p.name} className="settings-field">
                    <span>
                      {p.label ?? p.name}
                      {p.required ? ' *' : ''}
                    </span>
                    {/(urls|links|list|items)$/i.test(p.name) ? (
                      <textarea
                        rows={5}
                        placeholder="One per line"
                        value={runParams[p.name] ?? p.default ?? ''}
                        onChange={(e) => setRunParams({ ...runParams, [p.name]: e.target.value })}
                      />
                    ) : (
                      <input
                        value={runParams[p.name] ?? p.default ?? ''}
                        onChange={(e) => setRunParams({ ...runParams, [p.name]: e.target.value })}
                      />
                    )}
                  </label>
                ))}
                <div className="form-row">
                  <button className="btn btn-primary" onClick={() => void startRun(runFor, runParams)}>
                    ▶ Run
                  </button>
                  <button className="btn btn-ghost" onClick={() => setRunFor(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button className="btn side-new" onClick={() => setEditing('new')}>
                  + New workflow
                </button>
                {workflows.length === 0 && (
                  <p className="library-empty">
                    No workflows yet. Click “+ New workflow” and describe what to automate, or ask a chat to “save this as a workflow”.
                  </p>
                )}
                {workflows.map((wf) => (
                  <div key={wf.id} className="workflow-row">
                    <div className="workflow-row-main">
                      <span className="workflow-name">./{wf.name}</span>
                      <span className="workflow-meta">
                        {wf.taskId
                          ? (tasks.find((t) => t.id === wf.taskId)?.title ?? 'workspace')
                          : 'global'}{' '}
                        · {wf.steps.length} steps
                        {wf.description ? ` — ${wf.description}` : ''}
                      </span>
                      <span className="workflow-steps-preview">
                        {wf.steps.slice(0, 4).map(stepSummary).join('  →  ')}
                        {wf.steps.length > 4 ? '  →  …' : ''}
                      </span>
                    </div>
                    <button
                      className="btn"
                      title="Run"
                      onClick={() => {
                        if (wf.params.length > 0) {
                          setRunFor(wf)
                          setRunParams({})
                        } else void startRun(wf, {})
                      }}
                    >
                      ▶
                    </button>
                    <button className="btn btn-ghost" title="Edit" onClick={() => setEditing(wf)}>
                      ✏
                    </button>
                    <button
                      className="btn btn-ghost"
                      title="Delete"
                      onClick={async () => {
                        if (!confirm(`Delete workflow "${wf.name}"?`)) return
                        await window.asit.workflows.delete(wf.id)
                        await reload()
                      }}
                    >
                      🗑
                    </button>
                  </div>
                ))}
                {importableSkills.length > 0 && (
                  <>
                    <div className="rail-header" style={{ marginTop: 12 }}>
                      Skills with replayable flows
                    </div>
                    {importableSkills.map((s) => (
                      <div key={s.name} className="workflow-row">
                        <div className="workflow-row-main">
                          <span className="workflow-name">./{s.name}</span>
                          <span className="workflow-meta">skill — import to run it as a workflow</span>
                        </div>
                        <button
                          className="btn"
                          onClick={async () => {
                            const r = await window.asit.workflows.importSkill(s.name)
                            setNote(r.ok ? `Imported "${s.name}"` : `Import failed: ${r.reason}`)
                            await reload()
                          }}
                        >
                          Import
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {runs.length > 0 && (
                  <>
                    <div className="rail-header" style={{ marginTop: 12 }}>
                      Recent runs
                    </div>
                    {runs.map((r) => (
                      <RunView key={r.id} run={r} live={false} />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'schedules' && (
          <div className="automations-body">
            <div className="workflow-editor">
              <div className="form-row">
                <input
                  placeholder='When — "08:00", "weekdays 7:30", "in 30m", "hourly"'
                  value={schedWhen}
                  onChange={(e) => setSchedWhen(e.target.value)}
                />
                <select value={schedTarget} onChange={(e) => setSchedTarget(e.target.value)}>
                  <option value="">Run a prompt (agent turn)</option>
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>
                      Workflow: {w.name}
                    </option>
                  ))}
                </select>
              </div>
              {!schedTarget && (
                <input
                  placeholder="Prompt — what should the agent do? (it can never SEND anything unattended)"
                  value={schedPrompt}
                  onChange={(e) => setSchedPrompt(e.target.value)}
                />
              )}
              <div className="form-row">
                <button
                  className="btn btn-primary"
                  disabled={!schedWhen.trim() || (!schedTarget && !schedPrompt.trim())}
                  onClick={async () => {
                    const res = await window.asit.schedules.add({
                      when: schedWhen.trim(),
                      prompt: schedTarget ? undefined : schedPrompt.trim(),
                      workflowId: schedTarget || null
                    })
                    setNote(res.ok ? 'Scheduled ✓' : `Couldn't schedule: ${res.reason}`)
                    if (res.ok) {
                      setSchedWhen('')
                      setSchedPrompt('')
                      setSchedTarget('')
                    }
                    await reload()
                  }}
                >
                  + Schedule
                </button>
              </div>
            </div>
            {schedules.length === 0 && (
              <p className="library-empty">
                Nothing scheduled. Schedules run unattended — sends stay blocked; the agent drafts
                instead.
              </p>
            )}
            {schedules.map((s) => (
              <div key={s.id} className={`workflow-row ${s.enabled ? '' : 'schedule-paused'}`}>
                <div className="workflow-row-main">
                  <span className="workflow-name">
                    {s.workflowId
                      ? `⚙ ${workflows.find((w) => w.id === s.workflowId)?.name ?? '(deleted workflow)'}`
                      : s.prompt.replace(/\s+/g, ' ').slice(0, 70)}
                  </span>
                  <span className="workflow-meta">
                    {s.repeat} · next{' '}
                    {new Date(s.nextAt).toLocaleString(undefined, {
                      weekday: 'short',
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                    {s.lastResult ? ` · last: ${s.lastResult.slice(0, 40)}` : ''}
                  </span>
                </div>
                <button
                  className="btn btn-ghost"
                  title={s.enabled ? 'Pause' : 'Resume'}
                  onClick={async () => {
                    await window.asit.schedules.setEnabled(s.id, !s.enabled)
                    await reload()
                  }}
                >
                  {s.enabled ? '⏸' : '▶'}
                </button>
                <button
                  className="btn btn-ghost"
                  title="Delete"
                  onClick={async () => {
                    await window.asit.schedules.remove(s.id)
                    await reload()
                  }}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
