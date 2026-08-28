import { create } from 'zustand'
import type { Resource, Settings, Task } from '@shared/types'
import { reliably, setLoadFailureSink } from '../lib/reliably'

export interface ActivityItem {
  id: string
  kind: 'chat' | 'assistant' | 'questions' | 'watch' | 'jarvis'
  taskId: string | null
  label: string
  detail: string | null
  startedAt: number
  done?: boolean
  finishedAt?: number
}

let noticeCounter = 0

/** What a tab-owning screen can do. Core browser verbs are REQUIRED — a
 *  surface that skipped one left its shortcut silently dead (Ctrl+D and
 *  Ctrl+\ did nothing on Home while the cheat sheet advertised them). Only
 *  genuinely workspace-only ops stay optional; the shortcut dispatcher shows
 *  a notice for those instead of no-oping. */
export interface TabSurface {
  newTab: () => void
  closeTab: () => void
  reopenTab: () => void
  nextTab: () => void
  prevTab: () => void
  reload: () => void
  back: () => void
  forward: () => void
  zoom: (delta: number) => void
  find: () => void
  copyAddress: () => void
  /** Ctrl+D: star the active page into the global bookmarks. */
  bookmarkPage: () => void
  addFile?: () => void
  toggleSplit?: () => void
  toggleDirection?: () => void
}

interface AsitState {
  // There is no "home screen" and no mode. ASIT is a browser that is always
  // showing exactly one TAB GROUP, and a group is a task. The scratchpad is
  // the default group ("Browse") — the one you land in with no commitment —
  // and every workspace is just another group in the same strip.
  //
  // The old shape was `view: 'home' | 'workspace'`: two different screens with
  // two different tab systems, where opening a workspace threw away the
  // browser you were in. Switching groups now only re-mounts the content with
  // a different task, so tabs, panes and history all behave the way a browser's
  // tab groups do.
  tasks: Task[]
  /** False until the first successful tasks load — gates empty states. */
  tasksLoaded: boolean
  activeTask: Task | null
  activeResources: Resource[]
  settings: Settings | null
  // ONE assistant panel with routed views (agent = Jarvis, quick = the haiku
  // read-only lane); nothing is docked while it's closed.
  assistantOpen: boolean
  setAssistantOpen: (open: boolean) => void
  assistantScope: 'agent' | 'quick'
  setAssistantScope: (scope: 'agent' | 'quick') => void
  // Ctrl+Space (from anywhere, including inside a page) bumps this; the
  // Jarvis panel reacts by toggling the mic.
  voiceTick: number
  bumpVoice: () => void
  // Same pattern as voiceTick: the key may be pressed inside a page, so
  // it reaches main first and returns as an app event.
  dictateTick: number
  bumpDictate: () => void
  // Background status shown in the header cluster (one listener, many headers).
  activity: ActivityItem[]
  setActivity: (items: ActivityItem[]) => void
  jobStatus: { label: string; queued: number } | null
  setJobStatus: (s: { label: string; queued: number } | null) => void
  notice: { id: number; text: string; kind: 'info' | 'ok' | 'error' } | null
  pushNotice: (text: string, kind: 'info' | 'ok' | 'error') => void
  dismissNotice: () => void
  pendingResourceId: string | null
  consumePendingResource: () => string | null
  openTaskAndResource: (taskId: string, resourceId: string) => Promise<void>

  // Set when a startup load exhausted its retries. Rendering an empty panel in
  // that case would claim the user's data is gone, so the header says so
  // instead and offers a retry.
  loadError: string | null
  retryLoad: () => Promise<void>

  // What the user is currently dragging (a rail resource or a global library
  // file). Shared because the drag STARTS in the rail and ENDS in the pane
  // grid, and the grid must hide its WebContentsViews while it's set —
  // otherwise a page painted over the slot swallows the drop (invariant 2).
  dragItem: { kind: 'library' | 'resource'; value: string } | null
  setDragItem: (item: { kind: 'library' | 'resource'; value: string } | null) => void

  // Whichever component currently owns TABS registers itself here — PaneGrid
  // in a workspace, ScratchBrowser on home. Shortcuts dispatch through this
  // instead of being hardwired to one component, which is why Ctrl+T used to
  // do nothing anywhere except a workspace.
  tabSurface: TabSurface | null
  setTabSurface: (s: TabSurface | null) => void

