import type {
  ChatMessage,
  ChatSession,
  CreateTaskInput,
  Question,
  Resource,
  Settings,
  Task,
  TimerState,
  UpdateTaskInput
} from '../shared/types'

declare global {
  interface Window {
    asit: {
      tasks: {
        list: () => Promise<Task[]>
        get: (id: string) => Promise<Task | null>
        create: (input: CreateTaskInput) => Promise<Task>
        update: (id: string, input: UpdateTaskInput) => Promise<Task | null>
        delete: (id: string) => Promise<{ ok: boolean; reason?: string }>
        open: (id: string) => Promise<{ task: Task; resources: Resource[] } | null>
        stats: () => Promise<{
          dueByTask: Record<string, number>
          focusSecToday: number
          focusSecWeek: number
        }>
        setPrivacy: (id: string, aiDisabled: boolean) => Promise<Task | null>
        setCoding: (id: string, coding: boolean) => Promise<Task | null>
        scratchGet: () => Promise<{ task: Task; resources: Resource[] }>
        scratchSave: (name: string) => Promise<Task>
      }
      resources: {
        list: (taskId: string) => Promise<Resource[]>
        addUrl: (taskId: string, title: string, url: string) => Promise<Resource>
        addNote: (taskId: string, title: string) => Promise<Resource>
        addPdf: (taskId: string) => Promise<Resource[] | null>
        openExternal: (target: { url?: string; filePath?: string }) => Promise<void>
        rename: (id: string, taskId: string, title: string) => Promise<void>
        remove: (id: string, taskId: string) => Promise<void>
        reorder: (taskId: string, orderedIds: string[]) => Promise<void>
      }
      panes: {
        open: (
          paneId: string,
          target: { url?: string; filePath?: string },
          ownerId: string
        ) => Promise<void>
        setBounds: (
          paneId: string,
          bounds: { x: number; y: number; width: number; height: number }
        ) => Promise<void>
        setVisible: (paneId: string | null, visible: boolean) => Promise<void>
        navigate: (
          paneId: string,
          action: { url?: string; nav?: 'back' | 'forward' | 'reload' }
        ) => Promise<void>
        close: (paneId: string) => Promise<void>
        closeAll: () => Promise<void>
        park: () => Promise<void>
        typeActive: (text: string) => Promise<string>
        focus: (paneId: string) => Promise<void>
        domFocus: (focused: boolean) => void
      }
      todos: {
        list: (includeDone?: boolean) => Promise<
          {
            id: string
            text: string
            done: boolean
            priority: number
            dueDate: string | null
            taskId: string | null
            sourceFile: string | null
            link: string | null
            createdAt: string
            completedAt: string | null
          }[]
        >
        add: (input: {
          text: string
          dueDate?: string | null
          priority?: number
        }) => Promise<unknown>
        setDone: (id: string, done: boolean) => Promise<void>
        delete: (id: string) => Promise<void>
      }
      terms: {
        list: (taskId: string) => Promise<{ term: string; definition: string }[]>
        addQuestions: (taskId: string) => Promise<number>
      }
      notes: {
        read: (filePath: string) => Promise<string>
        write: (filePath: string, content: string) => Promise<void>
        watch: (filePath: string) => Promise<void>
        unwatch: (filePath: string) => Promise<void>
        saveImage: (notePath: string, data: Uint8Array, ext: string) => Promise<string>
        readImage: (notePath: string, src: string) => Promise<string | null>
      }
      skills: {
        list: () => Promise<{ name: string; content: string }[]>
        run: (taskId: string, name: string) => Promise<{ ran: boolean; log: string[] }>
        delete: (name: string) => Promise<void>
      }
      library: {
        list: () => Promise<{ name: string; sizeBytes: number; modifiedAt: string }[]>
        add: () => Promise<{ name: string; sizeBytes: number; modifiedAt: string }[] | null>
        remove: (name: string) => Promise<{ name: string; sizeBytes: number; modifiedAt: string }[]>
        attach: (taskId: string, name: string) => Promise<Resource | null>
      }
      transfer: {
        export: () => Promise<{ tasks: number; questions: number } | null>
        import: () => Promise<{ tasks: number; questions: number } | null>
      }
      usage: {
        task: (taskId: string) => Promise<{
          costUsd: number
          inputTokens: number
          outputTokens: number
          cacheReadTokens: number
          calls: number
        }>
        summary: () => Promise<{
          today: { costUsd: number; inputTokens: number; outputTokens: number; calls: number }
          week: { costUsd: number; inputTokens: number; outputTokens: number; calls: number }
          all: { costUsd: number; inputTokens: number; outputTokens: number; calls: number }
          costByTask: Record<string, number>
        }>
        activity: () => Promise<
          { date: string; focusSec: number; costUsd: number; chats: number }[]
        >
      }
      assistant: {
        ask: (prompt: string) => Promise<void>
        cancel: () => Promise<void>
        history: (
          limit?: number
        ) => Promise<{ id: string; prompt: string; reply: string; createdAt: string }[]>
      }
      quickfetch: {
        run: (query: string) => Promise<{
          source: string
          otp: string | null
          lines: string[]
          error?: string
        }>
        sendWhatsApp: (recipient: string, message: string) => Promise<{ ok: boolean; detail: string }>
      }
      accounts: {
        list: () => Promise<
          {
            id: string
            name: string
            description: string
            loginUrl: string
            connected: boolean
          }[]
        >
        openLogin: (providerId: string) => Promise<void>
      }
      session: {
        start: (
          taskId: string,
          mode?: 'stopwatch' | 'pomodoro',
          workMin?: number,
          breakMin?: number
        ) => Promise<TimerState>
        pause: () => Promise<TimerState>
        resume: () => Promise<TimerState>
        end: () => Promise<{ ok: boolean; reason?: string }>
        state: () => Promise<TimerState>
      }
      lockdown: {
        holdStart: () => Promise<void>
        holdCancel: () => Promise<void>
        releaseHold: () => Promise<{ ok: boolean; heldSec: number; requiredSec: number }>
        releasePhrase: (phrase: string) => Promise<{ ok: boolean }>
      }
      chat: {
        listSessions: (taskId: string) => Promise<ChatSession[]>
        newSession: (taskId: string) => Promise<ChatSession>
        history: (chatSessionId: string) => Promise<ChatMessage[]>
        send: (chatSessionId: string, text: string) => Promise<void>
        cancel: (chatSessionId: string) => Promise<void>
        running: () => Promise<string[]>
      }
      activity: {
        list: () => Promise<
          {
            id: string
            kind: 'chat' | 'assistant' | 'questions' | 'watch' | 'jarvis'
            taskId: string | null
            label: string
            detail: string | null
            startedAt: number
          }[]
        >
      }
      voice: {
        status: () => Promise<{ modelsReady: boolean; listening: boolean }>
        download: () => Promise<void>
        start: () => Promise<void>
        stop: () => Promise<void>
        chunk: (buf: ArrayBuffer) => void
      }
      jarvis: {
        ask: (prompt: string) => Promise<void>
        cancel: () => Promise<void>
        newSession: () => Promise<void>
      }
      companion: {
        status: () => Promise<import('@shared/types').CompanionStatus>
        setEnabled: (enabled: boolean) => Promise<import('@shared/types').CompanionStatus>
        qr: () => Promise<{ url: string | null; dataUrl: string | null }>
        tailscaleServe: () => Promise<string>
        testPush: () => Promise<void>
        revoke: () => Promise<import('@shared/types').CompanionStatus>
        pairApprove: (requestId: string) => Promise<import('@shared/types').CompanionStatus>
        pairDeny: (requestId: string) => Promise<import('@shared/types').CompanionStatus>
      }
      questions: {
        generate: (
          taskId: string,
          resourceId: string,
          mode: 'generate' | 'extract'
        ) => Promise<void>
        due: (limit?: number, taskId?: string) => Promise<(Question & { taskTitle: string })[]>
        list: (taskId: string) => Promise<Question[]>
        suspend: (id: string, suspended: boolean) => Promise<void>
        delete: (id: string) => Promise<void>
        answer: (
          id: string,
          input: { selfGrade?: 0 | 1 | 2 | 3; typedAnswer?: string }
        ) => Promise<{ grade: number; feedback: string | null; nextDueAt: string }>
      }
      settings: {
        get: () => Promise<Settings>
        set: (patch: Partial<Settings>) => Promise<Settings>
      }
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void
    }
  }
}

export {}
