import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import type { Resource, Task } from '@shared/types'
import ReviewCards from '../components/ReviewCards'
import QuestionsModal from '../components/QuestionsModal'
import ActivityGraph from '../components/ActivityGraph'
import TodoList from '../components/TodoList'
import StatusCluster from '../components/StatusCluster'
import { IPC } from '@shared/ipc-contract'
import ScratchBrowser, { type ScratchBrowserApi } from '../components/ScratchBrowser'
import NotesEditor from '../components/NotesEditor'
import ChatPanel from '../components/ChatPanel'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher'
import { useOverlay } from '../hooks/useOverlay'
import { fmtCost } from '../utils/fmt'
import { reliablyInto } from '../lib/reliably'

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
        <button className="btn btn-ghost" onClick={onClose}> Close
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
          <button className="btn btn-primary" onClick={onClose}> Done
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Home(): JSX.Element {
  const tasks = useStore((s) => s.tasks)
  const tasksLoaded = useStore((s) => s.tasksLoaded)
  const loadTasks = useStore((s) => s.loadTasks)
  const openTask = useStore((s) => s.openTask)
  const startFocus = useStore((s) => s.startFocus)
  const studyEnabled = useStore((s) => s.settings?.studyEnabled ?? true)
  const [showTodos, setShowTodos] = useState(true)

  const [sideCollapsed, setSideCollapsed] = useState(
    () => localStorage.getItem('asit-side-collapsed') === '1'
  )
  const [stats, setStats] = useState<HomeStats | null>(null)
  const [aiUsage, setAiUsage] = useState<{
    week: { costUsd: number }
    costByTask: Record<string, number>
  } | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  // The modal itself is mounted in App.tsx (so Ctrl+, works everywhere);
  // Home only needs to be able to open it.
  const setShowSettings = useStore((s) => s.setSettingsOpen)
  const [showActivity, setShowActivity] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const [dueCount, setDueCount] = useState(0)
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)

  // The click-away backdrop is DOM, and pages paint above DOM — a click into
  // the browser area never reaches it. Close the ⋯ menu when a pane takes
  // focus (that's what "clicked elsewhere" means here).
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      if ((args[0] as { type: string }).type === 'pane-focused') setMenuTaskId(null)
    })
  }, [])
  const [questionsTask, setQuestionsTask] = useState<Task | null>(null)
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState(2)
  const [dueDate, setDueDate] = useState('')
  const [createPrivate, setCreatePrivate] = useState(false)

  // Scratchpad workspace state
  const [scratch, setScratch] = useState<Task | null>(null)
  const [scratchResources, setScratchResources] = useState<Resource[]>([])
  const chatOpen = useStore((s) => s.chatOpen)
  const setChatOpen = (v: boolean): void => useStore.setState({ chatOpen: v })
  const notesOpen = useStore((s) => s.scratchNotesOpen)
  const setNotesOpen = (v: boolean): void => useStore.setState({ scratchNotesOpen: v })
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
    reliablyInto('stats', () => window.asit.tasks.stats(), setStats)
    reliablyInto('usage', () => window.asit.usage.summary(), setAiUsage)
    // Study tools off ⇒ dueCount stays 0, which hides every review surface
    // (banner, mini button, badges) without touching any data.
    if (studyEnabled) {
      reliablyInto('review queue', () => window.asit.questions.due(50), (due) => setDueCount(due.length))
    } else {
      setDueCount(0)
    }
  }, [tasks, studyEnabled])

  const refreshScratchResources = useCallback(async (): Promise<void> => {
    if (!scratch) return
    setScratchResources(await window.asit.resources.list(scratch.id))
  }, [scratch])

  // Claude-driven app actions on the scratchpad: open a url resource → new
  // browser tab; PDFs open via file: url; notes toggles the notes panel.
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const p = args[0] as { type: string; id?: string; url?: string; owner?: string }
      if (p.type === 'open-url-tab' && p.url) {
        // Ctrl/middle-click or "open link in new tab" from a scratchpad page.
        // This was only handled in the workspace, so on Home it did nothing.
        if (!p.owner || p.owner === scratch?.id) browserApi.current?.openTab(p.url)
      } else if (p.type === 'open-resource' && p.id) {
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
  }, [refreshScratchResources, loadTasks, scratchResources, scratch?.id])

  const dueByTask = studyEnabled ? (stats?.dueByTask ?? {}) : {}
  const active = tasks
    .filter((t) => t.status === 'active')
    .sort((a, b) => score(b, dueByTask[b.id] ?? 0) - score(a, dueByTask[a.id] ?? 0))
  const done = tasks.filter((t) => t.status === 'done')

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!title.trim()) return
    try {
      await window.asit.tasks.create({
        title: title.trim(),
        priority,
        dueDate: dueDate || null,
        aiDisabled: createPrivate
      })
    } catch (err) {
      // Folder creation can fail (OneDrive, permissions) — the form used to
      // just sit there, still filled, with no explanation.
      useStore
        .getState()
        .pushNotice(
          `Couldn't create the workspace — ${err instanceof Error ? err.message : String(err)}`,
          'error'
        )
      return
    }
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
    // Open browser tabs become the session's resources (rail visibility);
    // the tabs THEMSELVES travel via the scratch layout_json handoff in
    // scratchSave — flush the debounced layout write first or it reads stale.
    const tabs = browserApi.current?.currentTabs() ?? []
    const existingUrls = new Set(scratchResources.map((r) => r.url))
    for (const tab of tabs) {
      if (/^https?:/i.test(tab.url) && !existingUrls.has(tab.url)) {
        await window.asit.resources.addUrl(scratch.id, tab.title.slice(0, 60), tab.url)
      }
    }
    await browserApi.current?.flushLayout()
    await window.asit.panes.closeAll()
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
                ⚿
              </span>
            )}
            {task.coding && (
              <span className="badge" title="Coding task — chat is a coding agent (Fable 5)">
                ⌗
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
                {studyEnabled && (
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
                  </>
                )}
                <button onClick={() => { setMenuTaskId(null); openTask(task.id) }}> Open workspace
                </button>
              </>
            )}
            {studyEnabled && (
              <button onClick={() => { setMenuTaskId(null); setQuestionsTask(task) }}>
                ❓ Manage questions
              </button>
            )}
            <button
              onClick={() => {
                setMenuTaskId(null)
                // The folder IS the workspace (notes, PDFs, AI context) — it
                // was the app's central concept with no way to reach it.
                void window.asit.resources.openExternal({ filePath: task.folderPath })
              }}
            >
              📁 Open folder in Explorer
            </button>
            {!task.aiDisabled && (
              <button
                title={
                  task.coding
                    ? undefined
                    : 'Coding chats can run terminal commands with YOUR full user permissions — treat this workspace as fully trusted'
                }
                onClick={async () => {
                  setMenuTaskId(null)
                  if (
                    !task.coding &&
                    !window.confirm(
                      'Coding mode gives this workspace’s chat a real terminal (Bash) with your full user permissions — it can touch files outside this workspace, including private ones. Only use it for work you’d run in a terminal yourself.\n\nEnable coding mode?'
                    )
                  )
                    return
                  await window.asit.tasks.setCoding(task.id, !task.coding)
                  await loadTasks()
                }}
              >
                {task.coding ? '📖 Switch to standard mode' : '⌗ Make coding workspace'}
              </button>
            )}
            {!task.aiDisabled && (
              <button
                title="Lets this workspace's chat READ its terminal output (e.g. why a build failed). It can never type into the terminal — there is no such capability in the app."
                onClick={async () => {
                  setMenuTaskId(null)
                  await window.asit.tasks.setTerminalAiRead(task.id, !task.terminalAiRead)
                  await loadTasks()
                }}
              >
                {task.terminalAiRead ? '⊘ Stop AI reading terminal' : '◉ Let AI read terminal'}
              </button>
            )}
            <button onClick={() => { setMenuTaskId(null); togglePrivacy(task) }}>
              {task.aiDisabled ? '＋ Enable AI' : '⚿ Make private (no AI)'}
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
        <WorkspaceSwitcher />
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
            <button className="btn btn-primary" type="submit" disabled={!sessionName.trim()}> Save
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setSaving(false)}> Cancel
            </button>
          </form>
        ) : (
          <button
            className="btn"
            title="Turn the open tabs, notes, and chats into a named task"
            onClick={() => setSaving(true)}
          >
            ↧ Save session
          </button>
        )}
        <span className="scratch-hint">browse freely — save the session when it becomes a workspace</span>
        <StatusCluster />
        <button
          className={`btn btn-ghost chat-toggle ${notesOpen ? 'chat-toggle-on' : ''}`}
          title="Session notes"
          onClick={() => setNotesOpen(!notesOpen)}
        >
          ✎
        </button>
        <button
          className={`btn btn-ghost chat-toggle ${chatOpen ? 'chat-toggle-on' : ''}`}
          title="AI chat (sees your open tabs)"
          onClick={() => setChatOpen(!chatOpen)}
        >
          ▭
        </button>
      </header>
      <div className="workspace-body">
        {scratch && (
          <>
            <ScratchBrowser
              task={scratch}
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
          <span className="logo-mark" title="ASIT"> A
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
              ◎
            </button>
          )}
          <button className="btn btn-ghost" title="Settings" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
        </aside>
        {renderMain()}
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
            <button
              className="btn btn-ghost"
              title="Automations — workflows & schedules (Ctrl+Shift+A)"
              onClick={() => useStore.getState().setAutomationsOpen(true)}
            >
              ⚡
            </button>
            <button className="btn btn-ghost" title="Activity & usage" onClick={() => setShowActivity(true)}>
              ▦
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
            ◎ {dueCount} question{dueCount === 1 ? '' : 's'} due — review now
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
              ⚿ Private — no AI on this task
            </label>
            <div className="form-row">
              <button className="btn btn-primary" type="submit"> Create
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowCreate(false)}> Cancel
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
          {active.length === 0 && tasksLoaded && (
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
          {showTodos && <TodoList onOpenUrl={(url) => browserApi.current?.openTab(url)} />}
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
      {showActivity && <ActivityModal onClose={() => setShowActivity(false)} />}
      {showReview && <ReviewOverlay onClose={() => setShowReview(false)} />}
      {questionsTask && (
        <QuestionsModal task={questionsTask} onClose={() => setQuestionsTask(null)} />
      )}
    </div>
  )
}
