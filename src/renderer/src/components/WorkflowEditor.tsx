import { useState } from 'react'
import type { Task, Workflow, WorkflowParam, WorkflowStep, WorkflowStepFailure } from '@shared/types'
import { useStore } from '../store/useStore'

// The workflow editor. Two ways in, one result:
//
//   1. DESCRIBE IT. Write what you want in plain words ("apply to each of
//      these internship links with my details, write the why-us answer, stop
//      before submit"); the model drafts the steps; you review them below.
//      Ticking "use the open page" hands the drafter the real field labels of
//      the form in front of you, so the draft fills what's actually there.
//   2. EDIT THE STEPS. Every step is a card with plain fields — no JSON
//      unless you ask for it.
//
// Nothing saves or runs until you click Save. A draft is data.

type Step = WorkflowStep
type Kind = Step['kind']

const KIND_LABEL: Record<Kind, string> = {
  action: 'Do',
  fill_form: 'Fill form',
  extract: 'Read value',
  set: 'Set variable',
  wait_for: 'Wait for',
  assert: 'Check',
  if: 'If',
  foreach: 'For each',
  confirm: 'Ask me',
  prompt: 'AI step'
}

const KIND_HINT: Record<Kind, string> = {
  action: 'Open a page, click, type, add a to-do…',
  fill_form: 'Fill many labelled fields at once',
  extract: 'Read text off the page into a variable',
  set: 'Build a variable from others',
  wait_for: 'Wait until something appears or goes away',
  assert: 'Stop if the page isn’t what you expect',
  if: 'Branch on what the page shows',
  foreach: 'Repeat steps for every item in a list',
  confirm: 'Pause until you approve (before submitting!)',
  prompt: 'Let the AI write or decide one thing'
}

const VERBS: { verb: string; label: string; fields: [string, string][] }[] = [
  { verb: 'navigate', label: 'Open URL', fields: [['url', 'https://…']] },
  { verb: 'page_click', label: 'Click', fields: [['label', 'Button or link text']] },
  { verb: 'page_fill', label: 'Type into field', fields: [['label', 'Field label'], ['value', 'Text']] },
  { verb: 'page_key', label: 'Press key', fields: [['key', 'Enter']] },
  { verb: 'page_type', label: 'Type text', fields: [['value', 'Text']] },
  { verb: 'wait', label: 'Pause', fields: [['ms', 'Milliseconds']] },
  { verb: 'add_todo', label: 'Add to-do', fields: [['value', 'To-do text']] },
  { verb: 'add_note', label: 'Add note', fields: [['title', 'Title'], ['content', 'Note']] },
  { verb: 'remember', label: 'Remember fact', fields: [['value', 'Fact']] },
  { verb: 'add_url', label: 'Pin URL', fields: [['url', 'https://…'], ['title', 'Title']] }
]

const TEMPLATES: { label: string; text: string; page?: boolean }[] = [
  {
    label: 'Apply to internships from a list',
    text:
      'For each job posting URL in a list I give you: open it, click the apply button, fill the application ' +
      'with my details (first name, last name, email, phone, school, graduation year, LinkedIn, GitHub, work ' +
      'authorization), have the AI write a short answer to any "why this company" question using the posting, ' +
      'remind me to attach my resume, ask me before submitting, then add a to-do "Applied to <company>".'
  },
  {
    label: 'Fill the form on this page with my details',
    text: 'Fill the form that is open right now with my details, then ask me before submitting.',
    page: true
  },
  {
    label: 'Track postings into to-dos',
    text:
      'Open each careers page in a list, read the job title and company, and add a to-do "Look at <title> at <company>" for each.'
  },
  {
    label: 'Daily check of a page',
    text: 'Open a page I choose, read the main heading, and add a note with what it says today.'
  }
]

function blank(kind: Kind): Step {
  switch (kind) {
    case 'action':
      return { kind, action: { action: 'navigate', url: '' } }
    case 'fill_form':
      return { kind, fields: { 'First name': '{{first_name}}' }, allow_missing: true }
    case 'extract':
      return { kind, into: 'value', selector: 'h1' }
    case 'set':
      return { kind, name: 'value', value: '' }
    case 'wait_for':
      return { kind, text: '', timeout_min: 2 }
    case 'assert':
      return { kind, text: '' }
    case 'if':
      return { kind, text: '', then: [], else: [] }
    case 'foreach':
      return { kind, items: '{{items}}', as: 'item', steps: [], on_item_failure: 'continue' }
    case 'confirm':
      return { kind, message: 'Continue?' }
    case 'prompt':
      return { kind, prompt: '', into: 'answer' }
  }
}

