import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { Resource, Task } from '@shared/types'
import ReviewCards from '../components/ReviewCards'
import SettingsModal from '../components/SettingsModal'
import QuestionsModal from '../components/QuestionsModal'
import ActivityGraph from '../components/ActivityGraph'
import TodoList from '../components/TodoList'
import StatusCluster from '../components/StatusCluster'
import { IPC } from '@shared/ipc-contract'
import ScratchBrowser, { type ScratchBrowserApi } from '../components/ScratchBrowser'
import NotesEditor from '../components/NotesEditor'
import ChatPanel from '../components/ChatPanel'
import { useOverlay } from '../hooks/useOverlay'
import { fmtCost } from '../utils/fmt'

const PRIORITY_LABEL: Record<number, string> = { 1: 'High', 2: 'Normal', 3: 'Low' }

interface HomeStats {
  dueByTask: Record<string, number>
  focusSecToday: number
  focusSecWeek: number
}

function daysUntil(dueDate: string): number {
  const due = new Date(dueDate + 'T23:59:59')
  return Math.ceil((due.getTime() - Date.now()) / 86400000)
}

function dueLabel(task: Task): { text: string; overdue: boolean } | null {
  if (!task.dueDate) return null
  const days = daysUntil(task.dueDate)
  if (days < 0) return { text: `${-days}d overdue`, overdue: true }
  if (days === 0) return { text: 'due today', overdue: true }
  if (days === 1) return { text: 'due tomorrow', overdue: false }
  return { text: `due in ${days}d`, overdue: false }
}

function score(task: Task, dueQuestions: number): number {
  let s = 0
  if (task.dueDate) {
    const days = daysUntil(task.dueDate)
    if (days < 0) s += 1000 + Math.min(10, -days) * 10
    else if (days === 0) s += 500
    else s += Math.max(0, 200 - days * 25)
  }
  s += Math.min(50, dueQuestions * 5)
  s += (4 - task.priority) * 50
  const staleDays = task.lastOpenedAt
    ? (Date.now() - new Date(task.lastOpenedAt).getTime()) / 86400000
    : 3
  s += Math.min(20, staleDays * 2)
  return s
}

