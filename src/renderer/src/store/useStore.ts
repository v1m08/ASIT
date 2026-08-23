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

/** What a tab-owning screen can do. Every field optional — a surface
 *  implements what makes sense for it. */
export interface TabSurface {
  newTab?: () => void
  closeTab?: () => void
  reopenTab?: () => void
  nextTab?: () => void
  prevTab?: () => void
  reload?: () => void
  back?: () => void
  forward?: () => void
  zoom?: (delta: number) => void
  find?: () => void
  pinPage?: () => void
  copyAddress?: () => void
  addFile?: () => void
  toggleSplit?: () => void
  toggleDirection?: () => void
}

interface AsitState {
  view: 'home' | 'workspace'
  tasks: Task[]
  /** False until the first successful tasks load — gates empty states. */
  tasksLoaded: boolean
  activeTask: Task | null
  activeResources: Resource[]
  settings: Settings | null
  assistantRecall: { prompt: string; reply: string } | null
  setAssistantRecall: (r: { prompt: string; reply: string } | null) => void
  // Quick assistant is a launcher in the header + a panel that opens on demand;
  // nothing is docked permanently, so no screen space is reserved for it.
  assistantOpen: boolean
  setAssistantOpen: (open: boolean) => void
  jarvisOpen: boolean
  setJarvisOpen: (open: boolean) => void
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
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  // Whichever browsing surface is on screen registers itself here, so
  // things like the history list can open a URL without knowing which.
  urlOpener: ((url: string) => void) | null
  setUrlOpener: (fn: ((url: string) => void) | null) => void
  openUrlInWorkspace: (url: string) => void
  chatOpen: boolean
  toggleChat: () => void

  loadTasks: () => Promise<void>
  loadSettings: () => Promise<void>
  openTask: (id: string) => Promise<void>
  startFocus: (id: string) => Promise<void>
  goHome: () => void
  setActiveResources: (resources: Resource[]) => void
}

export const useStore = create<AsitState>((set, get) => ({
  view: 'home',
  tasks: [],
  tasksLoaded: false,
  activeTask: null,
  activeResources: [],
  settings: null,
  assistantRecall: null,
  setAssistantRecall: (r) => set({ assistantRecall: r }),
  // The two right-docked panels share the same reserved column — opening one
  // closes the other.
  assistantOpen: false,
  setAssistantOpen: (open) => set({ assistantOpen: open, ...(open ? { jarvisOpen: false } : {}) }),
  jarvisOpen: false,
  setJarvisOpen: (open) => set({ jarvisOpen: open, ...(open ? { assistantOpen: false } : {}) }),
  voiceTick: 0,
  bumpVoice: () => set((s) => ({ voiceTick: s.voiceTick + 1, jarvisOpen: true, assistantOpen: false })),
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
    const result = await window.asit.tasks.open(taskId)
    if (result) {
      set({ view: 'workspace', activeTask: result.task, activeResources: result.resources })
    } else {
      set({ pendingResourceId: null })
    }
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
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
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

  openTask: async (id: string) => {
    // Failure must SAY something — a click that silently does nothing reads
    // as "the app is broken", which is worse than any error message.
    try {
      const result = await window.asit.tasks.open(id)
      if (result) {
        set({ view: 'workspace', activeTask: result.task, activeResources: result.resources })
      } else {
        get().pushNotice("Couldn't open that workspace — it may have been deleted.", 'error')
      }
    } catch (err) {
      get().pushNotice(
        `Couldn't open that workspace — ${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    }
  },

  // One click from Home: open the workspace AND start a locked focus session.
  startFocus: async (id: string) => {
    const result = await window.asit.tasks.open(id)
    if (result) {
      set({ view: 'workspace', activeTask: result.task, activeResources: result.resources })
      await window.asit.session.start(id, 'stopwatch')
    }
  },

  goHome: () => set({ view: 'home', activeTask: null, activeResources: [] }),

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
