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
}

let noticeCounter = 0

interface AsitState {
  view: 'home' | 'workspace'
  tasks: Task[]
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
  // Background status shown in the header cluster (one listener, many headers).
  activity: ActivityItem[]
  setActivity: (items: ActivityItem[]) => void
  jobStatus: { label: string; queued: number } | null
  setJobStatus: (s: { label: string; queued: number } | null) => void
  notice: { id: number; text: string; kind: 'info' | 'ok' | 'error' } | null
  pushNotice: (text: string, kind: 'info' | 'ok' | 'error') => void
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
  activity: [],
  setActivity: (items) => set({ activity: items }),
  jobStatus: null,
  setJobStatus: (s) => set({ jobStatus: s }),
  notice: null,
  pushNotice: (text, kind) => {
    const id = ++noticeCounter
    set({ notice: { id, text, kind } })
    setTimeout(() => {
      if (get().notice?.id === id) set({ notice: null })
    }, 6000)
  },
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
  loadError: null,
  retryLoad: async () => {
    set({ loadError: null })
    await Promise.all([get().loadTasks(), get().loadSettings()])
  },

  // Both loaders leave existing state alone when they fail — never overwrite
  // real data (or an unknown state) with an empty one.
  loadTasks: async () => {
    const tasks = await reliably('workspaces', () => window.asit.tasks.list())
    if (tasks) set({ tasks })
  },

  loadSettings: async () => {
    const settings = await reliably('settings', () => window.asit.settings.get())
    if (settings) set({ settings })
  },

  openTask: async (id: string) => {
    const result = await window.asit.tasks.open(id)
    if (result) {
      set({ view: 'workspace', activeTask: result.task, activeResources: result.resources })
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