function fmtHours(sec: number): string {
  if (sec < 60) return '0m'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function ReviewOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  useOverlay(true)
  return (
    <div className="lockdown-overlay" onClick={onClose}>
      <div className="break-review" onClick={(e) => e.stopPropagation()}>
        <div className="break-review-head">
          <h2>Quick recall</h2>
        </div>
        <ReviewCards onDone={onClose} />
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

function ActivityModal({ onClose }: { onClose: () => void }): JSX.Element {
  useOverlay(true)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card activity-modal" onClick={(e) => e.stopPropagation()}>
        <ActivityGraph />
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Home(): JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const loadTasks = useStore((s) => s.loadTasks)
  const openTask = useStore((s) => s.openTask)
  const startFocus = useStore((s) => s.startFocus)
  const setAssistantRecall = useStore((s) => s.setAssistantRecall)
  const [assistantHistory, setAssistantHistory] = useState<
    { id: string; prompt: string; reply: string }[]
  >([])
  const [showQuickChats, setShowQuickChats] = useState(false)
  const [showTodos, setShowTodos] = useState(true)

  useEffect(() => {
    window.asit.assistant.history(15).then(setAssistantHistory)
  }, [showQuickChats])

  const [sideCollapsed, setSideCollapsed] = useState(
    () => localStorage.getItem('asit-side-collapsed') === '1'
  )
  const [stats, setStats] = useState<HomeStats | null>(null)
  const [aiUsage, setAiUsage] = useState<{
    week: { costUsd: number }
    costByTask: Record<string, number>
  } | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [dueCount, setDueCount] = useState(0)
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)
  const [questionsTask, setQuestionsTask] = useState<Task | null>(null)
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState(2)
  const [dueDate, setDueDate] = useState('')
  const [createPrivate, setCreatePrivate] = useState(false)

  // Scratchpad workspace state
  const [scratch, setScratch] = useState<Task | null>(null)
  const [scratchResources, setScratchResources] = useState<Resource[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const browserApi = useRef<ScratchBrowserApi | null>(null)

  const loadScratch = useCallback(async (): Promise<void> => {
    const result = await window.asit.tasks.scratchGet()
    setScratch(result.task)
    setScratchResources(result.resources)
  }, [])

  useEffect(() => {
    loadScratch()
    // Leaving Home parks the scratchpad's panes (alive, no reload on return).
    return () => {
      window.asit.panes.park()
    }
  }, [loadScratch])

  useEffect(() => {
    window.asit.tasks.stats().then(setStats)
    window.asit.usage.summary().then(setAiUsage)
    window.asit.questions.due(50).then((due) => setDueCount(due.length))
  }, [tasks])

  const refreshScratchResources = useCallback(async (): Promise<void> => {
    if (!scratch) return
    setScratchResources(await window.asit.resources.list(scratch.id))
  }, [scratch])

  // Claude-driven app actions on the scratchpad: open a url resource → new
  // browser tab; PDFs open via file: url; notes toggles the notes panel.
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const p = args[0] as { type: string; id?: string }
      if (p.type === 'open-resource' && p.id) {
        if (p.id === 'builtin-notes') {
          setNotesOpen(true)
          return
        }
        const r = scratchResources.find((res) => res.id === p.id)
        if (r?.url) browserApi.current?.openTab(r.url)
        else if (r?.filePath) {
          browserApi.current?.openTab(`file:///${encodeURI(r.filePath.replace(/\\/g, '/'))}`)
        }
      } else if (p.type === 'resources-changed') {
        refreshScratchResources()
      } else if (p.type === 'task-updated') {
        loadTasks()
      }
    })
  }, [refreshScratchResources, loadTasks, scratchResources])

  const dueByTask = stats?.dueByTask ?? {}
  const active = tasks
    .filter((t) => t.status === 'active')
    .sort((a, b) => score(b, dueByTask[b.id] ?? 0) - score(a, dueByTask[a.id] ?? 0))
  const done = tasks.filter((t) => t.status === 'done')

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!title.trim()) return
    await window.asit.tasks.create({
      title: title.trim(),
      priority,
      dueDate: dueDate || null,
      aiDisabled: createPrivate
    })
    setTitle('')
    setPriority(2)
    setDueDate('')
    setCreatePrivate(false)
    setShowCreate(false)
    await loadTasks()
  }

  async function togglePrivacy(task: Task): Promise<void> {
    if (
      !task.aiDisabled &&
      !confirm(
        `Make "${task.title}" private?\n\nAI chat, question generation, and the assistant will be fully disabled for it, and its folder moves outside the AI-readable directory. You can re-enable AI later.`
      )
    )
      return
    await window.asit.tasks.setPrivacy(task.id, !task.aiDisabled)
    await loadTasks()
  }

  async function handleDelete(task: Task): Promise<void> {
    if (!confirm(`Delete "${task.title}"? Its files move to the .trash folder, not deleted.`))
      return
    await window.asit.tasks.delete(task.id)
    await loadTasks()
  }

  async function handleMarkDone(task: Task): Promise<void> {
    await window.asit.tasks.update(task.id, { status: task.status === 'done' ? 'active' : 'done' })
    await loadTasks()
  }

  async function handleSaveSession(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const name = sessionName.trim()
    if (!name || !scratch) return
    // Open browser tabs become the session's resources.
    const tabs = browserApi.current?.currentTabs() ?? []
    const existingUrls = new Set(scratchResources.map((r) => r.url))
    for (const tab of tabs) {
      if (/^https?:/i.test(tab.url) && !existingUrls.has(tab.url)) {
        await window.asit.resources.addUrl(scratch.id, tab.title.slice(0, 60), tab.url)
      }
    }
    await window.asit.panes.closeAll()
    localStorage.removeItem('asit-scratch-tabs')
    await window.asit.tasks.scratchSave(name)
    setSessionName('')
    setSaving(false)
    await loadTasks()
    await loadScratch()
    location.reload() // fresh browser + clean pane state after the handoff
  }

  function renderTaskRow(task: Task, isTop: boolean): JSX.Element {
    const due = dueLabel(task)
    const dueQ = dueByTask[task.id] ?? 0
    const cost = aiUsage?.costByTask[task.id] ?? 0
    return (
      <div key={task.id} className={`side-task ${isTop ? 'side-task-top' : ''} ${task.status === 'done' ? 'task-done' : ''}`}>
        <div
          className="side-task-main"
          role="button"
          tabIndex={0}
          onClick={() => openTask(task.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openTask(task.id)
            }
          }}
        >
          <span className="task-title">{task.title}</span>
          <span className="side-task-meta">
            {task.aiDisabled && (
              <span className="badge" title="Private — AI disabled">
                🔒
              </span>
            )}
            {task.coding && (
              <span className="badge" title="Coding task — chat is a coding agent (Fable 5)">
                ⌨
              </span>
            )}
            {isTop && <span className="badge badge-accent">start here</span>}
            {task.priority !== 2 && (
              <span className={`badge prio-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
            )}
            {due && <span className={`badge ${due.overdue ? 'badge-danger' : ''}`}>{due.text}</span>}
            {dueQ > 0 && <span className="badge">{dueQ} rev</span>}
            {cost >= 0.005 && <span className="badge badge-cost">{fmtCost(cost)}</span>}
          </span>
        </div>
        <button
          className="btn btn-ghost task-menu-btn"
          onClick={(e) => {
            e.stopPropagation()
            setMenuTaskId(menuTaskId === task.id ? null : task.id)
          }}
        >
          ⋯
        </button>
        {menuTaskId === task.id && (
          <div className="task-menu" onClick={(e) => e.stopPropagation()}>
            {task.status === 'active' && (
              <>
                <button onClick={() => { setMenuTaskId(null); startFocus(task.id) }}>
                  ▶ Focus (stopwatch)
                </button>
                <button
                  onClick={async () => {
                    setMenuTaskId(null)
                    await openTask(task.id)
                    await window.asit.session.start(task.id, 'pomodoro')
                  }}
                >
                  ⏱ Focus with timer
                </button>
                <button onClick={() => { setMenuTaskId(null); openTask(task.id) }}>
                  Open workspace
                </button>
              </>
            )}
            <button onClick={() => { setMenuTaskId(null); setQuestionsTask(task) }}>
              ❓ Manage questions
            </button>
            {!task.aiDisabled && (
              <button
                onClick={async () => {
                  setMenuTaskId(null)
                  await window.asit.tasks.setCoding(task.id, !task.coding)
                  await loadTasks()
                }}
              >
                {task.coding ? '📖 Switch to study mode' : '⌨ Make coding workspace'}
              </button>
            )}
            <button onClick={() => { setMenuTaskId(null); togglePrivacy(task) }}>
              {task.aiDisabled ? '✨ Enable AI' : '🔒 Make private (no AI)'}
            </button>
            <button onClick={() => { setMenuTaskId(null); handleMarkDone(task) }}>
              {task.status === 'done' ? '↩ Reopen' : '✓ Mark done'}
            </button>
            <button className="menu-danger" onClick={() => { setMenuTaskId(null); handleDelete(task) }}>
              🗑 Delete workspace
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderMain = (): JSX.Element => (
    <main className="home-main">
      <header className="workspace-header browser-header">
        {saving ? (
          <form className="save-session-form" onSubmit={handleSaveSession}>
            <input
              autoFocus
              placeholder="Name this session…"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSaving(false)
              }}
            />
            <button className="btn btn-primary" type="submit" disabled={!sessionName.trim()}>
              Save
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setSaving(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            className="btn"
            title="Turn the open tabs, notes, and chats into a named task"
            onClick={() => setSaving(true)}
          >
            💾 Save session
          </button>
        )}
        <span className="scratch-hint">browse freely — save the session when it becomes a workspace</span>
        <StatusCluster />
        <button
          className={`btn btn-ghost chat-toggle ${notesOpen ? 'chat-toggle-on' : ''}`}
          title="Session notes"
          onClick={() => setNotesOpen((v) => !v)}
        >
          📝
        </button>
        <button
          className={`btn btn-ghost chat-toggle ${chatOpen ? 'chat-toggle-on' : ''}`}
          title="AI chat (sees your open tabs)"
          onClick={() => setChatOpen((v) => !v)}
        >
          💬
        </button>
      </header>
      <div className="workspace-body">
        {scratch && (
          <>
            <ScratchBrowser
              ownerId={scratch.id}
              onApi={(api) => {
                browserApi.current = api
              }}
              onPin={async (t, url) => {
                await window.asit.resources.addUrl(scratch.id, t.slice(0, 60), url)
                await refreshScratchResources()
              }}
            />
            {notesOpen && (
              <div className="side-panel" data-focus-zone="Notes">
                <NotesEditor
                  filePath={`${scratch.folderPath}\\notes.md`}
                  task={scratch}
                  resources={scratchResources}
                />
              </div>
            )}
            {chatOpen && (
              <div className="side-panel">
                <ChatPanel task={scratch} />
              </div>
            )}
          </>
        )}
      </div>
    </main>
  )

  function toggleSidebar(): void {
    setSideCollapsed((prev) => {
      localStorage.setItem('asit-side-collapsed', prev ? '0' : '1')
      return !prev
    })
  }

  if (sideCollapsed) {
    return (
      <div className="home2">
        <aside className="home-side home-side-mini">
          <span className="logo-mark" title="ASIT">
            A
          </span>
          <button className="btn btn-ghost" title="Show tasks" onClick={toggleSidebar}>
            »
          </button>
          {dueCount > 0 && (
            <button
              className="btn btn-ghost mini-due"
              title={`${dueCount} questions due — review`}
              onClick={() => setShowReview(true)}
            >
              🧠
            </button>
          )}
          <button className="btn btn-ghost" title="Settings" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
        </aside>
        {renderMain()}
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
        {showReview && <ReviewOverlay onClose={() => setShowReview(false)} />}
      </div>
    )
  }

  return (
    <div className="home2">
      <aside className="home-side" data-focus-zone="Workspaces">
        <div className="side-header">
          <span className="logo">
            <span className="logo-mark">A</span>
            <span className="logo-text">asit</span>
          </span>
          <span className="side-header-actions">
            <button className="btn btn-ghost" title="Activity & usage" onClick={() => setShowActivity(true)}>
              📊
            </button>
            <button className="btn btn-ghost" title="Settings" onClick={() => setShowSettings(true)}>
              ⚙
            </button>
            <button className="btn btn-ghost" title="Hide tasks sidebar" onClick={toggleSidebar}>
              «
            </button>
          </span>
        </div>

        {dueCount > 0 && (
          <button className="review-banner" onClick={() => setShowReview(true)}>
            🧠 {dueCount} question{dueCount === 1 ? '' : 's'} due — review now
          </button>
        )}

        {showCreate ? (
          <form className="side-create card" onSubmit={handleCreate}>
            <input
              autoFocus
              placeholder="Workspace name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div className="form-row">
              <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                <option value={1}>High</option>
                <option value={2}>Normal</option>
                <option value={3}>Low</option>
              </select>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <label className="private-check" title="No chat, no question generation, invisible to the AI — its folder lives outside the AI-readable directory">
              <input
                type="checkbox"
                checked={createPrivate}
                onChange={(e) => setCreatePrivate(e.target.checked)}
              />
              🔒 Private — no AI on this task
            </label>
            <div className="form-row">
              <button className="btn btn-primary" type="submit">
                Create
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className="btn side-new" onClick={() => setShowCreate(true)}>
            + New workspace
          </button>
        )}

        <div
          className="side-tasks"
          data-focus-body
          onKeyDown={(e) => {
            // ↑/↓ walk the list; Tab leaves the sidebar entirely.
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.side-task-main')]
            const i = rows.indexOf(document.activeElement as HTMLElement)
            if (i === -1) return
            e.preventDefault()
            rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
          }}
        >
          {active.length === 0 && (
            <p className="empty">No workspaces yet — browse in the scratchpad, then save your session.</p>
          )}
          {active.map((t, i) => renderTaskRow(t, i === 0))}
          {done.length > 0 && <div className="side-section-label">Done</div>}
          {done.map((t) => renderTaskRow(t, false))}
        </div>

        <div className="quick-chats todo-section">
          <button className="quick-chats-toggle" onClick={() => setShowTodos((v) => !v)}>
            ☑ To-dos {showTodos ? '▾' : '▸'}
          </button>
          {showTodos && <TodoList />}
        </div>

        <div className="quick-chats">
          <button className="quick-chats-toggle" onClick={() => setShowQuickChats((v) => !v)}>
            ⚡ Quick chats {showQuickChats ? '▾' : '▸'}
          </button>
          {showQuickChats &&
            (assistantHistory.length === 0 ? (
              <p className="quick-chats-empty">No quick chats yet — ask something in the ⚡ bar.</p>
            ) : (
              assistantHistory.map((h) => (
                <button
                  key={h.id}
                  className="quick-chat-item"
                  title={h.prompt}
                  onClick={() => setAssistantRecall({ prompt: h.prompt, reply: h.reply })}
                >
                  {h.prompt.replace(/\s+/g, ' ').slice(0, 48)}
                </button>
              ))
            ))}
        </div>

        {stats && (
          <div className="side-footer" title="Focused time · AI usage this week">
            {fmtHours(stats.focusSecToday)} today · {fmtHours(stats.focusSecWeek)} wk
            {aiUsage && ` · AI ${fmtCost(aiUsage.week.costUsd)}`}
          </div>
        )}
      </aside>

      {renderMain()}

      {menuTaskId && <div className="menu-backdrop" onClick={() => setMenuTaskId(null)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showActivity && <ActivityModal onClose={() => setShowActivity(false)} />}
      {showReview && <ReviewOverlay onClose={() => setShowReview(false)} />}
      {questionsTask && (
        <QuestionsModal task={questionsTask} onClose={() => setQuestionsTask(null)} />
      )}
    </div>
  )
}