// ---------------------------------------------------------------------------
// Small field helpers

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  mono,
  width
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  multiline?: boolean
  mono?: boolean
  width?: number
}): JSX.Element {
  return (
    <label className="wfe-field" style={width ? { flex: `0 0 ${width}px` } : undefined}>
      {label && <span className="wfe-field-label">{label}</span>}
      {multiline ? (
        <textarea
          rows={Math.min(8, Math.max(2, value.split('\n').length))}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          className={mono ? 'wfe-mono' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          className={mono ? 'wfe-mono' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  )
}

function FailurePicker({
  value,
  onChange
}: {
  value: WorkflowStepFailure | undefined
  onChange: (v: WorkflowStepFailure | undefined) => void
}): JSX.Element {
  const cur = value === 'continue' ? 'continue' : value && typeof value === 'object' ? 'retry' : 'stop'
  return (
    <select
      className="wfe-failure"
      title="If this step fails"
      value={cur}
      onChange={(e) =>
        onChange(
          e.target.value === 'continue'
            ? 'continue'
            : e.target.value === 'retry'
              ? { retry: 2, delay_ms: 2000 }
              : undefined
        )
      }
    >
      <option value="stop">on fail: stop</option>
      <option value="continue">on fail: keep going</option>
      <option value="retry">on fail: retry ×2</option>
    </select>
  )
}

function AddStep({ onAdd, globalScope }: { onAdd: (s: Step) => void; globalScope: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  if (!open)
    return (
      <button className="wfe-add" onClick={() => setOpen(true)}>
        + Add step
      </button>
    )
  return (
    <div className="wfe-add-menu">
      {(Object.keys(KIND_LABEL) as Kind[])
        .filter((k) => !(globalScope && k === 'prompt'))
        .map((k) => (
          <button
            key={k}
            className="wfe-add-kind"
            title={KIND_HINT[k]}
            onClick={() => {
              onAdd(blank(k))
              setOpen(false)
            }}
          >
            <b>{KIND_LABEL[k]}</b>
            <span>{KIND_HINT[k]}</span>
          </button>
        ))}
      <button className="btn btn-ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One step

function StepBody({
  step,
  set,
  globalScope
}: {
  step: Step
  set: (s: Step) => void
  globalScope: boolean
}): JSX.Element {
  switch (step.kind) {
    case 'action': {
      const verb = step.action.action
      const known = VERBS.find((v) => v.verb === verb)
      const a = step.action as Record<string, unknown>
      return (
        <div className="wfe-row">
          <select
            value={known ? verb : '__other'}
            onChange={(e) => {
              if (e.target.value === '__other') return
              set({ ...step, action: { action: e.target.value } })
            }}
          >
            {VERBS.map((v) => (
              <option key={v.verb} value={v.verb}>
                {v.label}
              </option>
            ))}
            {!known && <option value="__other">{verb}</option>}
          </select>
          {known ? (
            known.fields.map(([k, ph]) => (
              <Field
                key={k}
                value={String(a[k] ?? '')}
                placeholder={ph}
                onChange={(v) =>
                  set({ ...step, action: { ...step.action, [k]: k === 'ms' ? Number(v) || 0 : v } })
                }
              />
            ))
          ) : (
            <Field
              mono
              value={JSON.stringify(step.action)}
              onChange={(v) => {
                try {
                  set({ ...step, action: JSON.parse(v) })
                } catch {
                  /* keep typing */
                }
              }}
            />
          )}
        </div>
      )
    }
    case 'fill_form': {
      const entries = Object.entries(step.fields)
      const write = (next: [string, string][]): void =>
        set({ ...step, fields: Object.fromEntries(next.filter(([k], i, all) => all.findIndex(([k2]) => k2 === k) === i)) })
      return (
        <div className="wfe-col">
          {entries.map(([k, v], i) => (
            <div className="wfe-row" key={i}>
              <Field
                value={k}
                placeholder="Field label as shown"
                width={220}
                onChange={(nk) => write(entries.map((e, j) => (j === i ? [nk, e[1]] : e)))}
              />
              <span className="wfe-arrow">←</span>
              <Field
                value={v}
                placeholder="Value or {{param}}"
                onChange={(nv) => write(entries.map((e, j) => (j === i ? [e[0], nv] : e)))}
              />
              <button className="wfe-x" onClick={() => write(entries.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <div className="wfe-row">
            <button className="wfe-add wfe-add-small" onClick={() => write([...entries, [`Field ${entries.length + 1}`, '']])}>
              + field
            </button>
            <label className="wfe-check">
              <input
                type="checkbox"
                checked={!!step.allow_missing}
                onChange={(e) => set({ ...step, allow_missing: e.target.checked })}
              />
              OK if some fields aren’t on the page
            </label>
          </div>
        </div>
      )
    }
    case 'extract': {
      const mode = step.from ?? (step.selector !== undefined ? 'selector' : step.pattern !== undefined ? 'pattern' : 'label')
      const value = step.selector ?? step.pattern ?? step.label ?? ''
      return (
        <div className="wfe-row">
          <Field value={step.into} placeholder="variable" width={130} onChange={(v) => set({ ...step, into: v })} />
          <span className="wfe-arrow">=</span>
          <select
            value={mode}
            onChange={(e) => {
              const m = e.target.value
              const base = { kind: 'extract' as const, into: step.into, page: step.page, on_failure: step.on_failure }
              if (m === 'url' || m === 'title') set({ ...base, from: m })
              else set({ ...base, [m]: value })
            }}
          >
            <option value="label">field / button named</option>
            <option value="selector">CSS selector</option>
            <option value="pattern">text matching regex</option>
            <option value="url">page URL</option>
            <option value="title">page title</option>
          </select>
          {mode !== 'url' && mode !== 'title' && (
            <Field
              mono={mode !== 'label'}
              value={value}
              placeholder={mode === 'selector' ? 'h1' : mode === 'pattern' ? 'Company:\\s*(.+)' : 'Field label'}
              onChange={(v) => set({ ...step, [mode]: v })}
            />
          )}
        </div>
      )
    }
    case 'set':
      return (
        <div className="wfe-row">
          <Field value={step.name} placeholder="variable" width={130} onChange={(v) => set({ ...step, name: v })} />
          <span className="wfe-arrow">=</span>
          <Field value={step.value} placeholder="{{first}} {{last}}" onChange={(v) => set({ ...step, value: v })} />
        </div>
      )
    case 'wait_for': {
      const mode = step.gone_text !== undefined ? 'gone_text' : step.gone_label !== undefined ? 'gone_label' : step.label !== undefined ? 'label' : 'text'
      const value = step[mode] ?? ''
      return (
        <div className="wfe-row">
          <select
            value={mode}
            onChange={(e) =>
              set({ kind: 'wait_for', [e.target.value]: value, timeout_min: step.timeout_min, page: step.page, on_failure: step.on_failure })
            }
          >
            <option value="text">text appears</option>
            <option value="label">button/field appears</option>
            <option value="gone_text">text disappears</option>
            <option value="gone_label">button/field disappears</option>
          </select>
          <Field value={value} placeholder="Thank you for applying" onChange={(v) => set({ ...step, [mode]: v })} />
          <Field
            value={String(step.timeout_min ?? 2)}
            width={70}
            label="min"
            onChange={(v) => set({ ...step, timeout_min: Number(v) || 2 })}
          />
        </div>
      )
    }
    case 'assert': {
      const mode = step.label !== undefined ? 'label' : 'text'
      return (
        <div className="wfe-row">
          <select
            value={`${mode}:${step.invert ? 1 : 0}`}
            onChange={(e) => {
              const [m, inv] = e.target.value.split(':')
              set({ kind: 'assert', [m]: step.label ?? step.text ?? '', invert: inv === '1', on_failure: step.on_failure })
            }}
          >
            <option value="text:0">page shows text</option>
            <option value="label:0">page has button/field</option>
            <option value="text:1">page does NOT show text</option>
            <option value="label:1">page has NO button/field</option>
          </select>
          <Field value={step.label ?? step.text ?? ''} onChange={(v) => set({ ...step, [mode]: v })} />
        </div>
      )
    }
    case 'confirm':
      return <Field value={step.message} placeholder="Submit the application?" onChange={(v) => set({ ...step, message: v })} />
    case 'prompt':
      return (
        <div className="wfe-col">
          <Field
            multiline
            value={step.prompt}
            placeholder="Write a 3-sentence answer to “Why {{company}}?” from the posting and my notes."
            onChange={(v) => set({ ...step, prompt: v })}
          />
          <div className="wfe-row">
            <Field
              label="save reply as"
              value={step.into ?? ''}
              placeholder="(acts on the page instead)"
              width={220}
              onChange={(v) => set({ ...step, into: v.trim() ? v.trim() : undefined })}
            />
          </div>
        </div>
      )
    case 'if': {
      const mode = step.var !== undefined ? 'var' : step.url_contains !== undefined ? 'url_contains' : step.label !== undefined ? 'label' : 'text'
      const value = step[mode] ?? ''
      return (
        <div className="wfe-col">
          <div className="wfe-row">
            <select
              value={`${mode}:${step.invert ? 1 : 0}`}
              onChange={(e) => {
                const [m, inv] = e.target.value.split(':')
                set({ kind: 'if', [m]: value, invert: inv === '1', page: step.page, then: step.then, else: step.else })
              }}
            >
              <option value="text:0">page shows text</option>
              <option value="text:1">page doesn’t show text</option>
              <option value="label:0">page has button/field</option>
              <option value="url_contains:0">URL contains</option>
              <option value="var:0">variable is set</option>
              <option value="var:1">variable is empty</option>
            </select>
            <Field value={value} onChange={(v) => set({ ...step, [mode]: v })} />
          </div>
          <div className="wfe-branch">
            <span className="wfe-branch-label">then</span>
            <StepList steps={step.then} onChange={(then) => set({ ...step, then })} globalScope={globalScope} />
          </div>
          <div className="wfe-branch">
            <span className="wfe-branch-label">else</span>
            <StepList steps={step.else ?? []} onChange={(e) => set({ ...step, else: e })} globalScope={globalScope} />
          </div>
        </div>
      )
    }
    case 'foreach':
      return (
        <div className="wfe-col">
          <div className="wfe-row">
            <Field value={step.as} width={110} label="each" onChange={(v) => set({ ...step, as: v })} />
            <Field value={step.items} label="in (one per line)" placeholder="{{job_urls}}" onChange={(v) => set({ ...step, items: v })} />
            <select
              value={step.on_item_failure ?? 'continue'}
              onChange={(e) => set({ ...step, on_item_failure: e.target.value as 'continue' | 'stop' })}
            >
              <option value="continue">skip a failed item</option>
              <option value="stop">stop on a failed item</option>
            </select>
          </div>
          <div className="wfe-branch">
            <span className="wfe-branch-label">do</span>
            <StepList steps={step.steps} onChange={(steps) => set({ ...step, steps })} globalScope={globalScope} />
          </div>
        </div>
      )
  }
}

function StepList({
  steps,
  onChange,
  globalScope
}: {
  steps: Step[]
  onChange: (s: Step[]) => void
  globalScope: boolean
}): JSX.Element {
  const move = (i: number, d: -1 | 1): void => {
    const j = i + d
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  return (
    <div className="wfe-steps">
      {steps.map((step, i) => (
        <div key={i} className={`wfe-step wfe-step-${step.kind}`}>
          <div className="wfe-step-head">
            <span className="wfe-step-num">{i + 1}</span>
            <span className="wfe-step-kind">{KIND_LABEL[step.kind] ?? step.kind}</span>
            <span className="wfe-step-tools">
              {'on_failure' in step || ['action', 'fill_form', 'extract', 'wait_for', 'assert', 'prompt'].includes(step.kind) ? (
                <FailurePicker
                  value={(step as { on_failure?: WorkflowStepFailure }).on_failure}
                  onChange={(f) => {
                    const next = { ...step } as Step & { on_failure?: WorkflowStepFailure }
                    if (f === undefined) delete next.on_failure
                    else next.on_failure = f
                    onChange(steps.map((s, j) => (j === i ? next : s)))
                  }}
                />
              ) : null}
              <button className="wfe-x" title="Move up" onClick={() => move(i, -1)}>
                ↑
              </button>
              <button className="wfe-x" title="Move down" onClick={() => move(i, 1)}>
                ↓
              </button>
              <button className="wfe-x" title="Delete step" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
                ✕
              </button>
            </span>
          </div>
          <StepBody
            step={step}
            globalScope={globalScope}
            set={(s) => onChange(steps.map((x, j) => (j === i ? s : x)))}
          />
        </div>
      ))}
      <AddStep globalScope={globalScope} onAdd={(s) => onChange([...steps, s])} />
    </div>
  )
}

function ParamsTable({
  params,
  onChange
}: {
  params: WorkflowParam[]
  onChange: (p: WorkflowParam[]) => void
}): JSX.Element {
  return (
    <div className="wfe-params">
      {params.map((p, i) => {
        const multi = /(urls|links|list|items)$/i.test(p.name) || (p.default ?? '').includes('\n')
        const set = (patch: Partial<WorkflowParam>): void =>
          onChange(params.map((x, j) => (j === i ? { ...x, ...patch } : x)))
        return (
          <div className="wfe-row wfe-param" key={i}>
            <Field
              value={p.label ?? p.name}
              width={190}
              onChange={(v) => set({ label: v })}
            />
            <Field
              multiline={multi}
              value={p.default ?? ''}
              placeholder={p.required ? 'asked each run' : 'saved default (optional)'}
              onChange={(v) => set({ default: v || undefined })}
            />
            <Field
              mono
              width={150}
              value={p.name}
              onChange={(v) => set({ name: v.replace(/[^a-z0-9_]/gi, '_').slice(0, 40) })}
            />
            <button className="wfe-x" onClick={() => onChange(params.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        )
      })}
      <button
        className="wfe-add wfe-add-small"
        onClick={() => onChange([...params, { name: `param_${params.length + 1}`, label: 'New detail' }])}
      >
        + detail
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function WorkflowEditor({
  existing,
  tasks,
  onClose
}: {
  existing: Workflow | null
  tasks: Task[]
  onClose: (saved: boolean, runName?: string) => void
}): JSX.Element {
  const activeTask = useStore((s) => s.activeTask)
  const scratchId = useStore((s) => s.scratchTask?.id)
  const spaces = tasks.filter((t) => !t.aiDisabled && t.status === 'active')
  // Default the owner to the space you're in (so "use the open page" works),
  // unless that's the Browse scratchpad — then global.
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [taskId, setTaskId] = useState<string>(
    existing ? (existing.taskId ?? '') : activeTask && !activeTask.aiDisabled && activeTask.id !== scratchId ? activeTask.id : ''
  )
  const [params, setParams] = useState<WorkflowParam[]>(existing?.params ?? [])
  const [steps, setSteps] = useState<Step[]>(existing?.steps ?? [])
  const [ask, setAsk] = useState('')
  const [usePage, setUsePage] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [jsonMode, setJsonMode] = useState(false)
  const [json, setJson] = useState('')
  const hasSteps = steps.length > 0

  async function draft(): Promise<void> {
    setDrafting(true)
    setError(null)
    setWarning(null)
    const res = await window.asit.workflows.draft({
      description: ask,
      taskId: taskId || null,
      usePage: usePage && !!taskId,
      current: hasSteps ? { name, description, params, steps } : undefined
    })
    setDrafting(false)
    if (!res.ok || !res.draft) {
      setError(res.reason ?? 'Drafting failed.')
      return
    }
    if (!existing) setName(res.draft.name)
    setDescription(res.draft.description)
    // Keep defaults the user already typed for params the new draft still uses.
    setParams(
      res.draft.params.map((p) => ({ ...p, default: params.find((o) => o.name === p.name)?.default ?? p.default }))
    )
    setSteps(res.draft.steps)
    setWarning(res.warning ?? null)
    setAsk('')
  }

  async function save(run: boolean): Promise<void> {
    let s = steps
    if (jsonMode) {
      try {
        s = JSON.parse(json) as Step[]
      } catch {
        setError('The steps JSON is not valid.')
        return
      }
    }
    const res = await window.asit.workflows.save({
      name: name.trim(),
      description,
      taskId: taskId || null,
      // A param with a saved default isn't asked for each run.
      params: params.map((p) => ({ ...p, required: !p.default })),
      steps: s
    })
    if (!res.ok) {
      setError(res.reason)
      return
    }
    onClose(true, run ? res.workflow.name : undefined)
  }

  return (
    <div className="wfe">
      <div className="wfe-describe">
        <div className="wfe-describe-head">
          {hasSteps ? 'Describe a change' : 'Describe what to automate'}
        </div>
        <textarea
          className="wfe-ask"
          autoFocus={!existing}
          rows={hasSteps ? 2 : 4}
          placeholder={
            hasSteps
              ? 'e.g. “also add a to-do after each one” or “skip postings that ask for a cover letter”'
              : 'e.g. “For each internship link I paste, open it, apply with my details, write the why-us answer, and ask me before submitting.”'
          }
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ask.trim() && !drafting) void draft()
          }}
        />
        {!hasSteps && (
          <div className="wfe-templates">
            {TEMPLATES.map((t) => (
              <button
                key={t.label}
                className="wfe-template"
                onClick={() => {
                  setAsk(t.text)
                  if (t.page) setUsePage(true)
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="wfe-row wfe-describe-foot">
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} title="Which space's agent and pages it uses">
            <option value="">Global — no AI steps</option>
            {spaces.map((t) => (
              <option key={t.id} value={t.id}>
                Space: {t.title}
              </option>
            ))}
          </select>
          <label className="wfe-check" title={taskId ? '' : 'Pick a space first — its open page is read'}>
            <input type="checkbox" disabled={!taskId} checked={usePage && !!taskId} onChange={(e) => setUsePage(e.target.checked)} />
            Use the form open in this space
          </label>
          <button className="btn btn-primary" disabled={!ask.trim() || drafting} onClick={() => void draft()}>
            {drafting ? 'Drafting…' : hasSteps ? '✦ Revise' : '✦ Draft it'}
          </button>
        </div>
      </div>

      {(hasSteps || existing || jsonMode) && (
        <>
          <div className="wfe-row">
            <Field label="name" value={name} width={240} placeholder="apply-to-internships" onChange={(v) => setName(v.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
            <Field label="what it does" value={description} onChange={setDescription} />
          </div>

          <div className="wfe-section">
            <div className="wfe-section-head">
              Your details <span>— saved values are reused every run; blank ones are asked for</span>
            </div>
            <ParamsTable params={params} onChange={setParams} />
          </div>

          <div className="wfe-section">
            <div className="wfe-section-head">
              Steps
              <button
                className="wfe-json-toggle"
                onClick={() => {
                  if (jsonMode) {
                    try {
                      setSteps(JSON.parse(json) as Step[])
                      setJsonMode(false)
                    } catch {
                      setError('The steps JSON is not valid.')
                    }
                  } else {
                    setJson(JSON.stringify(steps, null, 2))
                    setJsonMode(true)
                  }
                }}
              >
                {jsonMode ? 'Back to cards' : 'Edit as JSON'}
              </button>
            </div>
            {jsonMode ? (
              <textarea className="wfe-json" rows={18} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} />
            ) : (
              <StepList steps={steps} onChange={setSteps} globalScope={!taskId} />
            )}
          </div>
        </>
      )}

      {warning && <p className="wfe-warning">Still needs a fix before it can save: {warning}</p>}
      {error && <p className="wfe-error">{error}</p>}
      <div className="wfe-row wfe-actions">
        <button className="btn btn-primary" disabled={!name.trim() || (!hasSteps && !jsonMode)} onClick={() => void save(false)}>
          Save
        </button>
        <button className="btn" disabled={!name.trim() || (!hasSteps && !jsonMode)} onClick={() => void save(true)}>
          Save &amp; run
        </button>
        <button className="btn btn-ghost" onClick={() => onClose(false)}>
          Cancel
        </button>
        {!hasSteps && !existing && !jsonMode && (
          <button className="btn btn-ghost" onClick={() => setSteps([blank('action')])}>
            Build it by hand instead
          </button>
        )}
      </div>
    </div>
  )
}
