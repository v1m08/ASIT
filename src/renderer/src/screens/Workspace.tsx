import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from '../store/useStore'
import PaneGrid, { BUILTIN_NOTES, type PaneGridApi } from '../components/PaneGrid'
import ResourceRail from '../components/ResourceRail'
import ChatPanel from '../components/ChatPanel'
import TimerBar, { useTimerState } from '../components/TimerBar'
import BreakReview from '../components/BreakReview'
import StatusCluster from '../components/StatusCluster'

export default function Workspace(): JSX.Element {
  const task = useStore((s) => s.activeTask)
  const resources = useStore((s) => s.activeResources)
  const setActiveResources = useStore((s) => s.setActiveResources)
  const goHome = useStore((s) => s.goHome)
  const gridApi = useRef<PaneGridApi | null>(null)
  const chatOpen = useStore((s) => s.chatOpen)
  const setChatOpen = (v: boolean | ((p: boolean) => boolean)): void =>
    useStore.setState((st) => ({ chatOpen: typeof v === 'function' ? v(st.chatOpen) : v }))
  // Chat can never starve the pane area: cap at what the window affords
  // (rail + panes need ~620px), re-clamped on every window resize.
  const clampChatWidth = (w: number): number => Math.max(280, Math.min(560, window.innerWidth - 620, w))
  const [chatWidth, setChatWidth] = useState(() =>
    clampChatWidth(Number(localStorage.getItem('asit-chat-width')) || 360)
  )

  useEffect(() => {
    const onResize = (): void => setChatWidth((w) => clampChatWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const refreshResources = useCallback(async (): Promise<void> => {
    if (!task) return
    setActiveResources(await window.asit.resources.list(task.id))
  }, [task, setActiveResources])

  // Claude-driven app actions (via .asit/actions.ndjson → main → here).
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const p = args[0] as { type: string; id?: string; url?: string; owner?: string }
      if (p.type === 'open-url-tab' && p.url) {
        // Only the workspace that owns the pane the link came from.
        if (!p.owner || p.owner === task?.id) gridApi.current?.openUrl(p.url)
      } else if (p.type === 'open-resource' && p.id) {
        gridApi.current?.openResource(p.id === 'builtin-notes' ? BUILTIN_NOTES : p.id)
      } else if (p.type === 'resources-changed') {
        refreshResources()
      } else if (p.type === 'task-updated') {
        useStore.getState().loadTasks()
      }
    })
  }, [refreshResources, task?.id])

  // Deep link (to-do or a notes link → file). Keyed on the pending id, not the
  // task: links that point INSIDE the workspace you're already in must work
  // too, and there the task id never changes.
  const pendingResourceId = useStore((s) => s.pendingResourceId)
  useEffect(() => {
    if (!pendingResourceId) return
    const id = useStore.getState().consumePendingResource()
    if (!id) return
    const open = (): void => gridApi.current?.openResource(id === 'builtin-notes' ? BUILTIN_NOTES : id)
    if (gridApi.current) {
      open()
      return
    }
    // Grid still mounting (task switch + cold lazy chunk can exceed any single
    // delay) — retry until it appears, bounded.
    let tries = 0
    const t = setInterval(() => {
      if (gridApi.current || ++tries > 20) {
        clearInterval(t)
        open()
      }
    }, 150)
    return () => clearInterval(t)
  }, [pendingResourceId])

  const handleGoHome = useCallback(async (): Promise<void> => {
    // Park (hide, keep alive) — pages don't reload when you come back.
    await window.asit.panes.park()
    goHome()
  }, [goHome])

  if (!task) return <div />

  return (
    <div className="workspace">
      <header className="workspace-header">
        <button className="btn btn-ghost" onClick={handleGoHome}>
          ← Home
        </button>
        <span className="workspace-title">
          {task.aiDisabled && (
            <span title="Private — AI disabled for this task" className="private-lock">
              ⚿{' '}
            </span>
          )}
          {task.title}
        </span>
        <TimerBar task={task} />
        <StatusCluster />
        {!task.aiDisabled && (
          <button
            className={`btn btn-ghost chat-toggle ${chatOpen ? 'chat-toggle-on' : ''}`}
            onClick={() => setChatOpen((v) => !v)}
          >
            ▭ Chat
          </button>
        )}
      </header>
      <div className="workspace-body">
        <ResourceRail
          task={task}
          resources={resources}
          onOpen={(id) => gridApi.current?.openResource(id)}
          onSearch={(q) => gridApi.current?.openSearch(q)}
          onResourcesChanged={refreshResources}
        />
        <PaneGrid
          key={task.id}
          task={task}
          resources={resources}
          onApi={(api) => {
            gridApi.current = api
          }}
          onPin={async (title, url) => {
            await window.asit.resources.addUrl(task.id, title.slice(0, 60), url)
            await refreshResources()
          }}
          onAttachLibrary={async (name) => {
            const r = await window.asit.library.attach(task.id, name)
            if (r) await refreshResources()
            return r
          }}
        />
        {chatOpen && !task.aiDisabled && (
          <>
            <div
              className="divider"
              title="Drag to resize chat"
              onPointerDown={(e) => {
                e.preventDefault()
                window.asit.panes.setVisible(null, false)
                const onMove = (ev: PointerEvent): void => {
                  setChatWidth(clampChatWidth(window.innerWidth - ev.clientX))
                }
                const onUp = (): void => {
                  window.removeEventListener('pointermove', onMove)
                  window.removeEventListener('pointerup', onUp)
                  window.removeEventListener('pointercancel', onUp)
                  window.asit.panes.setVisible(null, true)
                  setChatWidth((w) => {
                    localStorage.setItem('asit-chat-width', String(w))
                    return w
                  })
                }
                window.addEventListener('pointermove', onMove)
                window.addEventListener('pointerup', onUp)
                window.addEventListener('pointercancel', onUp)
              }}
            />
            <div style={{ width: chatWidth, display: 'flex', flexShrink: 0 }}>
              <ChatPanel task={task} />
            </div>
          </>
        )}
      </div>
      <BreakReviewGate taskId={task.id} />
    </div>
  )
}

// Isolates the 1-per-second SESSION_TICK subscription: with it inlined,
// the ENTIRE workspace tree (rail, grid, every chat message) re-rendered
// every second for the whole focus session.
function BreakReviewGate({ taskId }: { taskId: string }): JSX.Element | null {
  const timerState = useTimerState()
  const [dismissed, setDismissed] = useState(false)
  const onBreak = timerState?.phase === 'break'
  useEffect(() => {
    if (onBreak) setDismissed(false)
  }, [onBreak])
  if (!onBreak || dismissed || !timerState) return null
  return (
    <BreakReview taskId={taskId} remainingSec={timerState.remainingSec} onClose={() => setDismissed(true)} />
  )
}