  // Shortcut-driven UI toggles, kept in the store so a key pressed inside a
  // page (which reaches main first) can drive the same state as a click.
  scratchNotesOpen: boolean
  toggleScratchNotes: () => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  historyOpen: boolean
  setHistoryOpen: (open: boolean) => void
  automationsOpen: boolean
  setAutomationsOpen: (open: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  // Whichever browsing surface is on screen registers itself here, so
  // things like the history list can open a URL without knowing which.
  // The page the user is looking at, published by whichever surface owns the
  // tabs. Shell chrome (the sign-in handoff today) needs it without reaching
  // into the grid's internals, and it is the natural hook for anything else
  // that must react to "what is on screen".
  activePageUrl: string | null
  activePaneId: string | null
  setActivePage: (paneId: string | null, url: string | null) => void
  urlOpener: ((url: string) => void) | null
  setUrlOpener: (fn: ((url: string) => void) | null) => void
  openUrlInWorkspace: (url: string) => void
  chatOpen: boolean
  toggleChat: () => void

  loadTasks: () => Promise<void>
  loadSettings: () => Promise<void>
  /** The scratchpad group, loaded at boot so the shell always has a group. */
  bootShell: () => Promise<void>
  /** The default group: the scratchpad. Kept so "Browse" can be labelled and
   *  reached without hunting for it in the task list (it is archived there). */
  scratchTask: Task | null
  /** Show a different tab group. Parks the current panes first, so pages stay
   *  alive and revive without reloading — the whole point of a group switch. */
  switchGroup: (id: string) => Promise<void>
  /** Alias for switchGroup. Deep links, the phone and the smoke all speak
   *  "open this task"; a group switch is what that means now. */
  openTask: (id: string) => Promise<void>
  startFocus: (id: string) => Promise<void>
  setActiveResources: (resources: Resource[]) => void
}

export const useStore = create<AsitState>((set, get) => ({
  tasks: [],
  tasksLoaded: false,
  // Null only until bootShell resolves; after that the shell always has a group.
  activeTask: null,
  scratchTask: null,
  activeResources: [],
  settings: null,
  // The two right-docked panels share the same reserved column — opening one
  // closes the other.
  assistantOpen: false,
  setAssistantOpen: (open) => set({ assistantOpen: open }),
  assistantScope: 'agent',
  setAssistantScope: (assistantScope) => set({ assistantScope }),
  voiceTick: 0,
  bumpVoice: () =>
    set((s) => ({ voiceTick: s.voiceTick + 1, assistantOpen: true, assistantScope: 'agent' })),
  dictateTick: 0,
  // Dictation deliberately does NOT open a panel: the point is that the
  // words go where you are already looking.
  bumpDictate: () => set((s) => ({ dictateTick: s.dictateTick + 1 })),
  activity: [],
  setActivity: (items) => set({ activity: items }),
  jobStatus: null,
  setJobStatus: (s) => set({ jobStatus: s }),
  notice: null,
  pushNotice: (text, kind) => {
    // A sticky error is on screen until the user dismisses it — a passing
    // info/ok toast must not silently replace it (that would auto-clear in
    // 6s and take the error with it).
    if (get().notice?.kind === 'error' && kind !== 'error') return
    const id = ++noticeCounter
    set({ notice: { id, text, kind } })
    // Errors STAY until dismissed. Six seconds of a 220px ellipsis was the
    // only trace many failures ever left, and blinking away mid-read is the
    // opposite of actionable.
    if (kind === 'error') return
    setTimeout(() => {
      if (get().notice?.id === id) set({ notice: null })
    }, 6000)
  },
  dismissNotice: () => set({ notice: null }),
  pendingResourceId: null,
  consumePendingResource: () => {
    const id = get().pendingResourceId
    if (id) set({ pendingResourceId: null })
    return id
  },
  // Deep link (e.g. from a to-do): open the workspace AND a specific resource.
  openTaskAndResource: async (taskId: string, resourceId: string) => {
    set({ pendingResourceId: resourceId })
    await get().switchGroup(taskId)
    if (get().activeTask?.id !== taskId) set({ pendingResourceId: null })
  },

  dragItem: null,
  setDragItem: (dragItem) => set({ dragItem }),
  tabSurface: null,
  setTabSurface: (tabSurface) => set({ tabSurface }),
  scratchNotesOpen: false,
  toggleScratchNotes: () => set((st) => ({ scratchNotesOpen: !st.scratchNotesOpen })),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  historyOpen: false,
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  automationsOpen: false,
  setAutomationsOpen: (automationsOpen) => set({ automationsOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  activePageUrl: null,
  activePaneId: null,
  setActivePage: (activePaneId, activePageUrl) => {
    // Guarded: this fires on every nav-state push, and an unconditional set
    // would re-render every subscriber many times per page load.
    const s = get()
    if (s.activePaneId === activePaneId && s.activePageUrl === activePageUrl) return
    set({ activePaneId, activePageUrl })
  },
  urlOpener: null,
  setUrlOpener: (urlOpener) => set({ urlOpener }),
  openUrlInWorkspace: (url) => {
    const open = get().urlOpener
    // No browsing surface mounted (you are on Home): hand it to the
    // system browser rather than swallowing the click.
    if (open) open(url)
    else void window.asit.resources.openExternal({ url })
  },
  chatOpen: true,
  toggleChat: () => set((st) => ({ chatOpen: !st.chatOpen })),
  loadError: null,
  retryLoad: async () => {
    set({ loadError: null })
    await Promise.all([get().loadTasks(), get().loadSettings()])
  },

  // Both loaders leave existing state alone when they fail — never overwrite
  // real data (or an unknown state) with an empty one.
  loadTasks: async () => {
    const tasks = await reliably('workspaces', () => window.asit.tasks.list())
    // tasksLoaded gates the "No workspaces yet" empty state: before the first
    // resolve the truthful answer is "don't know yet", and a user with thirty
    // workspaces should not be told they have none on every launch.
    if (tasks) set({ tasks, tasksLoaded: true })
  },

  loadSettings: async () => {
    const settings = await reliably('settings', () => window.asit.settings.get())
    if (settings) set({ settings })
  },

  // The shell cannot render without a group, so the scratchpad is fetched
  // before anything else and becomes the one you land in.
  bootShell: async () => {
    const scratch = await reliably('browser', () => window.asit.tasks.scratchGet())
    if (!scratch) return
    set({ scratchTask: scratch.task })
    if (!get().activeTask) {
      set({ activeTask: scratch.task, activeResources: scratch.resources })
    }
  },

  switchGroup: async (id: string) => {
    const current = get().activeTask
    if (current?.id === id) return
    try {
      // Park BEFORE swapping: the outgoing group's panes are hidden but kept
      // alive, so coming back is instant and nothing reloads.
      if (current) await window.asit.panes.park()
      const result = await window.asit.tasks.open(id)
      if (result) {
        set({ activeTask: result.task, activeResources: result.resources })
      } else {
        // Failure must SAY something — a click that silently does nothing
        // reads as "the app is broken", which is worse than any error.
        get().pushNotice("Couldn't open that group — it may have been deleted.", 'error')
      }
    } catch (err) {
      get().pushNotice(
        `Couldn't open that group — ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    }
  },

  openTask: async (id: string) => get().switchGroup(id),

  // Switch to the group AND start a locked focus session on it.
  startFocus: async (id: string) => {
    await get().switchGroup(id)
    if (get().activeTask?.id === id) await window.asit.session.start(id, 'stopwatch')
  },

  setActiveResources: (resources) => set({ activeResources: resources })
}))

// A load that ran out of retries becomes visible chrome in the header, not an
// empty list that reads as "your data is gone".
setLoadFailureSink(
  (label, detail) =>
    useStore.setState({ loadError: `Couldn't load your ${label} — ${detail.slice(0, 80)}` }),
  () => {
    if (useStore.getState().loadError) useStore.setState({ loadError: null })
  }
)

// Test handle for the real-UI smoke (ASIT_SMOKE_UI=1), and a genuinely useful
// debugging one. Safe to expose: this is the renderer's own store, and pages
// live in separate WebContents that cannot see this world.
;(window as unknown as { __asitStore?: unknown }).__asitStore = useStore
