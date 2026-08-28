import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from '../store/useStore'
import PaneGrid, { BUILTIN_NOTES, type PaneGridApi } from '../components/PaneGrid'
import ResourceRail from '../components/ResourceRail'
import ChatPanel from '../components/ChatPanel'
import TimerBar, { useTimerState } from '../components/TimerBar'
import BreakReview from '../components/BreakReview'
import StatusCluster from '../components/StatusCluster'
import GroupBar from '../browser/GroupBar'
import SigninHandoff from '../browser/SigninHandoff'

// THE shell. One screen, always a browser.
//
// This replaced a home/workspace split in which the two halves of the app had
// separate tab systems, separate chrome and separate shortcuts — so switching
// context meant losing your tabs, and half the browser keys did nothing
// depending on where you happened to be. Now there is a single tab surface
// (PaneGrid) and a single set of chrome, and a "workspace" is just which tab
// GROUP the surface is currently showing (see GroupBar).
//
// The rail and the chat are per-group panels of the same shell rather than
// screens of their own, because they are scoped to the group: the rail holds
// what this group has open, and the chat is the agent that can see this
// group's folder and drive this group's panes (invariant 6).

export default function Shell(): JSX.Element {
  const task = useStore((s) => s.activeTask)
  const resources = useStore((s) => s.activeResources)
  const setActiveResources = useStore((s) => s.setActiveResources)
  const gridApi = useRef<PaneGridApi | null>(null)
  const chatOpen = useStore((s) => s.chatOpen)
  const studyEnabled = useStore((s) => s.settings?.studyEnabled ?? true)
  const scratchId = useStore((s) => s.scratchTask?.id)
  const [railOpen, setRailOpen] = useState(
    () => localStorage.getItem('asit-rail-open') !== '0'
  )
  const setChatOpen = (v: boolean | ((p: boolean) => boolean)): void =>
    useStore.setState((st) => ({ chatOpen: typeof v === 'function' ? v(st.chatOpen) : v }))
  // Chat can never starve the pane area: cap at what the window affords,
  // re-clamped on every window resize.
  const clampChatWidth = (w: number): number =>
    Math.max(280, Math.min(560, window.innerWidth - 620, w))
  const [chatWidth, setChatWidth] = useState(() =>
    clampChatWidth(Number(localStorage.getItem('asit-chat-width')) || 360)
  )

  useEffect(() => {
    const onResize = (): void => setChatWidth((w) => clampChatWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    localStorage.setItem('asit-rail-open', railOpen ? '1' : '0')
  }, [railOpen])

  const refreshResources = useCallback(async (): Promise<void> => {
    if (!task) return
    setActiveResources(await window.asit.resources.list(task.id))
  }, [task, setActiveResources])

  // Claude-driven app actions (via .asit/actions.ndjson → main → here).
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const p = args[0] as { type: string; id?: string; url?: string; owner?: string }
      if (p.type === 'open-url-tab' && p.url) {
        // Only the group that owns the pane the link came from.
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

  // Deep link (to-do, notes link, or the phone). Keyed on the pending id, not
  // the group: links that point INSIDE the group you are already in must work
  // too, and there the group id never changes.
  const pendingResourceId = useStore((s) => s.pendingResourceId)
  useEffect(() => {
    if (!pendingResourceId) return
    const id = useStore.getState().consumePendingResource()
    if (!id) return
    const open = (): void =>
      gridApi.current?.openResource(id === 'builtin-notes' ? BUILTIN_NOTES : id)
    if (gridApi.current) {
      open()
      return
    }
    // Grid still mounting (group switch + cold lazy chunk can exceed any
    // single delay) — retry until it appears, bounded.
    let tries = 0
    const t = setInterval(() => {
      if (gridApi.current || ++tries > 20) {
        clearInterval(t)
        open()
      }
    }, 150)
    return () => clearInterval(t)
  }, [pendingResourceId])

  useEffect(() => {
    return () => useStore.getState().setUrlOpener(null)
  }, [])

  // Pre-boot only: bootShell resolves the scratchpad and the shell appears.
  if (!task) return <div className="shell shell-booting" />

  const isScratch = task.id === scratchId

  return (
    <div className="shell">
      <header className="shell-head">
        <GroupBar />
        <div className="shell-head-right">
          {studyEnabled && !isScratch && <TimerBar task={task} />}
          <StatusCluster />
          <button
            className={`btn btn-ghost rail-toggle ${railOpen ? 'rail-toggle-on' : ''}`}
            title="Show this group's files and pins"
            onClick={() => setRailOpen((v) => !v)}
          >
            ☰
          </button>
          {!task.aiDisabled && (
            <button
              className={`btn btn-ghost chat-toggle ${chatOpen ? 'chat-toggle-on' : ''}`}
              title="Agent for this group (Ctrl+\\)"
              onClick={() => setChatOpen((v) => !v)}
            >
              ▭ Agent
            </button>
          )}
        </div>
      </header>
      <SigninHandoff />
      <div className="shell-body">
        {railOpen && (
          <ResourceRail
            task={task}
            resources={resources}
            onOpen={(id) => gridApi.current?.openResource(id)}
            onSearch={(q) => gridApi.current?.openSearch(q)}
            onResourcesChanged={refreshResources}
          />
        )}
        <PaneGrid
          key={task.id}
          task={task}
          resources={resources}
          onApi={(api) => {
            gridApi.current = api
            ;(window as unknown as { __asitGrid?: unknown }).__asitGrid = api
            useStore.getState().setUrlOpener((url) => api.openUrl(url))
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
          onResourcesChanged={refreshResources}
        />
        {chatOpen && !task.aiDisabled && (
          <>
            <div
              className="divider"
              title="Drag to resize"
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
      {studyEnabled && !isScratch && <BreakReviewGate taskId={task.id} />}
    </div>
  )
}

// Isolates the 1-per-second SESSION_TICK subscription: with it inlined, the
// ENTIRE shell (rail, grid, every chat message) re-rendered every second for
// the whole focus session.
function BreakReviewGate({ taskId }: { taskId: string }): JSX.Element | null {
  const timerState = useTimerState()
  const [dismissed, setDismissed] = useState(false)
  const onBreak = timerState?.phase === 'break'
  useEffect(() => {
    if (onBreak) setDismissed(false)
  }, [onBreak])
  if (!onBreak || dismissed || !timerState) return null
  return (
    <BreakReview
      taskId={taskId}
      remainingSec={timerState.remainingSec}
      onClose={() => setDismissed(true)}
    />
  )
}
