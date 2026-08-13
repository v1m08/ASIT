export type TaskStatus = 'active' | 'done' | 'archived'

export interface Task {
  id: string
  title: string
  slug: string
  folderPath: string
  description: string
  status: TaskStatus
  priority: number // 1 high, 2 normal, 3 low
  dueDate: string | null // ISO date
  layoutJson: string | null
  aiDisabled: boolean // private task: no chat, no generation, invisible to AI
  coding: boolean // coding task: chat is a coding agent (Fable 5 + command execution)
  createdAt: string
  lastOpenedAt: string | null
}

export type ResourceKind = 'url' | 'pdf' | 'note' | 'file'

export interface Resource {
  id: string
  taskId: string
  kind: ResourceKind
  title: string
  url: string | null
  filePath: string | null
  position: number
  createdAt: string
}

export interface Question {
  id: string
  taskId: string
  resourceId: string | null
  question: string
  answer: string
  choices: string[] | null // multiple choice options; null = free response
  correctIndex: number | null
  sourceRef: string | null
  ease: number
  intervalDays: number
  reps: number
  lapses: number
  dueAt: string
  suspended: boolean
  origin: 'generated' | 'extracted'
  createdAt: string
}

export interface ChatSession {
  id: string
  taskId: string
  claudeSessionId: string | null
  title: string | null
  createdAt: string
  lastMessageAt: string | null
}

export interface ChatMessage {
  id: string
  chatSessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface Settings {
  claudePath: string
  workMin: number
  breakMin: number
  escapePhrase: string
  holdToQuitSeconds: number
  chatModel: string // 'default' | 'opus' | 'sonnet' | 'haiku' | 'claude-fable-5'
  codingModel: string // model for coding-task chats (same options)
  jarvisModel: string // model for the universal agent (same options)
  onboarded: boolean
  snippets: Record<string, string> // "/KEY" text-expansion shortcuts
  fetchSources: { name: string; url: string }[] // "?query" quick-fetch sources ({q} = query)
  // Phone companion (PWA served over the user's private tailnet)
  companionEnabled: boolean
  companionPort: number
  companionToken: string // pairing secret; '' until first enable generates it
  vapidPublicKey: string // web-push keys, generated once
  vapidPrivateKey: string
  companionSubs: { endpoint: string; keys: { p256dh: string; auth: string } }[]
}

export interface CompanionStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string | null // https://<machine>.<tailnet>.ts.net when tailscale is up
  tailscale: 'ok' | 'not-installed' | 'not-running'
  subscriptions: number
  pendingPair: { requestId: string; code: string } | null // a phone waiting for approval
}

export type TimerPhase = 'idle' | 'work' | 'break' | 'paused'
export type TimerMode = 'stopwatch' | 'pomodoro'

export interface TimerState {
  sessionId: string | null
  taskId: string | null
  mode: TimerMode
  phase: TimerPhase
  pausedFrom: 'work' | 'break' | null
  elapsedSec: number // counts up (stopwatch display)
  remainingSec: number // counts down (pomodoro display)
  workMin: number
  breakMin: number
  phasesCompleted: number
  workSecondsDone: number
  lockdownEngaged: boolean
}

// Persisted per task in tasks.layout_json.
// Two slots (left/right); each holds an ordered list of open tab ids.
// Tab ids are resource ids, or the built-in 'builtin-notes'.
export interface WorkspaceLayout {
  slots: [string[], string[]]
  active: [string | null, string | null]
  split: number // first-slot size fraction, 0.2..0.8
  collapsed?: [boolean, boolean]
  direction?: 'row' | 'column' // side-by-side (default) or top/bottom
}

export interface PaneNavState {
  paneId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

export interface CreateTaskInput {
  title: string
  description?: string
  priority?: number
  dueDate?: string | null
  aiDisabled?: boolean
}

export interface UpdateTaskInput {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: number
  dueDate?: string | null
  layoutJson?: string | null
}
