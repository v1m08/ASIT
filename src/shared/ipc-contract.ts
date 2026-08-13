// Single source of truth for IPC channel names.
// Request/response channels use ipcMain.handle / ipcRenderer.invoke.
// Push channels use webContents.send / ipcRenderer.on.

export const IPC = {
  // tasks
  TASKS_LIST: 'tasks:list',
  TASKS_GET: 'tasks:get',
  TASKS_CREATE: 'tasks:create',
  TASKS_UPDATE: 'tasks:update',
  TASKS_DELETE: 'tasks:delete',
  TASKS_OPEN: 'tasks:open',
  TASKS_STATS: 'tasks:stats',
  TASKS_SET_PRIVACY: 'tasks:set-privacy',
  TASKS_SET_CODING: 'tasks:set-coding',
  SCRATCH_GET: 'scratch:get',
  SCRATCH_SAVE: 'scratch:save',

  // resources
  RESOURCES_LIST: 'resources:list',
  RESOURCES_ADD_URL: 'resources:add-url',
  RESOURCES_ADD_NOTE: 'resources:add-note',
  RESOURCES_ADD_PDF: 'resources:add-pdf',
  RESOURCES_RENAME: 'resources:rename',
  RESOURCES_REMOVE: 'resources:remove',
  RESOURCES_REORDER: 'resources:reorder',
  RESOURCES_OPEN_EXTERNAL: 'resources:open-external',

  // panes (Phase 2)
  PANES_OPEN: 'panes:open',
  PANES_SET_BOUNDS: 'panes:set-bounds',
  PANES_SET_VISIBLE: 'panes:set-visible',
  PANES_NAVIGATE: 'panes:navigate',
  PANES_CLOSE: 'panes:close',
  PANES_CLOSE_ALL: 'panes:close-all',
  PANES_PARK: 'panes:park',
  PANES_TYPE_ACTIVE: 'panes:type-active',
  PANES_FOCUS: 'panes:focus', // focus ring landed on a page zone
  PANES_DOM_FOCUS: 'panes:dom-focus', // renderer gained/lost the keyboard
  PANES_DID_NAVIGATE: 'panes:did-navigate', // push M→R

  // notes
  NOTES_READ: 'notes:read',
  NOTES_WRITE: 'notes:write',
  NOTES_WATCH: 'notes:watch',
  NOTES_UNWATCH: 'notes:unwatch',
  NOTES_CHANGED: 'notes:changed', // push M→R (external edit, e.g. by Claude)

  // accounts (shared browser profile logins)
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_OPEN_LOGIN: 'accounts:open-login',

  // app events pushed by main (Claude-driven actions, toasts)
  APP_EVENT: 'app:event', // push M→R

  // background activity tracker
  ACTIVITY_LIST: 'activity:list',
  ACTIVITY_UPDATED: 'activity:updated', // push M→R
  CHAT_RUNNING: 'chat:running',

  // session / timer (Phase 4)
  SESSION_START: 'session:start',
  SESSION_PAUSE: 'session:pause',
  SESSION_RESUME: 'session:resume',
  SESSION_END: 'session:end',
  SESSION_STATE: 'session:state',
  SESSION_TICK: 'session:tick', // push M→R
  SESSION_PHASE_CHANGED: 'session:phase-changed', // push M→R

  // lockdown escape (Phase 4)
  LOCKDOWN_HOLD_START: 'lockdown:hold-start',
  LOCKDOWN_HOLD_CANCEL: 'lockdown:hold-cancel',
  LOCKDOWN_RELEASE_HOLD: 'lockdown:release-hold',
  LOCKDOWN_RELEASE_PHRASE: 'lockdown:release-phrase',

  // chat (Phase 3)
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_LIST_SESSIONS: 'chat:list-sessions',
  CHAT_HISTORY: 'chat:history',
  CHAT_NEW_SESSION: 'chat:new-session',
  CHAT_STREAM: 'chat:stream', // push M→R
  CHAT_STATUS: 'chat:status', // push M→R (tool activity, e.g. "Reading notes.md")
  CHAT_USAGE: 'chat:usage', // push M→R (live output-token count while streaming)

  // global quick assistant (haiku)
  ASSISTANT_ASK: 'assistant:ask',
  ASSISTANT_HISTORY: 'assistant:history',
  QUICKFETCH_RUN: 'quickfetch:run',
  ASSISTANT_CANCEL: 'assistant:cancel',
  ASSISTANT_STREAM: 'assistant:stream', // push M→R
  ASSISTANT_STATUS: 'assistant:status', // push M→R
  ASSISTANT_DONE: 'assistant:done', // push M→R
  ASSISTANT_ERROR: 'assistant:error', // push M→R

  // usage / cost tracking
  USAGE_TASK: 'usage:task',
  USAGE_ACTIVITY: 'usage:activity',
  USAGE_SUMMARY: 'usage:summary',
  USAGE_UPDATED: 'usage:updated', // push M→R after any Claude call is logged
  CHAT_DONE: 'chat:done', // push M→R
  CHAT_ERROR: 'chat:error', // push M→R

  // questions (Phase 5)
  QUESTIONS_GENERATE: 'questions:generate', // user-initiated extract/generate
  QUESTIONS_DUE: 'questions:due',
  QUESTIONS_LIST: 'questions:list',
  QUESTIONS_SUSPEND: 'questions:suspend',
  QUESTIONS_DELETE: 'questions:delete',
  QUESTIONS_ANSWER: 'questions:answer',
  JOBS_STATUS: 'jobs:status', // push M→R

  // settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SNIPPETS_GET: 'snippets:get', // pane preload fetches snippets (literal string there)

  // to-dos
  TODOS_LIST: 'todos:list',
  TODOS_ADD: 'todos:add',
  TODOS_SET_DONE: 'todos:set-done',
  TODOS_DELETE: 'todos:delete',
  TODOS_CHANGED: 'todos:changed', // push M→R

  // key terms from notes
  TERMS_LIST: 'terms:list',
  TERMS_ADD_QUESTIONS: 'terms:add-questions',

  NOTES_SAVE_IMAGE: 'notes:save-image',
  NOTES_READ_IMAGE: 'notes:read-image', // relative src → data: URL for preview

  // phone companion
  COMPANION_STATUS: 'companion:status',
  COMPANION_SET_ENABLED: 'companion:set-enabled',
  COMPANION_QR: 'companion:qr',
  COMPANION_TAILSCALE_SERVE: 'companion:tailscale-serve',
  COMPANION_TEST_PUSH: 'companion:test-push',
  COMPANION_REVOKE: 'companion:revoke',

  // backup / sharing
  TRANSFER_EXPORT: 'transfer:export',
  TRANSFER_IMPORT: 'transfer:import',

  // skills (saved procedures, invoked with ./name in chat)
  SKILLS_LIST: 'skills:list',
  SKILLS_RUN: 'skills:run',
  SKILLS_DELETE: 'skills:delete',

  // global file library
  LIBRARY_LIST: 'library:list',
  LIBRARY_ADD: 'library:add',
  LIBRARY_REMOVE: 'library:remove',
  LIBRARY_ATTACH: 'library:attach'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
