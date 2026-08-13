import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { CreateTaskInput, Settings, UpdateTaskInput } from '@shared/types'

// Typed API exposed to the renderer as window.asit.
// Push-event subscriptions return an unsubscribe function.
const api = {
  tasks: {
    list: () => ipcRenderer.invoke(IPC.TASKS_LIST),
    get: (id: string) => ipcRenderer.invoke(IPC.TASKS_GET, id),
    create: (input: CreateTaskInput) => ipcRenderer.invoke(IPC.TASKS_CREATE, input),
    update: (id: string, input: UpdateTaskInput) => ipcRenderer.invoke(IPC.TASKS_UPDATE, id, input),
    delete: (id: string) => ipcRenderer.invoke(IPC.TASKS_DELETE, id),
    open: (id: string) => ipcRenderer.invoke(IPC.TASKS_OPEN, id),
    stats: () => ipcRenderer.invoke(IPC.TASKS_STATS),
    setPrivacy: (id: string, aiDisabled: boolean) =>
      ipcRenderer.invoke(IPC.TASKS_SET_PRIVACY, id, aiDisabled),
    setCoding: (id: string, coding: boolean) =>
      ipcRenderer.invoke(IPC.TASKS_SET_CODING, id, coding),
    scratchGet: () => ipcRenderer.invoke(IPC.SCRATCH_GET),
    scratchSave: (name: string) => ipcRenderer.invoke(IPC.SCRATCH_SAVE, name)
  },
  resources: {
    list: (taskId: string) => ipcRenderer.invoke(IPC.RESOURCES_LIST, taskId),
    addUrl: (taskId: string, title: string, url: string) =>
      ipcRenderer.invoke(IPC.RESOURCES_ADD_URL, taskId, title, url),
    addNote: (taskId: string, title: string) =>
      ipcRenderer.invoke(IPC.RESOURCES_ADD_NOTE, taskId, title),
    addPdf: (taskId: string) => ipcRenderer.invoke(IPC.RESOURCES_ADD_PDF, taskId),
    openExternal: (target: { url?: string; filePath?: string }) =>
      ipcRenderer.invoke(IPC.RESOURCES_OPEN_EXTERNAL, target),
    rename: (id: string, taskId: string, title: string) =>
      ipcRenderer.invoke(IPC.RESOURCES_RENAME, id, taskId, title),
    remove: (id: string, taskId: string) => ipcRenderer.invoke(IPC.RESOURCES_REMOVE, id, taskId),
    reorder: (taskId: string, orderedIds: string[]) =>
      ipcRenderer.invoke(IPC.RESOURCES_REORDER, taskId, orderedIds)
  },
  panes: {
    open: (paneId: string, target: { url?: string; filePath?: string }, ownerId: string) =>
      ipcRenderer.invoke(IPC.PANES_OPEN, paneId, target, ownerId),
    setBounds: (paneId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(IPC.PANES_SET_BOUNDS, paneId, bounds),
    setVisible: (paneId: string | null, visible: boolean) =>
      ipcRenderer.invoke(IPC.PANES_SET_VISIBLE, paneId, visible),
    navigate: (paneId: string, action: { url?: string; nav?: 'back' | 'forward' | 'reload' }) =>
      ipcRenderer.invoke(IPC.PANES_NAVIGATE, paneId, action),
    close: (paneId: string) => ipcRenderer.invoke(IPC.PANES_CLOSE, paneId),
    closeAll: () => ipcRenderer.invoke(IPC.PANES_CLOSE_ALL),
    park: () => ipcRenderer.invoke(IPC.PANES_PARK),
    typeActive: (text: string) => ipcRenderer.invoke(IPC.PANES_TYPE_ACTIVE, text),
    focus: (paneId: string) => ipcRenderer.invoke(IPC.PANES_FOCUS, paneId),
    domFocus: (focused: boolean) => ipcRenderer.send(IPC.PANES_DOM_FOCUS, focused)
  },
  todos: {
    list: (includeDone?: boolean) => ipcRenderer.invoke(IPC.TODOS_LIST, includeDone),
    add: (input: { text: string; dueDate?: string | null; priority?: number }) =>
      ipcRenderer.invoke(IPC.TODOS_ADD, input),
    setDone: (id: string, done: boolean) => ipcRenderer.invoke(IPC.TODOS_SET_DONE, id, done),
    delete: (id: string) => ipcRenderer.invoke(IPC.TODOS_DELETE, id)
  },
  terms: {
    list: (taskId: string) => ipcRenderer.invoke(IPC.TERMS_LIST, taskId),
    addQuestions: (taskId: string) => ipcRenderer.invoke(IPC.TERMS_ADD_QUESTIONS, taskId)
  },
  notes: {
    read: (filePath: string) => ipcRenderer.invoke(IPC.NOTES_READ, filePath),
    write: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.NOTES_WRITE, filePath, content),
    watch: (filePath: string) => ipcRenderer.invoke(IPC.NOTES_WATCH, filePath),
    unwatch: (filePath: string) => ipcRenderer.invoke(IPC.NOTES_UNWATCH, filePath),
    saveImage: (notePath: string, data: Uint8Array, ext: string) =>
      ipcRenderer.invoke(IPC.NOTES_SAVE_IMAGE, notePath, data, ext),
    readImage: (notePath: string, src: string) =>
      ipcRenderer.invoke(IPC.NOTES_READ_IMAGE, notePath, src)
  },
  activity: {
    list: () => ipcRenderer.invoke(IPC.ACTIVITY_LIST)
  },
  companion: {
    status: () => ipcRenderer.invoke(IPC.COMPANION_STATUS),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.COMPANION_SET_ENABLED, enabled),
    qr: () => ipcRenderer.invoke(IPC.COMPANION_QR),
    tailscaleServe: () => ipcRenderer.invoke(IPC.COMPANION_TAILSCALE_SERVE),
    testPush: () => ipcRenderer.invoke(IPC.COMPANION_TEST_PUSH),
    revoke: () => ipcRenderer.invoke(IPC.COMPANION_REVOKE)
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC.SKILLS_LIST),
    run: (taskId: string, name: string) => ipcRenderer.invoke(IPC.SKILLS_RUN, taskId, name),
    delete: (name: string) => ipcRenderer.invoke(IPC.SKILLS_DELETE, name)
  },
  library: {
    list: () => ipcRenderer.invoke(IPC.LIBRARY_LIST),
    add: () => ipcRenderer.invoke(IPC.LIBRARY_ADD),
    remove: (name: string) => ipcRenderer.invoke(IPC.LIBRARY_REMOVE, name),
    attach: (taskId: string, name: string) => ipcRenderer.invoke(IPC.LIBRARY_ATTACH, taskId, name)
  },
  transfer: {
    export: () => ipcRenderer.invoke(IPC.TRANSFER_EXPORT),
    import: () => ipcRenderer.invoke(IPC.TRANSFER_IMPORT)
  },
  usage: {
    task: (taskId: string) => ipcRenderer.invoke(IPC.USAGE_TASK, taskId),
    summary: () => ipcRenderer.invoke(IPC.USAGE_SUMMARY),
    activity: () => ipcRenderer.invoke(IPC.USAGE_ACTIVITY)
  },
  assistant: {
    ask: (prompt: string) => ipcRenderer.invoke(IPC.ASSISTANT_ASK, prompt),
    cancel: () => ipcRenderer.invoke(IPC.ASSISTANT_CANCEL),
    history: (limit?: number) => ipcRenderer.invoke(IPC.ASSISTANT_HISTORY, limit)
  },
  quickfetch: {
    run: (query: string) => ipcRenderer.invoke(IPC.QUICKFETCH_RUN, query)
  },
  accounts: {
    list: () => ipcRenderer.invoke(IPC.ACCOUNTS_LIST),
    openLogin: (providerId: string) => ipcRenderer.invoke(IPC.ACCOUNTS_OPEN_LOGIN, providerId)
  },
  session: {
    start: (taskId: string, mode?: 'stopwatch' | 'pomodoro', workMin?: number, breakMin?: number) =>
      ipcRenderer.invoke(IPC.SESSION_START, taskId, mode, workMin, breakMin),
    pause: () => ipcRenderer.invoke(IPC.SESSION_PAUSE),
    resume: () => ipcRenderer.invoke(IPC.SESSION_RESUME),
    end: () => ipcRenderer.invoke(IPC.SESSION_END),
    state: () => ipcRenderer.invoke(IPC.SESSION_STATE)
  },
  lockdown: {
    holdStart: () => ipcRenderer.invoke(IPC.LOCKDOWN_HOLD_START),
    holdCancel: () => ipcRenderer.invoke(IPC.LOCKDOWN_HOLD_CANCEL),
    releaseHold: () => ipcRenderer.invoke(IPC.LOCKDOWN_RELEASE_HOLD),
    releasePhrase: (phrase: string) => ipcRenderer.invoke(IPC.LOCKDOWN_RELEASE_PHRASE, phrase)
  },
  chat: {
    listSessions: (taskId: string) => ipcRenderer.invoke(IPC.CHAT_LIST_SESSIONS, taskId),
    newSession: (taskId: string) => ipcRenderer.invoke(IPC.CHAT_NEW_SESSION, taskId),
    history: (chatSessionId: string) => ipcRenderer.invoke(IPC.CHAT_HISTORY, chatSessionId),
    send: (chatSessionId: string, text: string) =>
      ipcRenderer.invoke(IPC.CHAT_SEND, chatSessionId, text),
    cancel: (chatSessionId: string) => ipcRenderer.invoke(IPC.CHAT_CANCEL, chatSessionId),
    running: () => ipcRenderer.invoke(IPC.CHAT_RUNNING)
  },
  questions: {
    generate: (taskId: string, resourceId: string, mode: 'generate' | 'extract') =>
      ipcRenderer.invoke(IPC.QUESTIONS_GENERATE, taskId, resourceId, mode),
    due: (limit?: number, taskId?: string) => ipcRenderer.invoke(IPC.QUESTIONS_DUE, limit, taskId),
    list: (taskId: string) => ipcRenderer.invoke(IPC.QUESTIONS_LIST, taskId),
    suspend: (id: string, suspended: boolean) =>
      ipcRenderer.invoke(IPC.QUESTIONS_SUSPEND, id, suspended),
    delete: (id: string) => ipcRenderer.invoke(IPC.QUESTIONS_DELETE, id),
    answer: (id: string, input: { selfGrade?: 0 | 1 | 2 | 3; typedAnswer?: string }) =>
      ipcRenderer.invoke(IPC.QUESTIONS_ANSWER, id, input)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch)
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type AsitApi = typeof api

contextBridge.exposeInMainWorld('asit', api)
