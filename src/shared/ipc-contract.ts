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
  TASKS_SET_TERMINAL_AI_READ: 'tasks:set-terminal-ai-read',
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
  UPDATE_STATUS: 'update:status',       // push M→R and a getter
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  UI_CONTEXT_MENU: 'ui:context-menu',
  VAULT_SAVE_PENDING: 'vault:save-pending',   // commit the offered login
  VAULT_DISCARD_PENDING: 'vault:discard-pending',
  VAULT_OFFER_SAVE: 'vault:offer-save',       // push M->R: site + username only
  HISTORY_SEARCH: 'history:search',
  HISTORY_RECENT: 'history:recent',
  HISTORY_REMOVE: 'history:remove',
  HISTORY_CLEAR: 'history:clear',
  PANES_GONE: 'panes:gone', // push M→R: a pane died (evicted or crashed)
  PANES_DID_NAVIGATE: 'panes:did-navigate', // push M→R
  // Browser basics the panes were missing.
  PANES_FIND: 'panes:find',
  PANES_FIND_STOP: 'panes:find-stop',
  PANES_FIND_RESULT: 'panes:find-result', // push M→R
  PANES_ZOOM: 'panes:zoom',
  PANES_DOWNLOADS: 'panes:downloads',
  PANES_DOWNLOAD_EVENT: 'panes:download-event', // push M→R
  PANES_SHOW_DOWNLOAD: 'panes:show-download',

  // Password vault. User-driven only: no agent path exists to any of these,
  // and the store lives outside every AI-readable folder.
  VAULT_LIST: 'vault:list',
  VAULT_SAVE: 'vault:save',
  VAULT_DELETE: 'vault:delete',
  VAULT_REVEAL: 'vault:reveal',
  VAULT_STATUS: 'vault:status',

  // Ad/tracker blocking + Chrome extensions for the embedded browser.
  BROWSER_STATS: 'browser:stats',
  BROWSER_EXT_LIST: 'browser:ext-list',
  BROWSER_EXT_ADD: 'browser:ext-add',
  BROWSER_EXT_REMOVE: 'browser:ext-remove',

  // Native app-window embedding (Windows only, user-driven, no agent path).
  APPWIN_LIST: 'appwin:list',
  APPWIN_EMBED: 'appwin:embed',
  APPWIN_BOUNDS: 'appwin:bounds',
  APPWIN_VISIBLE: 'appwin:visible',
  APPWIN_RELEASE: 'appwin:release',

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
  ACTIVITY_DISMISS: 'activity:dismiss',
  ACTIVITY_DISMISS_FINISHED: 'activity:dismiss-finished',
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
  WHATSAPP_SEND: 'whatsapp:send',
  WHATSAPP_PREWARM: 'whatsapp:prewarm',
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

  // Terminal panes. TERMINAL_WRITE carries USER keystrokes only — it is
  // reachable from the focused xterm view and nowhere else. No agent-facing
  // write channel exists anywhere in the app.
  TERMINAL_OPEN: 'terminal:open',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_CLOSE: 'terminal:close',
  TERMINAL_REPLAY: 'terminal:replay',
  TERMINAL_SHELLS: 'terminal:shells',
  TERMINAL_DATA: 'terminal:data', // push M→R
  TERMINAL_EXIT: 'terminal:exit', // push M→R

  // key terms from notes
  TERMS_LIST: 'terms:list',
  TERMS_ADD_QUESTIONS: 'terms:add-questions',

  NOTES_SAVE_IMAGE: 'notes:save-image',
  NOTES_READ_IMAGE: 'notes:read-image', // relative src → data: URL for preview

  // Jarvis (universal agent)
  JARVIS_ASK: 'jarvis:ask',
  JARVIS_CANCEL: 'jarvis:cancel',
  JARVIS_NEW: 'jarvis:new',
  JARVIS_STREAM: 'jarvis:stream', // push M→R
  JARVIS_STATUS: 'jarvis:status', // push M→R
  JARVIS_DONE: 'jarvis:done', // push M→R
  JARVIS_ERROR: 'jarvis:error', // push M→R

  // voice (Jarvis's ears + mouth)
  VOICE_STATUS: 'voice:status',
  VOICE_DOWNLOAD: 'voice:download',
  VOICE_START: 'voice:start',
  VOICE_STOP: 'voice:stop',
  VOICE_CHUNK: 'voice:chunk', // renderer → main, fire-and-forget PCM
  VOICE_STATE: 'voice:state', // push M→R: idle|listening|thinking|speaking
  VOICE_TRANSCRIPT: 'voice:transcript', // push M→R
  VOICE_REPLY: 'voice:reply', // push M→R
  VOICE_DOWNLOAD_PROGRESS: 'voice:download-progress', // push M→R
  VOICE_PREWARM: 'voice:prewarm', // R→M, no reply
  VOICE_AUDIO: 'voice:audio', // push M→R: Kokoro samples to play
  VOICE_AUDIO_STOP: 'voice:audio-stop', // push M→R: barge-in
  VOICE_AUDIO_DONE: 'voice:audio-done', // R→M: playback finished
  VOICE_TTS_STATUS: 'voice:tts-status',
  VOICE_TTS_DOWNLOAD: 'voice:tts-download',
  VOICE_TTS_PROGRESS: 'voice:tts-progress', // push M→R
  VOICE_DICTATE_START: 'voice:dictate-start',
  VOICE_DICTATE_STOP: 'voice:dictate-stop',
  VOICE_DICTATE_TEXT: 'voice:dictate-text', // push M→R: a finished phrase
  PANES_INSERT_TEXT: 'panes:insert-text',   // type into the focused page

  // phone companion
  COMPANION_STATUS: 'companion:status',
  COMPANION_SET_ENABLED: 'companion:set-enabled',
  COMPANION_QR: 'companion:qr',
  COMPANION_TAILSCALE_SERVE: 'companion:tailscale-serve',
  COMPANION_TEST_PUSH: 'companion:test-push',
  COMPANION_REVOKE: 'companion:revoke',
  COMPANION_PAIR_APPROVE: 'companion:pair-approve',
  COMPANION_PAIR_DENY: 'companion:pair-deny',

  // backup / sharing
  TRANSFER_EXPORT: 'transfer:export',
  TRANSFER_IMPORT: 'transfer:import',

  // skills (saved procedures, invoked with ./name in chat)
  SKILLS_LIST: 'skills:list',
  SKILLS_RUN: 'skills:run',
  SKILLS_DELETE: 'skills:delete',

  // global file library
  RESOURCES_ADD_FILES: 'resources:add-files', // OS drag-and-drop
  LIBRARY_ADD_PATHS: 'library:add-paths',
  LIBRARY_LIST: 'library:list',
  LIBRARY_ADD: 'library:add',
  LIBRARY_REMOVE: 'library:remove',
  LIBRARY_ATTACH: 'library:attach'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
