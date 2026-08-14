import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { CreateTaskInput, Settings, UpdateTaskInput } from '@shared/types'
import * as tasks from './services/tasks'
import * as resources from './services/resources'
import * as settings from './services/settings'
import { paneManager, type PaneBounds, type PaneTarget } from './services/panes'
import * as chat from './services/chat'
import { invalidateClaudePathCache } from './services/claude'
import { timer } from './services/timer'
import * as questions from './services/questions'
import * as accounts from './services/accounts'
import * as usage from './services/usage'
import * as transfer from './services/transfer'
import * as assistant from './services/assistant'
import * as library from './services/library'
import * as skills from './services/skills'
import * as activity from './services/activity'
import * as quickfetch from './services/quickfetch'
import * as todos from './services/todos'
import * as companion from './services/companion'
import * as jarvis from './services/jarvis'
import * as whatsapp from './services/whatsapp'
import * as voice from './services/voice'
import { isWatchingTask, runFlow, stopWatchingTask, watchTaskActions } from './services/actions'
import { stopWatchesForTask } from './services/watchers'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { dirname, join, resolve, sep } from 'path'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // A rejected handler used to vanish: the renderer's loader had no catch, so
  // the panel just rendered empty and the user read that as lost data. Leave a
  // trace on disk for every failure so the next one is diagnosable.
  type Handler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
  const rawHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: Handler) =>
    rawHandle(channel, async (event, ...args: any[]) => {
      try {
        return await listener(event, ...args)
      } catch (err) {
        const line = `[${new Date().toISOString()}] ipc ${channel} failed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`
        console.error(line)
        try {
          appendFileSync(join(app.getPath('userData'), 'error.log'), line)
        } catch {
          // logging must never be the thing that breaks a handler
        }
        throw err
      }
    })) as typeof ipcMain.handle

  // --- tasks ---
  ipcMain.handle(IPC.TASKS_LIST, () => tasks.listTasks())
  ipcMain.handle(IPC.TASKS_GET, (_e, id: string) => tasks.getTask(id))
  ipcMain.handle(IPC.TASKS_CREATE, (_e, input: CreateTaskInput) => tasks.createTask(input))
  ipcMain.handle(IPC.TASKS_UPDATE, (_e, id: string, input: UpdateTaskInput) =>
    tasks.updateTask(id, input)
  )
  ipcMain.handle(IPC.TASKS_DELETE, (_e, id: string) => {
    // Everything holding handles into the folder goes first: the task's
    // panes (a parked PDF viewer pins its file), its actions watcher (open
    // dir handle), and its page watches (they'd keep polling a ghost).
    paneManager.closeByOwner(id)
    stopWatchingTask(id)
    stopWatchesForTask(id)
    const result = tasks.deleteTask(id)
    if (!result.ok) {
      // The task SURVIVES a failed delete — restore its action channel (its
      // panes/watches are honestly gone, but a background chat must not lose
      // its executor silently).
      watchTaskActions(id)
      const win = getWindow()
      if (win && !win.isDestroyed())
        win.webContents.send(IPC.APP_EVENT, { type: 'toast', text: `Delete failed: ${result.reason}` })
    }
    return result
  })
  ipcMain.handle(IPC.TASKS_OPEN, (_e, id: string) => {
    const result = tasks.openTask(id)
    // App-action protocol only exists where AI exists. Watchers for other
    // tasks stay live — background chats keep their action channel.
    if (result && !result.task.aiDisabled) watchTaskActions(id)
    return result
  })
  ipcMain.handle(IPC.TASKS_STATS, () => tasks.homeStats())
  ipcMain.handle(IPC.TASKS_SET_CODING, (_e, id: string, coding: boolean) =>
    tasks.setTaskCoding(id, coding)
  )
  ipcMain.handle(IPC.TASKS_SET_PRIVACY, (_e, id: string, aiDisabled: boolean) => {
    const wasWatched = isWatchingTask(id)
    paneManager.closeByOwner(id) // pane file handles would block the folder move
    stopWatchingTask(id)
    if (aiDisabled) stopWatchesForTask(id)
    const result = tasks.setTaskPrivacy(id, aiDisabled)
    if (wasWatched && result && !result.aiDisabled) watchTaskActions(id)
    return result
  })
  ipcMain.handle(IPC.SCRATCH_GET, () => {
    const scratch = tasks.getOrCreateScratch()
    watchTaskActions(scratch.id) // chat-on-scratchpad can drive the app too
    return { task: scratch, resources: resources.listResources(scratch.id) }
  })
  ipcMain.handle(IPC.SCRATCH_SAVE, (_e, name: string) => tasks.saveScratchSession(name))

  // --- resources ---
  ipcMain.handle(IPC.RESOURCES_LIST, (_e, taskId: string) => resources.listResources(taskId))
  ipcMain.handle(IPC.RESOURCES_ADD_URL, (_e, taskId: string, title: string, url: string) => {
    const r = resources.addUrlResource(taskId, title, url)
    tasks.refreshClaudeMd(taskId)
    return r
  })
  ipcMain.handle(IPC.RESOURCES_ADD_NOTE, (_e, taskId: string, title: string) => {
    const task = tasks.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const r = resources.addNoteResource(taskId, task.folderPath, title)
    tasks.refreshClaudeMd(taskId)
    return r
  })
  ipcMain.handle(IPC.RESOURCES_ADD_PDF, async (_e, taskId: string) => {
    const task = tasks.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Add PDF to task',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const added = result.filePaths.map((p) => resources.addPdfResource(taskId, p, task.folderPath))
    // Extract plain text in the background so chat/questions can read it.
    // Question generation is user-initiated (✨ menu), never automatic.
    // Per-file isolation: one corrupt PDF must not sink the good ones' text
    // extraction or skip the inventory refresh.
    void Promise.all(
      added.map((r) => resources.ensurePdfText(r.filePath!).catch(() => null))
    ).then(() => {
      tasks.refreshClaudeMd(taskId)
    })
    tasks.refreshClaudeMd(taskId)
    return added
  })
  ipcMain.handle(IPC.RESOURCES_RENAME, (_e, id: string, taskId: string, title: string) => {
    resources.renameResource(id, title)
    tasks.refreshClaudeMd(taskId)
  })
  ipcMain.handle(IPC.RESOURCES_REMOVE, (_e, id: string, taskId: string) => {
    resources.removeResource(id)
    tasks.refreshClaudeMd(taskId)
  })
  ipcMain.handle(IPC.RESOURCES_REORDER, (_e, taskId: string, orderedIds: string[]) =>
    resources.reorderResources(taskId, orderedIds)
  )

  ipcMain.handle(IPC.RESOURCES_OPEN_EXTERNAL, (_e, target: { url?: string; filePath?: string }) => {
    // Scheme allowlist: model-authored markdown can contain arbitrary hrefs,
    // and shell.openExternal on a file:// or custom-scheme URL is a code-
    // execution primitive if the user clicks it.
    if (target.url && /^(https?|mailto):/i.test(target.url)) shell.openExternal(target.url)
    else if (target.filePath) shell.openPath(target.filePath)
  })

  // --- panes ---
  ipcMain.handle(IPC.PANES_OPEN, (_e, paneId: string, target: PaneTarget, ownerId: string) =>
    paneManager.open(paneId, target, ownerId)
  )
  ipcMain.handle(IPC.PANES_SET_BOUNDS, (_e, paneId: string, bounds: PaneBounds) =>
    paneManager.setBounds(paneId, bounds)
  )
  ipcMain.handle(IPC.PANES_SET_VISIBLE, (_e, paneId: string | null, visible: boolean) => {
    if (paneId === null) paneManager.setAllHidden(!visible)
    else paneManager.setVisible(paneId, visible)
  })
  ipcMain.handle(
    IPC.PANES_NAVIGATE,
    (_e, paneId: string, action: { url?: string; nav?: 'back' | 'forward' | 'reload' }) =>
      paneManager.navigate(paneId, action)
  )
  ipcMain.handle(IPC.PANES_CLOSE, (_e, paneId: string) => paneManager.close(paneId))
  ipcMain.handle(IPC.PANES_CLOSE_ALL, () => paneManager.closeAll())
  ipcMain.handle(IPC.PANES_PARK, () => paneManager.parkAll())
  ipcMain.handle(IPC.PANES_TYPE_ACTIVE, (_e, text: string) =>
    paneManager.typeToFirstVisible(text)
  )
  ipcMain.handle(IPC.PANES_FOCUS, (_e, paneId: string) => paneManager.focusPane(paneId))
  ipcMain.on(IPC.PANES_DOM_FOCUS, (_e, focused: boolean) => paneManager.setDomFocused(focused))

  // --- notes ---
  ipcMain.handle(IPC.NOTES_READ, (_e, filePath: string) => resources.readNote(filePath))
  ipcMain.handle(IPC.NOTES_WRITE, (_e, filePath: string, content: string) =>
    resources.writeNote(filePath, content)
  )

  // Live-reload notes when edited outside the editor (e.g. by Claude). The
  // watcher must track the CURRENT sender: after a renderer reload the old
  // closure held a destroyed webContents and live-reload silently died.
  const noteWatchers = new Map<string, { watcher: FSWatcher; sender: Electron.WebContents }>()
  ipcMain.handle(IPC.NOTES_WATCH, (e, filePath: string) => {
    const existing = noteWatchers.get(filePath)
    if (existing) {
      if (existing.sender === e.sender && !existing.sender.isDestroyed()) return
      existing.watcher.close() // stale sender — rebind below
      noteWatchers.delete(filePath)
    }
    let debounce: NodeJS.Timeout | null = null
    try {
      const w = watch(filePath, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          const entry = noteWatchers.get(filePath)
          if (entry && !entry.sender.isDestroyed())
            entry.sender.send(IPC.NOTES_CHANGED, { filePath })
        }, 200)
      })
      w.on('error', () => {
        // File deleted/renamed externally — drop the watcher instead of crashing.
        w.close()
        noteWatchers.delete(filePath)
      })
      noteWatchers.set(filePath, { watcher: w, sender: e.sender })
    } catch {
      // File may not exist yet; watching is best-effort.
    }
  })
  ipcMain.handle(IPC.NOTES_UNWATCH, (_e, filePath: string) => {
    noteWatchers.get(filePath)?.watcher.close()
    noteWatchers.delete(filePath)
  })

  // --- global assistant ---
  ipcMain.handle(IPC.ASSISTANT_ASK, (e, prompt: string) => assistant.askAssistant(prompt, e.sender))
  ipcMain.handle(IPC.ASSISTANT_CANCEL, () => assistant.cancelAssistant())
  ipcMain.handle(IPC.ASSISTANT_HISTORY, (_e, limit?: number) => assistant.assistantHistory(limit))
  ipcMain.handle(IPC.QUICKFETCH_RUN, (_e, query: string) => quickfetch.quickFetch(query))
  ipcMain.handle(IPC.WHATSAPP_SEND, (_e, recipient: string, message: string) =>
    whatsapp.sendWhatsApp(recipient, message)
  )
  ipcMain.on(IPC.WHATSAPP_PREWARM, () => {
    try {
      whatsapp.prewarmWhatsApp()
    } catch {
      // speculative — never surfaces
    }
  })

  // --- usage / cost ---
  ipcMain.handle(IPC.USAGE_TASK, (_e, taskId: string) => usage.taskUsage(taskId))
  ipcMain.handle(IPC.USAGE_SUMMARY, () => usage.usageSummary())
  ipcMain.handle(IPC.USAGE_ACTIVITY, () => usage.activityStats())

  // --- accounts ---
  ipcMain.handle(IPC.ACCOUNTS_LIST, () => accounts.accountStatuses())
  ipcMain.handle(IPC.ACCOUNTS_OPEN_LOGIN, (_e, providerId: string) =>
    accounts.openLogin(providerId, getWindow())
  )

  // --- session / timer / lockdown ---
  ipcMain.handle(
    IPC.SESSION_START,
    (_e, taskId: string, mode?: 'stopwatch' | 'pomodoro', workMin?: number, breakMin?: number) =>
      timer.start(taskId, mode ?? 'stopwatch', workMin, breakMin)
  )
  ipcMain.handle(IPC.SESSION_PAUSE, () => timer.pause())
  ipcMain.handle(IPC.SESSION_RESUME, () => timer.resume())
  ipcMain.handle(IPC.SESSION_END, () => timer.end())
  ipcMain.handle(IPC.SESSION_STATE, () => timer.getState())
  ipcMain.handle(IPC.LOCKDOWN_HOLD_START, () => timer.holdStart())
  ipcMain.handle(IPC.LOCKDOWN_HOLD_CANCEL, () => timer.holdCancel())
  ipcMain.handle(IPC.LOCKDOWN_RELEASE_HOLD, () => timer.holdRelease())
  ipcMain.handle(IPC.LOCKDOWN_RELEASE_PHRASE, (_e, phrase: string) => timer.phraseRelease(phrase))

  // --- background activity ---
  ipcMain.handle(IPC.ACTIVITY_LIST, () => activity.listActivity())
  ipcMain.handle(IPC.CHAT_RUNNING, () => chat.runningSessionIds())

  // --- chat ---
  ipcMain.handle(IPC.CHAT_LIST_SESSIONS, (_e, taskId: string) => chat.listChatSessions(taskId))
  ipcMain.handle(IPC.CHAT_NEW_SESSION, (_e, taskId: string) => chat.newChatSession(taskId))
  ipcMain.handle(IPC.CHAT_HISTORY, (_e, chatSessionId: string) => chat.chatHistory(chatSessionId))
  ipcMain.handle(IPC.CHAT_SEND, (e, chatSessionId: string, text: string) =>
    chat.sendChat(chatSessionId, text, e.sender)
  )
  ipcMain.handle(IPC.CHAT_CANCEL, (_e, chatSessionId: string) => chat.cancelChat(chatSessionId))

  // --- questions / spaced repetition ---
  ipcMain.handle(
    IPC.QUESTIONS_GENERATE,
    (_e, taskId: string, resourceId: string, mode: 'generate' | 'extract') =>
      questions.enqueueGeneration(taskId, resourceId, mode)
  )
  ipcMain.handle(IPC.QUESTIONS_DUE, (_e, limit?: number, taskId?: string) =>
    questions.dueQuestions(limit, taskId)
  )
  ipcMain.handle(IPC.QUESTIONS_LIST, (_e, taskId: string) => questions.listQuestions(taskId))
  ipcMain.handle(IPC.QUESTIONS_SUSPEND, (_e, id: string, suspended: boolean) =>
    questions.suspendQuestion(id, suspended)
  )
  ipcMain.handle(IPC.QUESTIONS_DELETE, (_e, id: string) => questions.deleteQuestion(id))
  ipcMain.handle(
    IPC.QUESTIONS_ANSWER,
    (_e, id: string, input: { selfGrade?: 0 | 1 | 2 | 3; typedAnswer?: string }) =>
      questions.answerQuestion(id, input)
  )

  // --- to-dos ---
  ipcMain.handle(IPC.TODOS_LIST, (_e, includeDone?: boolean) => todos.listTodos(includeDone))
  ipcMain.handle(
    IPC.TODOS_ADD,
    (_e, input: { text: string; dueDate?: string | null; priority?: number }) =>
      todos.addTodo(input)
  )
  ipcMain.handle(IPC.TODOS_SET_DONE, (_e, id: string, done: boolean) => todos.setTodoDone(id, done))
  ipcMain.handle(IPC.TODOS_DELETE, (_e, id: string) => todos.deleteTodo(id))

  // --- key terms ---
  ipcMain.handle(IPC.TERMS_LIST, (_e, taskId: string) => questions.keyTerms(taskId))
  ipcMain.handle(IPC.TERMS_ADD_QUESTIONS, (_e, taskId: string) => questions.termsToQuestions(taskId))

  // --- note images ---
  ipcMain.handle(
    IPC.NOTES_SAVE_IMAGE,
    (_e, notePath: string, data: Uint8Array, ext: string) => {
      const dir = join(dirname(notePath), 'files')
      mkdirSync(dir, { recursive: true })
      const safeExt = /^[a-z0-9]{2,5}$/i.test(ext) ? ext : 'png'
      const name = `img-${Date.now()}.${safeExt}`
      writeFileSync(join(dir, name), Buffer.from(data))
      return `files/${name}`
    }
  )

  // Preview needs image bytes inline: the renderer runs on an http origin in
  // dev, which can't load file:// subresources. Return a data: URL instead,
  // resolved strictly inside the note's own folder.
  ipcMain.handle(IPC.NOTES_READ_IMAGE, (_e, notePath: string, src: string) => {
    try {
      const base = dirname(notePath)
      const full = resolve(base, decodeURI(src))
      if (full !== base && !full.startsWith(base + sep)) return null
      if (!existsSync(full)) return null
      const ext = (full.split('.').pop() ?? 'png').toLowerCase()
      const mime =
        ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : ext === 'svg'
                ? 'image/svg+xml'
                : 'image/png'
      return `data:${mime};base64,${readFileSync(full).toString('base64')}`
    } catch {
      return null
    }
  })

  // --- Jarvis (universal agent) ---
  ipcMain.handle(IPC.JARVIS_ASK, (e, prompt: string) => jarvis.askJarvisIpc(prompt, e.sender))
  ipcMain.handle(IPC.JARVIS_CANCEL, () => jarvis.cancelJarvis())
  ipcMain.handle(IPC.JARVIS_NEW, () => jarvis.resetJarvisSession())

  // --- voice ---
  ipcMain.handle(IPC.VOICE_STATUS, () => ({
    modelsReady: voice.voiceModelsReady(),
    listening: voice.voiceListening()
  }))
  ipcMain.handle(IPC.VOICE_DOWNLOAD, (e) =>
    voice.downloadVoiceModels((pct, file) => {
      if (!e.sender.isDestroyed()) e.sender.send(IPC.VOICE_DOWNLOAD_PROGRESS, { pct, file })
    })
  )
  ipcMain.handle(IPC.VOICE_START, () => voice.voiceStart())
  ipcMain.handle(IPC.VOICE_STOP, () => voice.voiceStop())
  ipcMain.on(IPC.VOICE_PREWARM, () => {
    try {
      voice.prewarmVoice()
    } catch {
      // speculative
    }
  })
  ipcMain.on(IPC.VOICE_AUDIO_DONE, () => voice.onAudioDone())
  ipcMain.handle(IPC.VOICE_TTS_STATUS, () => ({ ready: voice.ttsReady() }))
  ipcMain.handle(IPC.VOICE_TTS_DOWNLOAD, (e) =>
    voice.downloadTts((pct, file) => {
      if (!e.sender.isDestroyed()) e.sender.send(IPC.VOICE_TTS_PROGRESS, { pct, file })
    })
  )
  // High-frequency PCM chunks: plain send, zero round-trips. The conversion
  // stays inside the try — a misaligned buffer must not throw in ipcMain.on.
  ipcMain.on(IPC.VOICE_CHUNK, (_e, buf: ArrayBuffer) => {
    try {
      voice.acceptAudioChunk(new Float32Array(buf))
    } catch {
      // malformed chunk — drop it
    }
  })

  // --- phone companion ---
  ipcMain.handle(IPC.COMPANION_STATUS, () => companion.companionStatus())
  ipcMain.handle(IPC.COMPANION_SET_ENABLED, (_e, enabled: boolean) => {
    settings.setSettings({ companionEnabled: enabled })
    if (enabled) companion.startCompanion(getWindow)
    else companion.stopCompanion()
    return companion.companionStatus()
  })
  ipcMain.handle(IPC.COMPANION_QR, () => companion.companionQr())
  ipcMain.handle(IPC.COMPANION_TAILSCALE_SERVE, () =>
    companion.tailscaleServe(settings.getSettings().companionPort)
  )
  ipcMain.handle(IPC.COMPANION_TEST_PUSH, () =>
    companion.notifyPhone('ASIT', '🔔 Test notification — pairing works!', 'test')
  )
  ipcMain.handle(IPC.COMPANION_REVOKE, () => {
    companion.revokeCompanionPairing()
    return companion.companionStatus()
  })
  ipcMain.handle(IPC.COMPANION_PAIR_APPROVE, (_e, requestId: string) => {
    companion.approvePair(requestId)
    return companion.companionStatus()
  })
  ipcMain.handle(IPC.COMPANION_PAIR_DENY, (_e, requestId: string) => {
    companion.denyPair(requestId)
    return companion.companionStatus()
  })

  // --- backup / sharing ---
  ipcMain.handle(IPC.TRANSFER_EXPORT, async () => {
    const win = getWindow()
    if (!win) return null
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win, {
      title: 'Export ASIT backup',
      defaultPath: `asit-backup-${stamp}.zip`,
      filters: [{ name: 'ASIT backup', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return null
    return transfer.exportToZip(result.filePath)
  })
  ipcMain.handle(IPC.TRANSFER_IMPORT, async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Import ASIT backup',
      filters: [{ name: 'ASIT backup', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return transfer.importFromZip(result.filePaths[0])
  })

  // --- skills ---
  ipcMain.handle(IPC.SKILLS_LIST, () => skills.listSkills())
  ipcMain.handle(IPC.SKILLS_DELETE, (_e, name: string) => skills.deleteSkill(name))
  // Instant deterministic replay of a skill's asit-flow block (no model).
  ipcMain.handle(IPC.SKILLS_RUN, async (_e, taskId: string, name: string) => {
    const skill = skills.listSkills().find((s) => s.name === name)
    if (!skill) return { ran: false, log: [`skill "${name}" not found`] }
    const flow = skills.extractFlow(skill.content)
    if (!flow) return { ran: false, log: ['skill has no auto-flow block'] }
    const log = await runFlow(taskId, flow as never)
    return { ran: true, log }
  })

  // --- global file library ---
  ipcMain.handle(IPC.LIBRARY_LIST, () => library.listLibrary())
  ipcMain.handle(IPC.LIBRARY_ADD, () => library.addToLibrary(getWindow()))
  ipcMain.handle(IPC.LIBRARY_REMOVE, (_e, name: string) => library.removeFromLibrary(name))
  ipcMain.handle(IPC.LIBRARY_ATTACH, (_e, taskId: string, name: string) =>
    library.attachToTask(taskId, name)
  )

  // --- settings ---
  ipcMain.handle(IPC.SNIPPETS_GET, () => settings.getSettings().snippets)
  // Live "/otp" snippet + one-time-code autofill for embedded pages. Literal
  // channel: the pane preload is sandboxed and can't import the contract.
  ipcMain.handle('otp:get', async () => {
    const code = await quickfetch.fetchOtpForAutofill()
    const win = getWindow()
    if (code && win && !win.isDestroyed()) {
      win.webContents.send(IPC.APP_EVENT, { type: 'toast', text: `🔑 Filled code ${code} from your mail` })
    }
    return code
  })
  ipcMain.handle(IPC.SETTINGS_GET, () => settings.getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<Settings>) => {
    const result = settings.setSettings(patch)
    invalidateClaudePathCache()
    return result
  })
}
