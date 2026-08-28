import { useEffect, useState } from 'react'
import type { Workflow } from '@shared/types'
import { useStore } from '../store/useStore'

// Automations, on the new-tab page.
//
// Workflows and schedules are the thing ASIT has that a browser does not, and
// they were behind a modal nobody opens — so in practice the app was a browser
// with an AI panel, and the automation may as well not have existed. They live
// here now: visible every time you open a tab, one click to run.
//
// Scope is the honest one the engine already enforces (invariant 22): a
// workflow's identity comes from its OWN row, so this lists the current
// group's workflows plus the global ones, and running one from here is exactly
// the same call the modal makes.

interface Schedule {
  id: string
  prompt: string
  workflowId: string | null
  repeat: 'once' | 'hourly' | 'daily' | 'weekdays'
  nextAt: string
  enabled: boolean
}

function whenLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'due now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

export default function NtpAutomations(): JSX.Element | null {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const activeTask = useStore((s) => s.activeTask)
  const setAutomationsOpen = useStore((s) => s.setAutomationsOpen)
  const pushNotice = useStore((s) => s.pushNotice)

  useEffect(() => {
    void window.asit.workflows.list().then(setWorkflows)
    void window.asit.schedules.list().then((rows) => setSchedules(rows as Schedule[]))
  }, [])

  // This group's automations first, then the global ones — the same ordering
  // the chat's ./name resolution uses.
  const mine = workflows.filter((w) => w.taskId && w.taskId === activeTask?.id)
  const global = workflows.filter((w) => !w.taskId)
  const shown = [...mine, ...global].slice(0, 8)

  const next = schedules
    .filter((s) => s.enabled)
    .sort((a, b) => new Date(a.nextAt).getTime() - new Date(b.nextAt).getTime())[0]

  async function run(w: Workflow): Promise<void> {
    // Anything that needs input goes to the full editor, which has the form —
    // a one-click run that silently fails on a missing param is worse than an
    // extra click.
    if (w.params.some((p) => p.required && !p.default)) {
      setAutomationsOpen(true)
      return
    }
    setBusy(w.id)
    try {
      const r = await window.asit.workflows.run(w.name)
      pushNotice(
        r.started ? `Running ${w.name}…` : `Couldn’t start ${w.name} — ${r.reason ?? 'unknown'}`,
        r.started ? 'ok' : 'error'
      )
    } catch (err) {
      pushNotice(
        `Couldn’t start ${w.name} — ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="ntp-section">
      <div className="ntp-label ntp-label-row">
        <span>Automations</span>
        <button className="ntp-manage" onClick={() => setAutomationsOpen(true)}>
          {shown.length > 0 ? 'Manage' : 'Create one'} →
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="ntp-empty">
          Nothing automated yet. Ask the agent to build one — “every weekday at 8am, summarise my
          unread mail” — or write the steps yourself.
        </p>
      ) : (
        <div className="ntp-flows">
          {shown.map((w) => (
            <button
              key={w.id}
              className="ntp-flow"
              title={w.description || w.name}
              disabled={busy === w.id}
              onClick={() => void run(w)}
            >
              <span className="ntp-flow-run">▷</span>
              <span className="ntp-flow-name">{w.name}</span>
              {!w.taskId && (
                <span className="ntp-flow-scope" title="Runs everywhere">
                  global
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {next && (
        <div className="ntp-next" title={new Date(next.nextAt).toLocaleString()}>
          Next scheduled: {next.workflowId
            ? (workflows.find((w) => w.id === next.workflowId)?.name ?? 'a workflow')
            : next.prompt.slice(0, 48)}{' '}
          — {whenLabel(next.nextAt)}
        </div>
      )}
    </div>
  )
}
