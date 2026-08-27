import { app, BrowserWindow, dialog, globalShortcut, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { IPC } from '@shared/ipc-contract'
import { join } from 'path'
import { getDb, closeDb } from './db'
import { registerIpc } from './ipc'
import { errorLogPath, logError } from './log'
import { applyBrowserIdentity, browserUserAgent } from './services/useragent'
import { initUpdater } from './services/updater'
import { paneManager } from './services/panes'
import { initBrowserFilters, loadExtensions } from './services/browser'
import { initScheduler, stopScheduler } from './services/scheduler'
import { lockdown } from './services/lockdown'
import { timer } from './services/timer'
import { initQuestions } from './services/questions'
import { initActions, watchJarvisActions } from './services/actions'
import { initWorkflows, sweepInterruptedRuns } from './services/workflows'
import { bus } from './services/bus'
import { initUsage } from './services/usage'
import { initActivity } from './services/activity'
import { initWatchers } from './services/watchers'
import { initTodos } from './services/todos'
import { startCompanion, stopCompanion } from './services/companion'
import { initVoice, shutdownVoice } from './services/voice'
import { getSettings } from './services/settings'
import {
  getOrCreateJarvis,
  getOrCreateScratch,
  listTasks,
  refreshClaudeMd,
  tasksRoot,
  trashRoot,
  writeTasksIndex
} from './services/tasks'

let mainWindow: BrowserWindow | null = null

// Present as plain, current Chrome everywhere. The default UA advertises
// "Electron/33" + Chromium 130, and sites that UA-sniff (WhatsApp Web's
// "update Chrome" wall, Google's "browser may not be secure" login block)
// reject exactly that string — the ENGINE is fine, the label isn't. This is
// the standard fix used by Electron-based clients; it affects both request
// headers and navigator.userAgent.
// Identify as the Chromium we actually are, consistently in every channel.
// A hard-coded string here claimed Chrome 139 on an engine that was 130, and
// claimed Windows on macOS — see services/useragent.ts.
app.userAgentFallback = browserUserAgent()

// Last-resort net: an uncaught main-process exception must not take down the
// user's whole session (timers, agents, panes) with a modal crash dialog.
// Log it, surface a toast, keep running. Smoke modes keep the default
// fail-fast behavior so tests can't silently pass over a crash.
if (!Object.entries(process.env).some(([k, v]) => k.startsWith('ASIT_SMOKE') && v === '1')) {
  process.on('uncaughtException', (err) => {
    try {
      logError('uncaught', err)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.APP_EVENT, {
          type: 'toast',
          text: `⚠️ Internal error (logged): ${String(err.message).slice(0, 120)}`
        })
      }
    } catch {
      // even the net must never throw
    }
  })
  process.on('unhandledRejection', (reason) => {
    try {
      logError('unhandledRejection', reason)
    } catch {
      // ignore
    }
  })
}

// One instance only — a second launch focuses the existing window instead of
// opening a rival process against the same database.
// Strict '1' check: a leftover ASIT_SMOKE=0 in a shell must not silently
// redirect the real app's data folders.
const isSmokeMode = Object.entries(process.env).some(
  ([k, v]) => k.startsWith('ASIT_SMOKE') && v === '1'
)
if (!isSmokeMode && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#12141a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  paneManager.attach(mainWindow)
  lockdown.attach(mainWindow)

  // External links from the app UI open in the default browser — scheme
  // allowlisted so a model-authored href can't hand the OS a file:// or
  // custom-scheme URL (same guard as the pane + resources handlers).
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^(https?|mailto):/i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  if (isSmokeMode) {
    // Full isolation: smoke tests must never touch the real user data. They
    // already get their own userData (electron run by script path); this keeps
    // their task folders + tasks index out of the real Documents\ASIT too.
    const { tmpdir } = require('os') as typeof import('os')
    const { join: joinPath } = require('path') as typeof import('path')
    const { rmSync } = require('fs') as typeof import('fs')
    const docs = joinPath(tmpdir(), 'asit-smoke-docs')
    app.setPath('documents', docs)

    // START FROM NOTHING. The smoke profile persisted between runs, so state
    // piled up across every invocation — thousands of leftover tasks — until
    // a test that creates a workspace collided with one from days ago and
    // failed for a reason that had nothing to do with the code. A suite that
    // rots as you use it teaches you to ignore it. Voice models are cached
    // elsewhere in userData and are deliberately NOT cleared (130MB).
    const userData = app.getPath('userData')
    for (const p of [
      docs,
      joinPath(userData, 'backups'),
      joinPath(userData, 'asit.db'),
      joinPath(userData, 'asit.db-wal'),
      joinPath(userData, 'asit.db-shm')
    ]) {
      rmSync(p, { recursive: true, force: true })
    }
  }

  getDb() // open DB + run migrations before any IPC arrives

  if (process.env.ASIT_SMOKE === '1') {
    runSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_CHAT === '1') {
    runChatSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_QGEN === '1') {
    runQuestionSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_AGENT === '1') {
    runAgentSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_TRANSFER === '1') {
    runTransferSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_UI === '1') {
    runUiSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_PANES === '1') {
    runPanesSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_COMPANION === '1') {
    runCompanionSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_JARVIS === '1') {
    runJarvisSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_VOICE === '1') {
    runVoiceSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_SECURITY === '1') {
    runSecuritySmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_TERMINAL === '1') {
    runTerminalSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_WORKFLOWS === '1') {
    runWorkflowsSmokeTest()
    return
  }
  if (process.env.ASIT_SMOKE_GOOGLE === '1') {
    runGoogleSigninProbe()
    return
  }

  // Ad/tracker blocking installs on the browse partition before any pane
  // exists; saved extensions load in the background.
  // Before any pane loads: the browse partition must present a consistent
  // browser identity or sign-in flows refuse it.
  applyBrowserIdentity('persist:asit-browse')
  initBrowserFilters()
  void loadExtensions()
  initScheduler() // time-based agent runs

  // Each init is isolated. These used to run as one straight sequence, so a
  // throw in any of them skipped every later one — and if it landed before
  // registerIpc, the app came up with NO ipc handlers at all and the only
  // symptom was the UI reporting that some remote method failed.
  for (const [name, init] of [
    ['ipc', () => registerIpc(() => mainWindow)],
    ['timer', () => timer.init(() => mainWindow)],
    ['questions', () => initQuestions(() => mainWindow)],
    ['actions', () => initActions(() => mainWindow)],
    [
      'workflows',
      () => {
        initWorkflows(() => mainWindow)
        // Anything still "running" died with the previous process — panes
        // did too, so resuming would be fake safety. Mark and move on.
        sweepInterruptedRuns()
        // Schedules finally have a UI; tell it when they change (fires,
        // agent-created schedules, roll-forwards).
        bus.on('changed', (what: string) => {
          if (what === 'schedules') mainWindow?.webContents.send(IPC.SCHEDULES_CHANGED)
        })
      }
    ],
    ['usage', () => initUsage(() => mainWindow)],
    ['activity', () => initActivity(() => mainWindow)],
    ['watchers', () => initWatchers(() => mainWindow)],
    ['todos', () => initTodos(() => mainWindow)],
    ['voice', () => initVoice(() => mainWindow)],
    ['updater', () => initUpdater(() => mainWindow)]
  ] as const) {
    try {
      init()
    } catch (err) {
      logError(`init:${name}`, err)
    }
  }
  // Jarvis's action file is watched for the app's whole lifetime — the
  // universal agent can act regardless of which screen is open.
  try {
    watchJarvisActions(getOrCreateJarvis().id)
  } catch (err) {
    console.error('jarvis init failed:', err)
  }
  if (getSettings().companionEnabled) startCompanion(() => mainWindow)

  createWindow()

  // Housekeeping walks EVERY task folder, and those live in OneDrive — a
  // cold boot can leave it blocking on cloud placeholders for a long time.
  // Run it after the window exists so a slow (or failing) filesystem can
  // never delay or poison the first data load, and never take startup down.
  setImmediate(() => {
    try {
      relocateLegacyTrash() // old .trash lived inside the assistant-readable tree
      writeTasksIndex() // keep the global-assistant index fresh from startup
      refreshAllTaskContexts() // guidance updates reach existing tasks immediately
    } catch (err) {
      console.error('startup housekeeping failed:', err)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  // Without this, a startup throw (e.g. the database failed to open) was
  // swallowed by the unhandledRejection logger: the process sat in Task
  // Manager with NO window, and relaunching just "focused" a window that
  // didn't exist. Tell the user, then exit cleanly.
  logError('startup', err)
  try {
    dialog.showErrorBox(
      'ASIT could not start',
      `${err instanceof Error ? err.message : String(err)}\n\nDetails were written to:\n${errorLogPath()}`
    )
  } catch {
    // dialog can fail before ready — the log entry above still exists
  }
  app.exit(1)
})

// The database must be folded away on EVERY exit path, not just the one where
// the user closes the last window. An update installing itself, a Windows
// shutdown, or anything calling app.quit() directly all skip the handler
// below — and each of those leaves a hot WAL that the next launch has to
// recover from. closeDb() checkpoints and closes; it is idempotent, so
// running here and again below is harmless.
app.on('before-quit', () => {
  try {
    closeDb()
  } catch (err) {
    logError('shutdown closeDb', err)
  }
})

app.on('window-all-closed', async () => {
  // Reap CLI children first — otherwise a running generation job would keep
  // spending tokens after the app closes (Windows children outlive parents).
  const { killAllClaudeChildren } = await import('./services/claude')
  killAllClaudeChildren()
  globalShortcut.unregisterAll() // navigation keys grabbed while a page had focus
  const { closeWhatsApp } = await import('./services/whatsapp')
  closeWhatsApp()
  shutdownVoice()
  stopScheduler()
  stopCompanion()
  const { shutdownTerminals } = await import('./services/terminal')
  shutdownTerminals() // orphaned shells would outlive the app (Windows)
  // Any embedded app window must go back to the desktop, or the user is left
  // with a window parented to a process that no longer exists.
  const { releaseAllWindows } = await import('./services/appwindows')
  releaseAllWindows()
  closeDb()
  app.quit()
})

// Regenerate every task's CLAUDE.md at startup so instruction fixes ship to
// existing tasks, not just new ones.
function refreshAllTaskContexts(): void {
  try {
    for (const t of listTasks()) refreshClaudeMd(t.id)
    refreshClaudeMd(getOrCreateScratch().id)
  } catch (err) {
    console.error('task context refresh failed:', err)
  }
}

// One-time migration: trash used to live at tasks\.trash — inside the global
// assistant's readable tree. Move it to ASIT\.trash where nothing AI can reach.
function relocateLegacyTrash(): void {
  try {
    const legacy = join(tasksRoot(), '.trash')
    if (!existsSync(legacy)) return
    mkdirSync(trashRoot(), { recursive: true })
    for (const entry of readdirSync(legacy)) {
      try {
        renameSync(join(legacy, entry), join(trashRoot(), entry))
      } catch (err) {
        console.error('trash relocation failed for', entry, err)
      }
    }
  } catch (err) {
    console.error('legacy trash relocation failed:', err)
  }
}

// Headless backup round-trip check: ASIT_SMOKE_TRANSFER=1 electron out/main/index.js
// Proves: export includes tasks/files/questions, excludes sensitive data;
// import recreates everything as new tasks with SR state intact.
async function runTransferSmokeTest(): Promise<void> {
  const { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } = await import('fs')
  const { join } = await import('path')
  const os = await import('os')
  const tasks = await import('./services/tasks')
  const settingsSvc = await import('./services/settings')
  const transfer = await import('./services/transfer')
  const { getDb, newId, nowIso } = await import('./db')

  const fail = (msg: string): never => {
    console.log(`[transfer-smoke] FAIL: ${msg}`)
    app.exit(1)
    throw new Error(msg)
  }

  const originalPhrase = settingsSvc.getSettings().escapePhrase
  try {
    // Distinctive escape phrase to prove it never leaks into the export.
    settingsSvc.setSettings({ escapePhrase: 'SECRET-PHRASE-CANARY-12345' })

    const task = tasks.createTask({ title: 'Transfer Smoke', description: 'x', priority: 1 })
    writeFileSync(join(task.folderPath, 'notes.md'), '# Notes\n\nTRANSFER-NOTE-OK\n')
    mkdirSync(join(task.folderPath, 'pdfs'), { recursive: true })
    writeFileSync(join(task.folderPath, 'pdfs', 'doc.pdf'), 'fake-pdf-bytes')
    const db = getDb()
    const rid = newId()
    db.prepare(
      `INSERT INTO resources (id, task_id, kind, title, url, file_path, position, created_at)
       VALUES (?, ?, 'pdf', 'Doc', NULL, ?, 0, ?)`
    ).run(rid, task.id, join(task.folderPath, 'pdfs', 'doc.pdf'), nowIso())
    db.prepare(
      `INSERT INTO questions (id, task_id, resource_id, question, answer, ease, interval_days, reps, lapses, due_at, created_at, origin)
       VALUES (?, ?, ?, 'tq', 'ta', 2.1, 5, 3, 1, ?, ?, 'extracted')`
    ).run(newId(), task.id, rid, nowIso(), nowIso())

    // The things that are not attached to a workspace. A backup that loses
    // these is a partial one: you move machines and find your to-do list and
    // everything you taught the agent gone.
    const todosSvc = await import('./services/todos')
    const skillsSvc = await import('./services/skills')
    const memorySvc = await import('./services/memory')
    todosSvc.addTodo({ text: 'TRANSFER-SMOKE-TODO' })
    skillsSvc.saveSkill('transfer-smoke-skill', '# transfer smoke\nbody')
    memorySvc.rememberFact('TRANSFER-SMOKE-FACT', 'smoke')

    const zipPath = join(os.tmpdir(), `asit-smoke-${Date.now()}.zip`)
    const exported = transfer.exportToZip(zipPath)
    console.log(`[transfer-smoke] exported ${exported.tasks} tasks, ${exported.questions} questions`)

    // Sensitive-data audit on the raw archive bytes.
    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(zipPath)
    const dataJson = zip.readAsText('data.json')
    if (dataJson.includes('SECRET-PHRASE-CANARY')) fail('escape phrase leaked into export')
    if (dataJson.includes('claudePath') || dataJson.includes('.local')) fail('claude path leaked')
    if (/chat_messages|chat_sessions/i.test(dataJson)) fail('chat data leaked')
    console.log('[transfer-smoke] sensitive-data audit clean ✓')

    // Zip entry names must use forward slashes or a macOS import cannot match
    // the files/<key>/ prefix a Windows export wrote.
    const badSep = zip.getEntries().find((e) => e.entryName.includes('\\'))
    if (badSep) fail(`zip entry uses a backslash, so it will not unpack cross-platform: ${badSep.entryName}`)
    console.log('[transfer-smoke] archive paths are portable across platforms ✓')

    tasks.deleteTask(task.id)
    // Wipe the non-workspace data too, so the import has to genuinely restore
    // it rather than finding it already there.
    for (const t of todosSvc.listTodos()) {
      if (t.text === 'TRANSFER-SMOKE-TODO') todosSvc.deleteTodo(t.id)
    }
    skillsSvc.deleteSkill('transfer-smoke-skill')
    memorySvc.forgetFact('TRANSFER-SMOKE-FACT')

    const imported = transfer.importFromZip(zipPath)
    console.log(`[transfer-smoke] imported ${imported.tasks} tasks, ${imported.questions} questions`)

    if (!todosSvc.listTodos().some((t) => t.text === 'TRANSFER-SMOKE-TODO'))
      fail('to-dos did not survive the round trip')
    if (!skillsSvc.listSkills().some((k) => k.name === 'transfer-smoke-skill'))
      fail('skills did not survive the round trip')
    if (!memorySvc.listFacts().some((f) => f.text.includes('TRANSFER-SMOKE-FACT')))
      fail('shared memory did not survive the round trip')
    // Importing twice must not duplicate anything.
    transfer.importFromZip(zipPath)
    const dupes = todosSvc.listTodos().filter((t) => t.text === 'TRANSFER-SMOKE-TODO').length
    if (dupes !== 1) fail(`importing twice duplicated a to-do (${dupes} copies)`)
    console.log('[transfer-smoke] to-dos, skills and memory transfer, and re-import is idempotent ✓')

    const restored = tasks
      .listTasks()
      .find((t) => t.title === 'Transfer Smoke' && t.id !== task.id)
    if (!restored) fail('imported task not found')
    if (!readFileSync(join(restored!.folderPath, 'notes.md'), 'utf-8').includes('TRANSFER-NOTE-OK'))
      fail('notes not restored')
    if (!existsSync(join(restored!.folderPath, 'pdfs', 'doc.pdf'))) fail('pdf not restored')
    const q = db
      .prepare('SELECT * FROM questions WHERE task_id = ?')
      .get(restored!.id) as Record<string, unknown>
    if (!q || q.ease !== 2.1 || q.reps !== 3 || q.origin !== 'extracted')
      fail('question SR state not preserved')
    console.log('[transfer-smoke] files + questions + SR state restored ✓')

    tasks.deleteTask(restored!.id)
    rmSync(zipPath, { force: true })
    console.log('[transfer-smoke] PASS: round-trip complete, nothing sensitive exported')
    settingsSvc.setSettings({ escapePhrase: originalPhrase })
    app.exit(0)
  } catch (err) {
    settingsSvc.setSettings({ escapePhrase: originalPhrase })
    console.error('[transfer-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Headless security-invariants check: ASIT_SMOKE_SECURITY=1 electron out/main/index.js
// Locks the agent-containment boundaries so a refactor can't quietly reopen
// them. No CLI needed — drives executeAction/navigateFlow/runFlow directly.
async function runSecuritySmokeTest(): Promise<void> {
  const actions = await import('./services/actions')
  const tasksSvc = await import('./services/tasks')
  const { paneManager } = await import('./services/panes')
  const resourcesSvc = await import('./services/resources')
  const { BrowserWindow } = await import('electron')
  const { join } = await import('path')

  const fail = (msg: string): never => {
    console.error('[security-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }

  try {
    const win = new BrowserWindow({ show: false })
    paneManager.attach(win)
    const task = tasksSvc.createTask({ title: 'Sec Test' })

    // navigate refuses non-http(s) — the file:// read-through exfil.
    paneManager.open('sp', { url: 'https://example.com' }, task.id)
    const navBad = await paneManager.navigateFlow(task.id, 'file:///C:/Windows/win.ini')
    if (!navBad.startsWith('navigate refused')) fail(`file:// navigate allowed: ${navBad}`)
    const navScheme = await paneManager.navigateFlow(task.id, 'chrome://settings')
    if (!navScheme.startsWith('navigate refused')) fail(`chrome:// navigate allowed: ${navScheme}`)
    console.log('[security-smoke] navigate refuses non-http(s) schemes')

    // send_whatsapp refused for a workspace agent.
    const waWs = await actions.executeAction(task.id, {
      action: 'send_whatsapp',
      target: 'x',
      value: 'y'
    })
    if (!waWs.includes('only available to the universal agent'))
      fail(`send_whatsapp not refused for workspace agent: ${waWs}`)

    // workspace re-targeting refused for a workspace agent.
    const reWs = await actions.executeAction(task.id, {
      action: 'add_url',
      workspace: 'Sec Test',
      title: 't',
      url: 'https://x.com'
    })
    if (!reWs.includes('only available to the universal agent'))
      fail(`workspace targeting not refused: ${reWs}`)
    console.log('[security-smoke] send_whatsapp + workspace targeting are Jarvis-only')

    // A skill flow may not send_whatsapp or cross workspaces — even as Jarvis.
    const jarvis = tasksSvc.getOrCreateJarvis()
    const flowLog = await actions.runFlow(jarvis.id, [
      { action: 'send_whatsapp', target: 'x', value: 'y' },
      { action: 'add_url', workspace: 'Sec Test', title: 't', url: 'https://x.com' }
    ] as never)
    if (!flowLog[0]?.includes('not allowed inside a replayed skill flow'))
      fail(`flow send_whatsapp not refused: ${flowLog[0]}`)
    if (!flowLog[1]?.includes('not allowed inside a replayed skill flow'))
      fail(`flow workspace targeting not refused: ${flowLog[1]}`)
    if (resourcesSvc.listResources(task.id).some((r) => r.url?.includes('x.com')))
      fail('flow cross-workspace action leaked through')
    // A poisoned flow must not be able to trash a workspace or trap the user
    // in a locked session either.
    const flowLog2 = await actions.runFlow(task.id, [
      { action: 'delete_workspace', target: 'Sec Test' },
      { action: 'start_focus' }
    ] as never)
    if (!flowLog2[0]?.includes('not allowed inside a replayed skill flow'))
      fail(`flow delete_workspace not refused: ${flowLog2[0]}`)
    if (!flowLog2[1]?.includes('not allowed inside a replayed skill flow'))
      fail(`flow start_focus not refused: ${flowLog2[1]}`)
    console.log('[security-smoke] replayed flows cannot message or cross workspaces')

    // App-command walls: delete_workspace/open_workspace are Jarvis-only, and
    // there is NO verb that stops a focus session (absence, not permission).
    const delAsWorkspace = await actions.executeAction(task.id, {
      action: 'delete_workspace',
      target: 'Sec Test'
    })
    if (!delAsWorkspace.includes('only available to the universal agent'))
      fail(`workspace agent could delete workspaces: ${delAsWorkspace}`)
    for (const verb of ['stop_focus', 'end_focus', 'release_lockdown', 'stop_session']) {
      const tryStop = await actions.executeAction(jarvis.id, { action: verb })
      if (!tryStop.startsWith('unknown action')) fail(`session-stop verb exists: ${verb}`)
    }
    console.log('[security-smoke] delete_workspace is Jarvis-only; no session-stop verb exists')

    // Private workspace unreachable by Jarvis name resolution.
    const priv = tasksSvc.createTask({ title: 'Secret', aiDisabled: true })
    const privTry = await actions.executeAction(jarvis.id, {
      action: 'add_url',
      workspace: 'Secret',
      title: 't',
      url: 'https://x.com'
    })
    if (!privTry.includes('no workspace matching')) fail(`private workspace reachable: ${privTry}`)
    if (resourcesSvc.listResources(priv.id).length !== 0) fail('private workspace mutated')
    console.log('[security-smoke] private workspaces unreachable by name')

    // CLAUDE.md carries the untrusted-data warning.
    tasksSvc.refreshClaudeMd(task.id)
    const claude = (await import('fs')).readFileSync(join(task.folderPath, 'CLAUDE.md'), 'utf-8')
    if (!/UNTRUSTED DATA/i.test(claude)) fail('CLAUDE.md missing untrusted-data security guidance')
    console.log('[security-smoke] CLAUDE.md frames page/notes content as untrusted')

    // --- Sending is deny-by-default, opened only by the user's own words ---
    const guard = await import('./services/guardrails')
    guard.clearSendAuthorization()
    if (guard.sendAuthorized('whatsapp') || guard.sendAuthorized('email'))
      fail('sends authorized with no user request')
    const waCold = await actions.executeAction(jarvis.id, {
      action: 'send_whatsapp',
      target: 'Mom',
      value: 'hi'
    })
    if (!waCold.startsWith('BLOCKED:')) fail(`unrequested whatsapp send allowed: ${waCold}`)

    guard.authorizeSendsFromUserMessage('can you summarize my inbox and tell me what matters')
    if (guard.sendAuthorized('email')) fail('"summarize my inbox" wrongly authorized email sending')
    if (guard.sendAuthorized('whatsapp')) fail('"tell me" wrongly authorized messaging')

    guard.authorizeSendsFromUserMessage('text Mom that I will be late')
    if (!guard.sendAuthorized('whatsapp')) fail('"text Mom that…" did not authorize messaging')
    if (guard.sendAuthorized('email')) fail('a whatsapp request leaked into email authority')

    guard.authorizeSendsFromUserMessage('reply to that email from Dr Chen saying yes')
    if (!guard.sendAuthorized('email')) fail('"reply to that email" did not authorize email')
    console.log('[security-smoke] sends are deny-by-default, granted only by the user message')

    // --- Gmail's Send button/shortcut is dead unless email is authorized ---
    guard.clearSendAuthorization()
    const gmail = 'https://mail.google.com/mail/u/0/#inbox'
    if (!guard.mailSendBlocked(gmail, 'Send')) fail('Gmail Send button clickable while unauthorized')
    if (!guard.mailSendBlocked(gmail, 'ctrl+enter')) fail('Gmail send shortcut allowed')
    if (guard.mailSendBlocked(gmail, 'Save draft')) fail('drafting blocked (it must stay allowed)')
    if (guard.mailSendBlocked('https://example.com', 'Send'))
      fail('non-mail site treated as mail send')
    console.log('[security-smoke] mail Send is blocked at the click/keystroke layer')

    // --- Protected topics are unsearchable, not merely discouraged ---
    const qf = await import('./services/quickfetch')
    const blockedQ = await qf.quickFetch('tax documents from last year')
    if (!/blocked/i.test(blockedQ.error ?? '')) fail(`protected search ran: ${blockedQ.error}`)
    if (blockedQ.lines.length > 0) fail('protected search returned content')
    const okShape = await qf.quickFetch('password reset')
    if (!/blocked/i.test(okShape.error ?? '')) fail('password search not blocked')
    const filtered = guard.filterSensitiveLines([
      'Amazon — your order shipped',
      'IRS — your 1099 is ready',
      'Chase — bank statement available'
    ])
    if (filtered.kept.length !== 1 || filtered.removed !== 2)
      fail(`sensitive result lines not stripped: ${JSON.stringify(filtered)}`)
    console.log('[security-smoke] protected topics are unsearchable and stripped from results')

    // --- capability verbs exist and work (the "I can't do that" complaint) ---
    const made = await actions.executeAction(task.id, {
      action: 'create_workspace',
      title: 'Smoke Made This'
    })
    if (!made.startsWith('created workspace')) fail(`create_workspace failed: ${made}`)
    const madeTask = tasksSvc.listTasks().find((t) => t.title === 'Smoke Made This')
    if (!madeTask) fail('create_workspace reported success but no workspace exists')
    tasksSvc.deleteTask(madeTask!.id)

    // `search` must exist as a verb (the network call itself may fail offline,
    // but "unknown action" would mean the agent genuinely cannot search).
    const searched = await actions.executeAction(task.id, { action: 'search', query: 'x' })
    if (/unknown action/i.test(searched)) fail('search verb missing — agent cannot browse the web')
    console.log('[security-smoke] agent can create workspaces and search the web')

    // --- scheduling: the app acting without being asked ---
    const sched = await import('./services/scheduler')
    // Parsing must accept what a person actually types, and refuse nonsense
    // rather than silently firing at the wrong time.
    for (const [text, ok] of [
      ['08:00', true],
      ['weekdays 7:30', true],
      ['in 30m', true],
      ['hourly', true],
      ['sometime next week', false],
      ['99:99', false]
    ] as const) {
      const parsed = sched.parseWhen(text)
      if (!!parsed !== ok) fail(`parseWhen("${text}") should ${ok ? 'parse' : 'refuse'}`)
    }
    const weekday = sched.parseWhen('weekdays 7:30')
    if (weekday && [0, 6].includes(weekday.at.getDay()))
      fail('a weekday schedule was placed on a weekend')

    // A due schedule must actually fire, and roll forward rather than re-run.
    const added = await actions.executeAction(task.id, {
      action: 'schedule',
      prompt: 'smoke: do nothing',
      target: 'in 1m'
    })
    if (!added.startsWith('scheduled')) fail(`schedule verb failed: ${added}`)
    const mine = sched.listSchedules().filter((x) => x.prompt.startsWith('smoke:'))
    if (mine.length !== 1) fail(`expected 1 scheduled item, got ${mine.length}`)
    // Force it due and tick.
    const future = new Date(Date.now() + 120_000)
    const fired = await sched.tick(future)
    if (fired.length !== 1) fail(`due schedule did not fire (fired ${fired.length})`)
    if (sched.listSchedules().some((x) => x.prompt.startsWith('smoke:')))
      fail('a "once" schedule was not removed after firing')

    // An unattended run must never be able to send. The scheduler starts a
    // turn through the same path as a typed message, and nothing in that path
    // grants send authority.
    guard.clearSendAuthorization()
    if (guard.sendAuthorized('whatsapp') || guard.sendAuthorized('email'))
      fail('a scheduled run left send authority open')
    console.log('[security-smoke] schedules parse, fire, roll forward, and cannot send')

    // --- workflows keep every wall -----------------------------------------
    const wf = await import('./services/workflows')

    // Forbidden verbs and re-targeting are refused at SAVE time…
    const badVerb = wf.saveWorkflow({
      name: 'smoke-bad-verb',
      taskId: task.id,
      steps: [{ kind: 'action', action: { action: 'send_whatsapp', target: 'x', value: 'y' } }]
    })
    if (badVerb.ok) fail('saveWorkflow accepted send_whatsapp')
    const badTarget = wf.saveWorkflow({
      name: 'smoke-bad-target',
      taskId: task.id,
      steps: [{ kind: 'action', action: { action: 'add_todo', value: 'x', workspace: 'Other' } }]
    })
    if (badTarget.ok) fail('saveWorkflow accepted a workspace-targeted step')

    // …and a hand-edited row is STILL refused at run time (belt and braces).
    const { getDb: getDbW } = await import('./db')
    getDbW()
      .prepare(
        'INSERT INTO workflows (id, name, description, task_id, params_json, steps_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'smoke-tampered-id',
        'smoke-tampered',
        '',
        task.id,
        '[]',
        JSON.stringify([{ kind: 'action', action: { action: 'start_focus' } }]),
        'ui',
        new Date().toISOString(),
        new Date().toISOString()
      )
    const tampered = await wf.runWorkflow('smoke-tampered', {})
    if (tampered.started) fail('a hand-tampered workflow row was allowed to run')

    // {{param}} substitution can never smuggle a VERB — only value fields.
    const paramWf = wf.saveWorkflow({
      name: 'smoke-param-verb',
      taskId: task.id,
      params: [{ name: 'p', required: true }],
      steps: [{ kind: 'action', action: { action: '{{p}}', value: '{{p}}' } }]
    })
    if (!paramWf.ok) fail(`param workflow refused: ${(paramWf as { reason: string }).reason}`)
    const paramRun = await wf.runWorkflow('smoke-param-verb', { params: { p: 'send_whatsapp' } })
    if (!paramRun.started) fail('param workflow did not start')
    {
      const deadline = Date.now() + 30_000
      for (;;) {
        const r = wf.getRun(paramRun.runId!)
        if (r && r.status !== 'running') {
          if (r.status !== 'failed') fail(`param-smuggle run ended ${r.status}, expected failed`)
          if (!r.stepResults[0].outcome.includes('unknown action'))
            fail(`the verb field was substituted: ${r.stepResults[0].outcome}`)
          break
        }
        if (Date.now() > deadline) fail('param-smuggle run never finished')
        await new Promise((res) => setTimeout(res, 200))
      }
    }

    // Global workflows: no model steps (unattended universal-agent surface).
    const globalModel = wf.saveWorkflow({
      name: 'smoke-global-model',
      taskId: null,
      steps: [{ kind: 'prompt', prompt: 'do something' }]
    })
    if (globalModel.ok) fail('a GLOBAL workflow accepted a model step')

    // Private workspaces can neither own nor run workflows.
    const privWf = wf.saveWorkflow({
      name: 'smoke-priv-wf',
      taskId: priv.id,
      steps: [{ kind: 'action', action: { action: 'list_todos' } }]
    })
    if (privWf.ok) fail('a private workspace was allowed to own a workflow')

    // Unattended containment: while flagged, the flow-forbidden verbs and
    // re-targeting are refused on the normal action channel.
    actions.beginUnattended(task.id)
    const unatFocus = await actions.executeAction(task.id, { action: 'start_focus' })
    if (!unatFocus.startsWith('refused')) fail(`unattended start_focus not refused: ${unatFocus}`)
    const unatDel = await actions.executeAction(task.id, { action: 'delete_workspace', target: 'x' })
    if (!unatDel.startsWith('refused')) fail(`unattended delete_workspace not refused: ${unatDel}`)
    const unatWs = await actions.executeAction(task.id, {
      action: 'add_todo',
      value: 'x',
      workspace: 'Other'
    })
    if (!unatWs.startsWith('refused')) fail(`unattended re-targeting not refused: ${unatWs}`)
    actions.endUnattended(task.id)

    // NO approval verb exists — a confirm gate can only be cleared by a user
    // click in the renderer (absence, not permission).
    for (const verb of ['approve_workflow', 'confirm_workflow', 'resume_workflow', 'confirm']) {
      const res = await actions.executeAction(task.id, { action: verb })
      if (!/unknown action/.test(res)) fail(`an approval-shaped verb exists: "${verb}" → ${res}`)
    }

    // A schedule can target a workflow; it fires, rolls forward, and leaves
    // no send authority behind.
    const benign = wf.saveWorkflow({
      name: 'smoke-sched-wf',
      taskId: task.id,
      steps: [{ kind: 'action', action: { action: 'list_todos' } }]
    })
    if (!benign.ok) fail('benign workflow refused')
    const benignId = benign.ok ? benign.workflow.id : ''
    const schedAdd = sched.addSchedule({ when: 'in 1m', workflowId: benignId })
    if (!schedAdd.ok) fail(`workflow schedule refused: ${(schedAdd as { ok: false; reason: string }).reason}`)
    const schedId = schedAdd.ok ? schedAdd.schedule.id : ''
    const firedWf = await sched.tick(new Date(Date.now() + 120_000))
    if (!firedWf.includes(schedId)) fail('a due workflow schedule did not fire')
    {
      const deadline = Date.now() + 30_000
      while (wf.activeRunState() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    }
    if (guard.sendAuthorized('whatsapp') || guard.sendAuthorized('email'))
      fail('a scheduled workflow run left send authority open')
    const schedRun = wf.listRuns().find((r) => r.trigger === 'schedule')
    if (!schedRun) fail('the scheduled workflow left no run row')
    console.log(
      '[security-smoke] workflows: forbidden verbs walled at save+run, params cannot smuggle verbs, unattended runs are contained, no approval verb exists, scheduled runs cannot send'
    )

    // --- shared memory crosses workspaces, but never private ones ---
    const memory = await import('./services/memory')
    const factText = `smoke fact ${Date.now().toString(36)} — user takes CS 1331`
    const taught = await actions.executeAction(task.id, { action: 'remember', value: factText })
    if (!taught.startsWith('remembered')) fail(`remember action failed: ${taught}`)

    const other = tasksSvc.createTask({ title: 'Memory Reader' })
    tasksSvc.refreshClaudeMd(other.id)
    const otherMd = (await import('fs')).readFileSync(join(other.folderPath, 'CLAUDE.md'), 'utf-8')
    if (!otherMd.includes(factText)) fail('a fact taught in one workspace did not reach another')

    // A private workspace has no CLAUDE.md at all (invariant 8). If one ever
    // appears, it must still not carry shared memory.
    tasksSvc.refreshClaudeMd(priv.id)
    const privMdPath = join(priv.folderPath, 'CLAUDE.md')
    const fs = await import('fs')
    if (fs.existsSync(privMdPath) && fs.readFileSync(privMdPath, 'utf-8').includes(factText))
      fail('shared memory leaked into a private workspace')

    const privTeach = await actions.executeAction(priv.id, {
      action: 'remember',
      value: 'private workspaces must not teach'
    })
    if (!privTeach.includes('private workspaces do not contribute'))
      fail(`a private workspace wrote to shared memory: ${privTeach}`)

    memory.forgetFact(factText)
    if (memory.listFacts().some((f) => f.text === factText)) fail('forget did not remove the fact')
    tasksSvc.deleteTask(other.id)
    console.log('[security-smoke] shared memory crosses workspaces but never private ones')

    // --- the password vault is unreachable from every agent surface ---
    const vault = await import('./services/vault')
    const saved = vault.saveEntry({
      origin: 'https://smoke-vault.example',
      username: 'smoke-user',
      password: 'SMOKE_SECRET_VALUE',
      title: 'Smoke'
    })
    if ('error' in saved) fail(`vault save failed: ${saved.error}`)

    // The listing (what any UI/IPC surface returns) never carries secrets.
    const listed = JSON.stringify(vault.listEntries())
    if (listed.includes('SMOKE_SECRET_VALUE')) fail('vault listing leaked the password')

    // The file lives OUTSIDE every agent-readable root.
    const { app: electronApp } = await import('electron')
    const vaultFile = join(electronApp.getPath('userData'), 'vault.json')
    const tasksRoot = tasksSvc.tasksRoot()
    if (vaultFile.toLowerCase().startsWith(tasksRoot.toLowerCase()))
      fail('vault file sits inside the AI-readable tasks tree')

    // No action verb reaches it, under any name.
    for (const verb of ['vault', 'get_password', 'read_vault', 'credentials', 'autofill']) {
      const res = await actions.executeAction(task.id, { action: verb, target: 'smoke-vault.example' })
      if (!/unknown action/i.test(res)) fail(`"${verb}" was not rejected as unknown: ${res}`)
      if (res.includes('SMOKE_SECRET_VALUE')) fail(`"${verb}" returned a stored password`)
    }

    // Stored secrets are not searchable either (protected-topic wall).
    const pwSearch = await qf.quickFetch('smoke-vault password')
    if (!/blocked/i.test(pwSearch.error ?? '')) fail('a password search was not blocked')

    if (vault.revealPassword((saved as { id: string }).id) !== 'SMOKE_SECRET_VALUE')
      fail('vault round-trip failed — the user could not get their own password back')
    vault.deleteEntry((saved as { id: string }).id)

    // The "save this password?" offer: the credential stops in MAIN. What the
    // renderer is handed must carry the site and username and NOTHING else —
    // a secret that never enters the renderer cannot be read out of it.
    if (!vault.offerToSave('https://smoke.example.com/login', 'someone', 'OFFERED_SECRET'))
      fail('a new login was not offered for saving')
    const info = vault.pendingSaveInfo()
    if (!info) fail('pending save info missing')
    if (JSON.stringify(info).includes('OFFERED_SECRET'))
      fail('the save prompt would hand the password to the renderer')
    if (Object.keys(info!).sort().join(',') !== 'origin,username')
      fail(`save prompt payload carries more than site+username: ${Object.keys(info!).join(',')}`)
    const committed = vault.commitPendingSave() as { id: string }
    if (vault.revealPassword(committed.id) !== 'OFFERED_SECRET')
      fail('committing the offer did not store the password')
    if (vault.pendingSaveInfo() !== null) fail('the offer was not cleared after committing')
    // Declining must not leave the secret sitting in memory.
    vault.offerToSave('https://smoke.example.com/login', 'someone', 'DECLINED_SECRET')
    vault.discardPendingSave()
    if (vault.pendingSaveInfo() !== null) fail('a declined offer was kept')
    vault.deleteEntry(committed.id)
    console.log('[security-smoke] the save-password prompt never carries the password')

    console.log('[security-smoke] password vault is unreachable from every agent surface')

    guard.clearSendAuthorization()
    tasksSvc.deleteTask(task.id)
    tasksSvc.deleteTask(priv.id)
    console.log('[security-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[security-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Headless terminal-containment check: ASIT_SMOKE_TERMINAL=1 electron out/main/index.js
// Terminals are the most dangerous surface in the app, so the boundaries get
// their own smoke: a real pty is spawned, then every path an agent could take
// to reach or drive it is asserted to fail.
async function runTerminalSmokeTest(): Promise<void> {
  const term = await import('./services/terminal')
  const actions = await import('./services/actions')
  const tasksSvc = await import('./services/tasks')

  const fail = (msg: string): never => {
    console.error('[terminal-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }
  const waitFor = async (test: () => boolean, ms = 15000): Promise<boolean> => {
    const started = Date.now()
    while (Date.now() - started < ms) {
      if (test()) return true
      await new Promise((r) => setTimeout(r, 120))
    }
    return false
  }

  try {
    const task = tasksSvc.createTask({ title: 'Term Test' })
    const other = tasksSvc.createTask({ title: 'Term Other' })

    // A real pty must actually work — otherwise the rest proves nothing.
    // No shell name: resolveShell picks what this platform actually has.
    // Asking for 'cmd' passed on Windows and failed the whole macOS suite.
    const opened = term.openTerminal(task.id, undefined, () => null)
    if (!('id' in opened) || !opened.id) fail(`terminal did not open: ${JSON.stringify(opened)}`)
    const termId = (opened as { id: string }).id
    term.writeFromUser(termId, 'echo SMOKE_MARKER_OK\r\n')
    if (!(await waitFor(() => term.replayBuffer(termId).includes('SMOKE_MARKER_OK'))))
      fail('pty produced no output')
    console.log('[terminal-smoke] real pty spawns and echoes')

    // Reading is OFF by default — the flag must be opt-in, not opt-out.
    const denied = await actions.executeAction(task.id, { action: 'read_terminal' })
    if (!denied.startsWith('BLOCKED:')) fail(`terminal readable while opt-in is off: ${denied}`)
    console.log('[terminal-smoke] agent read denied until the workspace opts in')

    // With the flag on, the agent sees output — and ONLY then.
    tasksSvc.setTaskTerminalAiRead(task.id, true)
    const allowed = await actions.executeAction(task.id, { action: 'read_terminal' })
    if (!allowed.includes('SMOKE_MARKER_OK')) fail(`opted-in read returned nothing: ${allowed}`)
    if (/\[/.test(allowed)) fail('ANSI escapes leaked into the agent-facing read')
    console.log('[terminal-smoke] opted-in read works and is ANSI-stripped')

    // Protected topics are stripped from terminal output too (invariant 14) —
    // shells print tokens and env dumps.
    term.writeFromUser(termId, 'echo my password is hunter2\r\n')
    if (!(await waitFor(() => term.replayBuffer(termId).includes('hunter2'))))
      fail('secret line never reached the buffer')
    const filtered = await actions.executeAction(task.id, { action: 'read_terminal' })
    if (filtered.includes('hunter2')) {
      const where = filtered
        .split('\n')
        .filter((l) => l.includes('hunter2'))
        .map((l) => JSON.stringify(l.trim()))
        .join(' | ')
      fail(`protected line leaked to the agent: ${where}`)
    }
    console.log('[terminal-smoke] protected topics stripped from terminal reads')

    // Another workspace must not see this terminal, even opted in.
    tasksSvc.setTaskTerminalAiRead(other.id, true)
    const cross = await actions.executeAction(other.id, { action: 'read_terminal' })
    if (cross.includes('SMOKE_MARKER_OK')) fail('terminal readable from another workspace')
    const crossRef = await actions.executeAction(other.id, { action: 'read_terminal', ref: termId })
    if (crossRef.includes('SMOKE_MARKER_OK')) fail('terminal readable cross-owner by id')
    console.log('[terminal-smoke] terminals are owner-scoped')

    // Jarvis cannot re-target a terminal read at another workspace.
    const jarvis = tasksSvc.getOrCreateJarvis()
    const retarget = await actions.executeAction(jarvis.id, {
      action: 'read_terminal',
      workspace: 'Term Test'
    })
    if (retarget.includes('SMOKE_MARKER_OK')) fail('Jarvis re-targeted a terminal read')
    if (!retarget.includes('cannot be re-targeted')) fail(`unexpected retarget result: ${retarget}`)
    console.log('[terminal-smoke] terminal reads cannot be re-targeted across workspaces')

    // A replayed skill flow (no model, no live user) may not read terminals.
    const flow = await actions.runFlow(task.id, [{ action: 'read_terminal' }] as never)
    if (!flow[0]?.includes('not allowed inside a replayed skill flow'))
      fail(`flow terminal read not refused: ${flow[0]}`)
    console.log('[terminal-smoke] replayed flows cannot read terminals')

    // Private workspaces are never readable, and can't even be opted in.
    const priv = tasksSvc.createTask({ title: 'Term Private', aiDisabled: true })
    tasksSvc.setTaskTerminalAiRead(priv.id, true)
    if (tasksSvc.getTask(priv.id)?.terminalAiRead) fail('private workspace accepted the opt-in')
    console.log('[terminal-smoke] private workspaces cannot enable terminal reads')

    // The protocol has NO write verb — an agent asking for one gets nothing.
    for (const verb of ['write_terminal', 'run_command', 'terminal_write', 'exec']) {
      const res = await actions.executeAction(task.id, { action: verb, value: 'echo PWNED\r\n' })
      if (!/unknown action/i.test(res)) fail(`"${verb}" was not rejected as unknown: ${res}`)
    }
    if (term.replayBuffer(termId).includes('PWNED')) fail('an action reached the pty')
    console.log('[terminal-smoke] no agent write verb exists in the protocol')

    term.shutdownTerminals()
    tasksSvc.deleteTask(task.id)
    tasksSvc.deleteTask(other.id)
    tasksSvc.deleteTask(priv.id)
    console.log('[terminal-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[terminal-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Headless voice check: ASIT_SMOKE_VOICE=1 electron out/main/index.js
// Closed loop with no microphone: Windows TTS renders a known phrase to a
// 16kHz WAV, and the local sherpa/Moonshine pipeline must transcribe it back.
// Downloads the models on first run (~130MB, cached in userData).
async function runVoiceSmokeTest(): Promise<void> {
  const voiceSvc = await import('./services/voice')
  const { execFile } = await import('child_process')
  const { readFileSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')

  const fail = (msg: string): never => {
    console.error('[voice-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }

  try {
    if (!voiceSvc.voiceModelsReady()) {
      console.log('[voice-smoke] downloading speech models (one-time)…')
      await voiceSvc.downloadVoiceModels((pct, file) =>
        console.log(`[voice-smoke]   ${pct}% ${file}`)
      )
    }
    console.log('[voice-smoke] models present')

    const wav = join(tmpdir(), 'asit-voice-smoke.wav')
    const phrase = 'open the biology notes and start a timer'
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sp.SetOutputToWaveFile('${wav.replace(/\\/g, '\\\\')}', $fmt)
$sp.Speak('${phrase}')
$sp.Dispose()`
        ],
        { timeout: 30000 },
        (err) => (err ? reject(err) : resolve())
      )
    })
    console.log('[voice-smoke] test WAV synthesized via Windows TTS')

    // WAV → Float32: 44-byte canonical header, 16-bit little-endian PCM.
    const buf = readFileSync(wav)
    const pcm = new Float32Array((buf.length - 44) / 2)
    for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(44 + i * 2) / 32768
    if (pcm.length < 16000) fail('synthesized wav suspiciously short')

    const t0 = Date.now()
    const text = await voiceSvc.transcribeSamples(pcm)
    const ms = Date.now() - t0
    console.log(`[voice-smoke] transcribed in ${ms}ms: "${text}"`)
    const lower = text.toLowerCase()
    for (const word of ['biology', 'notes', 'timer']) {
      if (!lower.includes(word)) fail(`transcript missing "${word}"`)
    }
    if (ms > 8000) fail(`decode too slow: ${ms}ms`)

    // The FULL mic ingest path — chunking, VAD windows, front(false), pop —
    // under the same Electron memory-cage rules a real session runs under.
    // Pad with silence so the VAD sees an utterance boundary.
    const padded = new Float32Array(pcm.length + 32000)
    padded.set(pcm, 16000)
    const vadText = (await voiceSvc.transcribeViaVadPath(padded)).toLowerCase()
    console.log(`[voice-smoke] VAD-path transcript: "${vadText}"`)
    for (const word of ['biology', 'timer']) {
      if (!vadText.includes(word)) fail(`VAD-path transcript missing "${word}"`)
    }

    // Dictation formatting: raw transcripts are bare lowercase words with no
    // punctuation, so this is what stands between "hello world this is a
    // test" and something you would have typed.
    const fmt = voiceSvc.formatDictation
    const fmtCases: [string, boolean, string][] = [
      ['hello world this is a test', true, 'Hello world this is a test'],
      ['the answer is four period new line next thought', true, 'The answer is four.\nNext thought'],
      ['first idea new paragraph second idea', true, 'First idea\n\nSecond idea'],
      ['is this working question mark', true, 'Is this working?'],
      ['tell her comma i said hi', true, 'Tell her, I said hi'],
      ['i think i can', true, 'I think I can'],
      ['   ', true, '']
    ]
    for (const [raw, atStart, want] of fmtCases) {
      const got = fmt(raw, atStart)
      if (got !== want) fail(`formatDictation("${raw}") gave ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    }
    // A phrase that continues a sentence must NOT be re-capitalised.
    if (fmt('and then we left', false) !== 'and then we left')
      fail('a continuing phrase was capitalised as if it started a sentence')
    console.log(`[voice-smoke] dictation formatting: ${fmtCases.length + 1} cases`)

    // End to end: the same audio a mic would produce, through the dictation
    // path, coming out as text a field could receive.
    const dictated = fmt(await voiceSvc.transcribeViaVadPath(padded), true)
    if (!/^[A-Z]/.test(dictated)) fail(`dictated text not sentence-cased: "${dictated}"`)
    if (!dictated.toLowerCase().includes('biology'))
      fail(`dictation lost the content: "${dictated}"`)
    console.log(`[voice-smoke] dictation end-to-end: "${dictated}"`)

    // Kokoro TTS (natural voice): download once, then generate a clip.
    if (process.env.ASIT_SMOKE_VOICE_TTS === '1') {
      if (!voiceSvc.ttsReady()) {
        console.log('[voice-smoke] downloading natural voice (~370MB)…')
        let lastPct = -1
        await voiceSvc.downloadTts((pct, file) => {
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct
            console.log(`[voice-smoke]   ${pct}% ${file}`)
          }
        })
      }
      if (!voiceSvc.ttsReady()) fail('TTS models not ready after download')
      const t1 = Date.now()
      const audio = await voiceSvc.synthesizeForSmoke('Your flight departs at nine forty AM.')
      console.log(
        `[voice-smoke] TTS generated ${audio.samples.length} samples @ ${audio.sampleRate}Hz in ${Date.now() - t1}ms`
      )
      if (audio.samples.length < audio.sampleRate) fail('TTS produced too little audio')
      console.log('[voice-smoke] natural voice generates speech')
    } else {
      console.log('[voice-smoke] (skipped natural-voice test — set ASIT_SMOKE_VOICE_TTS=1)')
    }

    console.log('[voice-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[voice-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Headless universal-agent check: ASIT_SMOKE_JARVIS=1 electron out/main/index.js
// Proves: (1) workspace-targeted actions from Jarvis's file execute in the
// NAMED workspace; (2) every other agent is refused workspace targeting;
// (3) private workspaces are unreachable by name; (4) a real CLI turn reads
// across workspaces from the tasks root (needs a logged-in claude CLI).
async function runJarvisSmokeTest(): Promise<void> {
  const tasksSvc = await import('./services/tasks')
  const actionsSvc = await import('./services/actions')
  const resourcesSvc = await import('./services/resources')
  const jarvisSvc = await import('./services/jarvis')
  const { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } = await import('fs')
  const { join } = await import('path')

  const fail = (msg: string): never => {
    console.error('[jarvis-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }

  try {
    const jarvis = tasksSvc.getOrCreateJarvis()
    const target = tasksSvc.createTask({ title: 'Bio Notes' })
    const secret = tasksSvc.createTask({ title: 'Secret Diary', aiDisabled: true })

    // (1) Deterministic protocol path: a workspace-targeted action appended to
    // Jarvis's file must land in the NAMED workspace.
    actionsSvc.watchJarvisActions(jarvis.id)
    const jFile = join(jarvis.folderPath, '.asit', 'actions.ndjson')
    mkdirSync(join(jarvis.folderPath, '.asit'), { recursive: true })
    if (!existsSync(jFile)) writeFileSync(jFile, '')
    appendFileSync(
      jFile,
      JSON.stringify({
        action: 'add_url',
        workspace: 'bio notes',
        title: 'Cell cycle',
        url: 'https://example.com/cells'
      }) + '\n'
    )
    let landed = false
    for (let i = 0; i < 20 && !landed; i++) {
      await new Promise((r) => setTimeout(r, 300))
      landed = resourcesSvc.listResources(target.id).some((r) => r.url?.includes('example.com/cells'))
    }
    if (!landed) fail('workspace-targeted action did not execute in the named workspace')
    const resultFile = join(jarvis.folderPath, '.asit', 'actions-result.md')
    if (!existsSync(resultFile) || !readFileSync(resultFile, 'utf-8').includes('add_url'))
      fail('action result was not reported back to Jarvis')
    console.log('[jarvis-smoke] workspace-targeted action executed + result reported')

    // (2) Only Jarvis may retarget.
    const denied = await actionsSvc.executeAction(target.id, {
      action: 'add_url',
      workspace: 'bio notes',
      title: 'x',
      url: 'https://example.com/x'
    })
    if (!denied.includes('only available to the universal agent'))
      fail(`workspace targeting not refused for a normal task: "${denied}"`)

    // (3) Private workspaces resolve to nothing.
    const privDenied = await actionsSvc.executeAction(jarvis.id, {
      action: 'add_url',
      workspace: 'secret diary',
      title: 'x',
      url: 'https://example.com/x'
    })
    if (!privDenied.includes('no workspace matching'))
      fail(`private workspace was reachable by name: "${privDenied}"`)
    if (resourcesSvc.listResources(secret.id).length !== 0) fail('private workspace mutated')
    console.log('[jarvis-smoke] retargeting: others refused, private unreachable')

    // (4) Real CLI turn: read across a workspace from the tasks root.
    resourcesSvc.writeNote(
      join(target.folderPath, 'notes.md'),
      '# Notes\n\nThe secret codeword for this workspace is MITOCHONDRIA.\n'
    )
    tasksSvc.refreshClaudeMd(target.id)
    const reply = await jarvisSvc.askJarvisText(
      'Find the secret codeword in the Bio Notes workspace notes and reply with ONLY that codeword.'
    )
    if (!reply.toUpperCase().includes('MITOCHONDRIA'))
      fail(`CLI turn missed the codeword; reply: "${reply.slice(0, 200)}"`)
    console.log('[jarvis-smoke] CLI turn read across workspaces from the root')

    // (5) THE end-to-end path: the CLI must be able to WRITE the action queue
    // (this exact step once failed in the field — Write refused on the nested
    // dot-directory) and the app must execute what it dispatched.
    const reply2 = await jarvisSvc.askJarvisText(
      'Using the action protocol from your briefing, dispatch exactly one action: add the URL https://example.com/dispatch-proof titled "Dispatch Proof" to the "Bio Notes" workspace. Then read your actions-result file and reply with one line: the result it reports.'
    )
    let dispatched = false
    for (let i = 0; i < 20 && !dispatched; i++) {
      await new Promise((r) => setTimeout(r, 300))
      dispatched = resourcesSvc
        .listResources(target.id)
        .some((r) => r.url?.includes('dispatch-proof'))
    }
    if (!dispatched)
      fail(`CLI dispatch never executed; jarvis said: "${reply2.slice(0, 300)}"`)
    console.log('[jarvis-smoke] CLI dispatched an action end-to-end (write → execute → verify)')

    console.log('[jarvis-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[jarvis-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Headless companion-server check: ASIT_SMOKE_COMPANION=1 electron out/main/index.js
// Proves: token auth gates every API (401 without/with-wrong token), to-dos
// round-trip, phone capture lands in scratchpad notes AND its "to-do:" line is
// auto-captured, push subscriptions validate + store, static shell serves.
async function runCompanionSmokeTest(): Promise<void> {
  const settingsSvc = await import('./services/settings')
  const companionSvc = await import('./services/companion')
  const todosSvc = await import('./services/todos')
  const tasksSvc = await import('./services/tasks')
  const { readFileSync } = await import('fs')
  const { join } = await import('path')

  const fail = (msg: string): never => {
    console.error('[companion-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }

  try {
    settingsSvc.setSettings({ companionPort: 0 }) // ephemeral port
    companionSvc.startCompanion(() => null)
    let port: number | null = null
    for (let i = 0; i < 20 && port === null; i++) {
      await new Promise((r) => setTimeout(r, 250))
      port = companionSvc.companionAddress()
    }
    if (!port) fail('server never bound')
    const base = `http://127.0.0.1:${port}`
    const token = settingsSvc.getSettings().companionToken
    if (!token) fail('no pairing token generated')
    const api = (path: string, opts: RequestInit = {}, auth = true): Promise<Response> =>
      fetch(`${base}/api/${path}`, {
        ...opts,
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
          ...((opts.headers as Record<string, string>) ?? {})
        }
      })

    // Auth gate
    if ((await api('state', {}, false)).status !== 401) fail('unauthenticated request accepted')
    const bad = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer nope' } })
    if (bad.status !== 401) fail('wrong token accepted')
    console.log('[companion-smoke] token auth gates the API')

    // To-dos round trip
    const added = (await (
      await api('todos', { method: 'POST', body: JSON.stringify({ text: 'phone smoke todo' }) })
    ).json()) as { todo: { id: string } }
    const state = (await (await api('state')).json()) as { todos: { id: string; text: string }[] }
    if (!state.todos.some((t) => t.text === 'phone smoke todo')) fail('added todo not listed')
    await api(`todos/${added.todo.id}/done`, { method: 'POST', body: JSON.stringify({ done: true }) })
    if (todosSvc.listTodos(false).some((t) => t.id === added.todo.id)) fail('todo not completed')
    console.log('[companion-smoke] to-dos add/list/complete round trip')

    // Capture → scratchpad notes + automatic to-do capture
    await api('capture', {
      method: 'POST',
      body: JSON.stringify({ text: 'note from phone\nto-do: captured from phone' })
    })
    const scratch = tasksSvc.getOrCreateScratch()
    const notes = readFileSync(join(scratch.folderPath, 'notes.md'), 'utf-8')
    if (!notes.includes('note from phone')) fail('capture not written to scratchpad notes')
    if (!todosSvc.listTodos(false).some((t) => t.text === 'captured from phone'))
      fail('captured to-do: line not synced to the global list')
    console.log('[companion-smoke] capture lands in scratchpad + to-do auto-capture fires')

    // Push subscription validation + storage
    const badSub = await api('push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: 'http://insecure', keys: {} })
    })
    if (badSub.status !== 400) fail('invalid push subscription accepted')
    await api('push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: 'https://push.example.invalid/sub1',
        keys: { p256dh: 'k', auth: 'a' }
      })
    })
    if (settingsSvc.getSettings().companionSubs.length !== 1) fail('subscription not stored')
    console.log('[companion-smoke] push subscriptions validated + stored')

    // Offline sync: queued ops replay in order, junk ops are skipped
    const syncOps = [
      { t: 'todoadd', text: 'offline-queued todo', opId: 'smoke-op-1' },
      { t: 'capture', text: 'offline capture\nto-do: from the bus', opId: 'smoke-op-2' },
      { t: 'bogus', x: 1 }
    ]
    const sync = (await (
      await api('sync', { method: 'POST', body: JSON.stringify({ ops: syncOps }) })
    ).json()) as { applied: number }
    if (sync.applied !== 2) fail(`sync applied ${sync.applied}, expected 2`)
    // Replay of the same batch (lost-response retry) must be a no-op.
    const replay = (await (
      await api('sync', { method: 'POST', body: JSON.stringify({ ops: syncOps }) })
    ).json()) as { applied: number }
    if (replay.applied !== 0) fail(`sync replay applied ${replay.applied}, expected 0 (idempotency)`)
    if (!todosSvc.listTodos(false).some((t) => t.text === 'offline-queued todo'))
      fail('synced todo missing')
    if (!todosSvc.listTodos(false).some((t) => t.text === 'from the bus'))
      fail('synced capture did not to-do-capture')
    console.log('[companion-smoke] offline sync replays queued ops')

    // Pairing-code flow (how a fresh home-screen install authenticates)
    const started = (await (await fetch(`${base}/api/pair/start`, { method: 'POST' })).json()) as {
      requestId: string
      code: string
    }
    if (!/^\d{6}$/.test(started.code)) fail('pair code malformed')
    const pending = (await (
      await fetch(`${base}/api/pair/poll?rid=${started.requestId}`)
    ).json()) as { pending?: boolean; token?: string }
    if (!pending.pending || pending.token) fail('pair delivered token before approval')
    companionSvc.approvePair(started.requestId)
    const approved = (await (
      await fetch(`${base}/api/pair/poll?rid=${started.requestId}`)
    ).json()) as { token?: string }
    if (approved.token !== token) fail('approved pair did not deliver the token')
    if ((await fetch(`${base}/api/pair/poll?rid=${started.requestId}`)).status !== 404)
      fail('pair poll not one-shot')
    if ((await fetch(`${base}/api/pair/poll?rid=guess`)).status !== 404)
      fail('pair poll accepted a bogus requestId')
    console.log('[companion-smoke] pair-code flow: pending → approve → one-shot token delivery')

    // Static shell
    const shell = await fetch(base + '/')
    if (!(await shell.text()).includes('ASIT')) fail('PWA shell not served')
    const blocked = await fetch(base + '/..%2f..%2fpackage.json')
    if (blocked.status !== 404) fail('static handler served a non-whitelisted path')
    console.log('[companion-smoke] shell serves; non-whitelisted paths refused')

    // OFFLINE SHELL: every file the service worker precaches must be served,
    // with a JS content-type on sw.js — browsers refuse to register a worker
    // served as anything else, and a single missing file here is the
    // difference between "the phone app opens with the PC off" and a browser
    // error page.
    for (const [file, expectType] of [
      ['/index.html', 'text/html'],
      ['/sw.js', 'javascript'],
      ['/manifest.webmanifest', 'manifest'],
      ['/icon-180.png', 'image/png'],
      ['/icon-512.png', 'image/png']
    ] as const) {
      const r = await fetch(base + file)
      if (r.status !== 200) fail(`offline shell file ${file} not served (${r.status})`)
      const ctype = r.headers.get('content-type') ?? ''
      if (!ctype.includes(expectType))
        fail(`${file} served as "${ctype}" — expected ${expectType}`)
    }
    // The worker must actually register a fetch handler, or nothing is cached.
    const swSrc = await (await fetch(base + '/sw.js')).text()
    if (!/addEventListener\(\s*['"]fetch['"]/.test(swSrc)) fail('sw.js has no fetch handler')
    if (!/addEventListener\(\s*['"]install['"]/.test(swSrc)) fail('sw.js has no install handler')
    // And the app must register it BEFORE the pairing gate's early return,
    // otherwise a fresh home-screen install caches nothing.
    const shellSrc = await (await fetch(base + '/')).text()
    const regAt = shellSrc.indexOf("register('/sw.js')")
    const gateAt = shellSrc.indexOf('if (!token())')
    if (regAt < 0) fail('shell never registers the service worker')
    if (gateAt >= 0 && regAt > gateAt)
      fail('service worker is registered after the pairing gate — a fresh install would cache nothing')
    console.log('[companion-smoke] offline shell complete + registered before the pairing gate')

    companionSvc.stopCompanion()
    console.log('[companion-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[companion-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Real-UI check: ASIT_SMOKE_UI=1 electron out/main/index.js
//
// Every other smoke tests main. Nothing tested the thing the user actually
// touches, which is why a run of "I can't click that" bugs shipped: the app
// booted, the code typechecked, and the control was dead. This boots the REAL
// renderer against a real (throwaway) workspace and asks the page the only
// question that matters — is the control reachable and does it take focus.
async function runUiSmokeTest(): Promise<void> {
  const tasks = await import('./services/tasks')

  const fail = (msg: string): never => {
    console.error('[ui-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }

  try {
    // Skip first-run onboarding: its modal covers the whole window, and a
    // test that trips over it tells you nothing about the control underneath.
    const settingsSvc = await import('./services/settings')
    settingsSvc.setSettings({ onboarded: true })

    const task = tasks.createTask({ title: 'UI Smoke Workspace' })
    const { addUrlResource } = await import('./services/resources')
    addUrlResource(task.id, 'Example', 'https://example.com')

    // The real UI needs the real backend behind it, or every control fails
    // for a reason that has nothing to do with the control.
    registerIpc(() => mainWindow)
    timer.init(() => mainWindow)
    initQuestions(() => mainWindow)
    initActions(() => mainWindow)
    initUsage(() => mainWindow)
    initActivity(() => mainWindow)
    initTodos(() => mainWindow)

    createWindow()
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) fail('no window')
    win.setBounds({ x: -3000, y: -3000, width: 1400, height: 900 })
    win.showInactive()
    await new Promise<void>((r) => {
      if (!win.webContents.isLoading()) return r()
      win.webContents.once('did-finish-load', () => r())
    })
    const ui = win.webContents

    const evalIn = async <T>(js: string): Promise<T> => (await ui.executeJavaScript(js)) as T
    const waitFor = async (js: string, what: string, ms = 8000): Promise<void> => {
      const deadline = Date.now() + ms
      for (;;) {
        if (await evalIn<boolean>(`!!(${js})`)) return
        if (Date.now() > deadline) fail(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 250))
      }
    }

    // Open the workspace the way a click would.
    await waitFor(`document.querySelector('.task-card, .task-row, [data-focus-zone]')`, 'home to render')

    // Home's browser must render the SHARED tab strip (the scratch browser
    // and the workspace grid used to carry two divergent copies of this
    // chrome), and its find bar must open — Ctrl+F was once dead on Home.
    await waitFor(`document.querySelector('.browser .tab-strip .tab')`, 'the shared tab strip on Home')
    await evalIn(`window.__asitStore.getState().tabSurface.find()`)
    await waitFor(`document.querySelector('.browser .find-bar')`, 'the find bar on Home')
    await evalIn(`(() => {
      const el = document.querySelector('.browser .find-bar input')
      el && el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })()`)
    console.log('[ui-smoke] Home renders the shared tab strip and its find bar opens')

    // Scratch tabs persist in the scratch task's layout_json — the same shape
    // a workspace stores, which is what lets "save session" hand tabs over.
    const tabCountBefore = await evalIn<number>(
      `document.querySelectorAll('.browser .tab-strip .tab').length`
    )
    await evalIn(`window.__asitStore.getState().tabSurface.newTab()`)
    await waitFor(
      `document.querySelectorAll('.browser .tab-strip .tab').length === ${tabCountBefore + 1}`,
      'the new Home tab'
    )
    {
      // waitFor wraps in !!(...) which is truthy for a bare Promise, so poll
      // the async check directly (executeJavaScript awaits returned promises).
      const deadline = Date.now() + 8000
      for (;;) {
        const ok = await evalIn<boolean>(`(async () => {
          const s = await window.asit.tasks.scratchGet()
          const layout = JSON.parse(s.task.layoutJson || 'null')
          return !!layout && Object.keys(layout.webTabs || {}).length >= ${tabCountBefore + 1}
        })()`)
        if (ok) break
        if (Date.now() > deadline) fail('the scratch layout_json never held the new tab')
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    console.log('[ui-smoke] a new Home tab lands in the scratch layout_json')

    // The new tab IS the new-tab page: plain DOM, and — the invariant-2 part —
    // no pane may be visible while it shows (an NTP tab has no pane at all,
    // and its siblings must be hidden or they'd paint over it).
    await waitFor(`document.querySelector('.ntp')`, 'the new-tab page')
    if (paneManager.boundsForSmoke().length !== 0)
      fail('a pane is still visible while the new-tab page is showing')
    console.log('[ui-smoke] the NTP renders with every pane hidden and none opened for it')

    // Typing in the NTP's box converts the tab in place into a real page.
    await evalIn(`(() => {
      const el = document.querySelector('.ntp .browser-address')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, 'https://example.com')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()`)
    await waitFor(`!document.querySelector('.ntp')`, 'the NTP to convert into a page')
    console.log('[ui-smoke] NTP conversion: typing an address turns the tab into a page')

    // Ctrl+D's path: bookmark the (converted) active page, end to end.
    await evalIn(`window.__asitStore.getState().tabSurface.bookmarkPage()`)
    {
      const deadline = Date.now() + 8000
      for (;;) {
        const ok = await evalIn<boolean>(`(async () => {
          const list = await window.asit.bookmarks.list()
          return list.some((b) => b.url.startsWith('https://example.com'))
        })()`)
        if (ok) break
        if (Date.now() > deadline) fail('bookmarkPage never stored the page')
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    await waitFor(`document.querySelector('.bookmark-star-on')`, 'the filled bookmark star')
    console.log('[ui-smoke] bookmark round-trip: Ctrl+D stores the page and fills the star')

    await evalIn(`window.__asitStore.getState().openTask(${JSON.stringify(task.id)})`)
    await waitFor(`document.querySelector('.pane-grid')`, 'the workspace')

    // Open the pinned URL so a page pane exists, then wait for its toolbar.
    await evalIn(
      `(() => { const r = window.__asitStore.getState().activeResources[0]
                window.__asitGrid && window.__asitGrid.openResource(r.id) })()`
    )
    await waitFor(`document.querySelector('.pane-toolbar .browser-address')`, 'the address bar')

    // THE question: is the address bar reachable where it is drawn, and does
    // clicking it actually put the caret in it?
    const probe = await evalIn<{
      hit: string
      covered: string | null
      focused: boolean
      readOnly: boolean
      pointerEvents: string
    }>(`(() => {
      const el = document.querySelector('.pane-toolbar .browser-address')
      const r = el.getBoundingClientRect()
      const x = r.x + r.width / 2, y = r.y + r.height / 2
      const top = document.elementFromPoint(x, y)
      el.focus()
      return {
        hit: top ? (top === el ? 'the address bar' : (top.className || top.tagName)) : 'nothing',
        covered: top === el ? null : (top ? (top.className || top.tagName) : 'nothing'),
        focused: document.activeElement === el,
        readOnly: !!el.readOnly || !!el.disabled,
        pointerEvents: getComputedStyle(el).pointerEvents
      }
    })()`)

    if (probe.pointerEvents === 'none') fail('the address bar has pointer-events: none')
    if (probe.readOnly) fail('the address bar is read-only')
    if (probe.covered) fail(`the address bar is covered by "${probe.covered}" — clicks never reach it`)
    if (!probe.focused) fail('the address bar refused focus')
    console.log('[ui-smoke] the address bar is reachable, focusable and editable')

    // Typing into it must actually change it (a controlled input wired to the
    // wrong state looks fine and silently discards every keystroke).
    ui.focus()
    await evalIn(`document.querySelector('.pane-toolbar .browser-address').focus()`)
    for (const ch of 'abc') ui.sendInputEvent({ type: 'char', keyCode: ch })
    await new Promise((r) => setTimeout(r, 250))
    const typed = await evalIn<string>(
      `document.querySelector('.pane-toolbar .browser-address').value`
    )
    if (!typed.includes('abc')) fail(`typing did nothing — the field still reads "${typed}"`)
    console.log('[ui-smoke] typing into the address bar works')

    // Selection + copy: "I can't even copy it" is its own bug.
    const selected = await evalIn<string>(`(() => {
      const el = document.querySelector('.pane-toolbar .browser-address')
      el.focus(); el.select()
      return el.value.slice(el.selectionStart, el.selectionEnd)
    })()`)
    if (!selected) fail('the address bar cannot be selected')
    console.log('[ui-smoke] the address can be selected for copying')

    // THE check renderer hit-testing cannot make. document.elementFromPoint
    // knows nothing about WebContentsViews — they are a separate compositing
    // layer — so a pane sitting over a control looks perfectly reachable to
    // the page while every real click lands on the website instead. That is
    // invariant 2's failure mode, and it is invisible from inside the DOM.
    // Generous settle: layout, ResizeObserver and the bounds round-trip to
    // main are all async, and a transient overlap is a different bug from a
    // permanent one.
    await new Promise((r) => setTimeout(r, 2000))
    const toolbar = await evalIn<{ x: number; y: number; w: number; h: number } | null>(
      `(() => { const el = document.querySelector('.pane-toolbar')
                if (!el) return null
                const r = el.getBoundingClientRect()
                return { x: r.x, y: r.y, w: r.width, h: r.height } })()`
    )
    if (!toolbar) fail('no toolbar')
    // The find bar is the other thing that appears ABOVE the pane and pushes
    // it down — the same shape of bug, so open it before measuring.
    await evalIn(`window.__asitStore.getState().tabSurface.find()`)
    await waitFor(`document.querySelector('.find-bar')`, 'the find bar')
    await new Promise((r) => setTimeout(r, 400))

    // Do it for EVERY piece of app chrome, not just the address bar. This is
    // the general shape of the bug: any control that shares screen space with
    // a pane can end up underneath it, and nothing on screen looks wrong.
    const chrome = await evalIn<{ what: string; x: number; y: number; w: number; h: number }[]>(
      `Array.from(document.querySelectorAll(
         '.pane-toolbar, .tab-strip, .find-bar, .resource-rail, .workspace-header, .browser-toolbar, .browser-tabs'
       )).map(el => {
         const r = el.getBoundingClientRect()
         return { what: el.className, x: r.x, y: r.y, w: r.width, h: r.height }
       }).filter(r => r.w > 0 && r.h > 0)`
    )
    if (chrome.length === 0) fail('found no app chrome to check')
    const zoom = ui.getZoomFactor() || 1
    for (const c of chrome) {
      const box = { x: c.x * zoom, y: c.y * zoom, w: c.w * zoom, h: c.h * zoom }
      for (const [paneId, b] of paneManager.boundsForSmoke()) {
        const ox = Math.min(box.x + box.w, b.x + b.width) - Math.max(box.x, b.x)
        const oy = Math.min(box.y + box.h, b.y + b.height) - Math.max(box.y, b.y)
        if (ox > 1 && oy > 1) {
          fail(
            `pane "${paneId}" covers ${Math.round(ox)}x${Math.round(oy)}px of "${c.what}" ` +
              `— clicks there hit the page instead (control ${JSON.stringify(box)}, pane ${JSON.stringify(b)})`
          )
        }
      }
    }
    console.log(`[ui-smoke] no pane overlaps any of the ${chrome.length} app controls on screen`)

    // Call the bridge the way the screens do. A registered handler can still
    // throw on real data, and the renderer only ever sees "Error invoking
    // remote method 'x'" with the cause buried — so exercise the read-only
    // ones for real and report which failed and why.
    const bridge = await evalIn<{ name: string; error: string }[]>(`(async () => {
      const calls = {
        'usage.summary': () => window.asit.usage.summary(),
        'usage.activity': () => window.asit.usage.activity(),
        'tasks.list': () => window.asit.tasks.list(),
        'tasks.stats': () => window.asit.tasks.stats(),
        'settings.get': () => window.asit.settings.get(),
        'todos.list': () => window.asit.todos.list(),
        'questions.due': () => window.asit.questions.due(),
        'history.recent': () => window.asit.history.recent(5),
        'library.list': () => window.asit.library.list(),
        'activity.list': () => window.asit.activity.list(),
        'skills.list': () => window.asit.skills.list(),
        'vault.list': () => window.asit.vault.list(),
        'panes.downloads': () => window.asit.panes.downloads(),
        'session.state': () => window.asit.session.state(),
        'chat.running': () => window.asit.chat.running()
      }
      const bad = []
      for (const [name, fn] of Object.entries(calls)) {
        try { await fn() } catch (e) { bad.push({ name, error: String(e && e.message || e) }) }
      }
      return bad
    })()`)
    if (bridge.length > 0)
      fail(`these bridge calls failed:\n  ${bridge.map((b) => `${b.name}: ${b.error}`).join('\n  ')}`)
    console.log('[ui-smoke] every read-only bridge call the screens make succeeds')

    // Study-tools master switch: flipping it off must hide every study
    // launcher — the workspace timer, the Review rail item — live, no restart.
    if (!(await evalIn<boolean>(`!!document.querySelector('.timer-bar')`)))
      fail('the timer bar is missing with study tools ON')
    settingsSvc.setSettings({ studyEnabled: false })
    await evalIn(`window.__asitStore.getState().loadSettings()`)
    await waitFor(`!document.querySelector('.timer-bar')`, 'the timer bar to hide')
    if (
      await evalIn<boolean>(
        `[...document.querySelectorAll('.rail-item .rail-title')].some(e => e.textContent === 'Review')`
      )
    )
      fail('the Review rail item is still shown with study tools OFF')
    settingsSvc.setSettings({ studyEnabled: true })
    await evalIn(`window.__asitStore.getState().loadSettings()`)
    await waitFor(`document.querySelector('.timer-bar')`, 'the timer bar to return')
    console.log('[ui-smoke] the study-tools switch hides/restores timer + review live')

    tasks.deleteTask(task.id)
    console.log('[ui-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[ui-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Headless pane-isolation check: ASIT_SMOKE_PANES=1 electron out/main/index.js
// Proves the ownership boundary: a task's snapshot/click/key/type surface can
// see and drive ONLY its own panes — never another workspace's (or the
// scratchpad's) tabs, even via a ref leaked from another task's snapshot.
async function runPanesSmokeTest(): Promise<void> {
  const { createServer } = await import('http')
  const { mkdirSync, readdirSync, readFileSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')

  const fail = (msg: string): never => {
    console.error('[panes-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }

  try {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      // /c reproduces the two shapes that made agent clicks silently miss on
      // Google Forms: a page at non-100% zoom (CSS px != DIP) and a target
      // sitting under a full-bleed overlay.
      if (req.url?.startsWith('/c')) {
        const covered = req.url.includes('covered')
        res.end(
          `<title>Gamma</title><script>window.fired=0</script>` +
            `<div style="height:1200px"></div>` +
            `<div role="button" aria-label="Gamma Button" onclick="window.fired++">Gamma Button</div>` +
            `<div style="height:1200px"></div>` +
            (covered ? `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>` : '')
        )
        return
      }
      // /d is a page wearing every bit of furniture the declutter sheet is
      // meant to strip, plus real navigation it must NOT touch.
      if (req.url?.startsWith('/d')) {
        res.end(
          `<title>Delta</title><body class="modal-open" style="overflow:hidden">` +
            `<div id="onetrust-consent-sdk">We value your privacy</div>` +
            `<div id="intercom-container">chat with us</div>` +
            `<div class="smartbanner">Open in the app</div>` +
            `<nav class="site-nav"><a href="/a">Real navigation</a></nav>` +
            `<main class="keep"><button aria-label="Delta Button">Delta Button</button></main>`
        )
        return
      }
      const which = req.url === '/b' ? 'Beta' : 'Alpha'
      res.end(`<title>${which}</title><button aria-label="${which} Button">${which} Button</button>`)
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })

    // Parked off-screen rather than hidden: a WebContentsView inside a window
    // that was never shown gets a 0x0 viewport, so nothing lays out and every
    // click lands at (0,0). That is exactly why the old "own-pane works"
    // assertion passed while clicking nothing — give the panes the geometry
    // the renderer would give them in production, or the check is theatre.
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, x: -3000, y: -3000 })
    paneManager.attach(win)
    win.showInactive()
    for (const [id, path, owner] of [
      ['pane-a', '/a', 'task-a'],
      ['pane-b', '/b', 'task-b'],
      ['pane-c', '/c', 'task-c'],
      ['pane-d', '/d', 'task-d']
    ] as const) {
      paneManager.open(id, { url: `http://127.0.0.1:${port}${path}` }, owner)
      paneManager.setBounds(id, { x: 0, y: 0, width: 1000, height: 700 })
      paneManager.setVisible(id, true)
    }

    const folderA = join(tmpdir(), 'asit-panes-smoke', 'a')
    const folderB = join(tmpdir(), 'asit-panes-smoke', 'b')
    mkdirSync(folderA, { recursive: true })
    mkdirSync(folderB, { recursive: true })

    // Pages need a moment to load; snapshot until this task's one pane shows.
    let countA = 0
    for (let i = 0; i < 20 && countA !== 1; i++) {
      await new Promise((r) => setTimeout(r, 500))
      countA = await paneManager.snapshotAll(folderA, 'task-a')
    }
    if (countA !== 1) fail(`task-a snapshot saw ${countA} pages, expected exactly its own 1`)
    const pagesA = readdirSync(join(folderA, '.asit', 'pages'))
    const contentA = readFileSync(join(folderA, '.asit', 'pages', pagesA[0]), 'utf-8')
    if (!contentA.includes('Alpha Button')) fail('task-a snapshot missing its own page content')
    if (contentA.includes('Beta')) fail("task-a snapshot leaked task-b's page")
    console.log('[panes-smoke] snapshot sees only the owner task’s panes')

    // Cross-owner label targeting must find nothing…
    const crossClick = await paneManager.clickByLabel('task-a', 'Beta Button')
    if (!crossClick.startsWith('no visible element'))
      fail(`task-a clicked into task-b's pane: "${crossClick}"`)
    // …while the owner reaches its own page fine (positive control).
    const ownClick = await paneManager.clickByLabel('task-b', 'Beta Button')
    if (!ownClick.startsWith('clicked')) fail(`owner click failed: "${ownClick}"`)
    console.log('[panes-smoke] label click: cross-owner refused, own-pane works')

    // A ref captured in task-a's snapshot must be dead when task-b replays it.
    const ref = contentA.match(/\[(p\d+f\d+e\d+)\]/)?.[1]
    if (!ref) fail('no ref found in task-a snapshot')
    const crossRef = await paneManager.interact('task-b', ref!, 'click')
    if (!crossRef.startsWith('unknown ref')) fail(`cross-owner ref accepted: "${crossRef}"`)
    console.log('[panes-smoke] snapshot refs are dead outside their owner')

    // Un-indexed key/type land on the OWNER's first pane — and nowhere at all
    // for a task that has no panes (this exact path once sent Ctrl+P to an
    // unrelated personal tab).
    const keyOwnerless = paneManager.keyToPage('task-none', undefined, 'Ctrl+P')
    if (!keyOwnerless.startsWith('no browser pane open'))
      fail(`ownerless key was sent somewhere: "${keyOwnerless}"`)
    const keyOwned = paneManager.keyToPage('task-b', undefined, 'Escape')
    if (!keyOwned.startsWith('sent')) fail(`owner key refused: "${keyOwned}"`)
    console.log('[panes-smoke] keys go to the owner’s panes or nowhere')

    // --- click targeting -------------------------------------------------
    // A click is only real if the page's own listener ran. "clicked" used to
    // be reported unconditionally, so a miss looked like a success and the
    // agent moved on believing the form had advanced.
    const gammaWc = paneManager.viewForSmoke('pane-c')?.webContents
    if (!gammaWc) fail('pane-c missing')

    // 1. Page zoom: the rect is CSS px, sendInputEvent takes DIP. At 125% an
    //    unscaled click lands well above the button, on whatever is behind.
    gammaWc!.setZoomLevel(1)
    await new Promise((r) => setTimeout(r, 400))
    const zoomClick = await paneManager.clickByLabel('task-c', 'Gamma Button')
    const sent = zoomClick.match(/real input at (\d+),(\d+)/)
    if (!sent) fail(`zoomed click did not use real input: "${zoomClick}"`)
    const expected = (await gammaWc!.executeJavaScript(
      `(() => {
        const el = document.querySelector('[role=button]')
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })()`
    )) as { x: number; y: number }
    const zf = gammaWc!.getZoomFactor()
    if (Number(sent![2]) !== Math.round(expected.y * zf))
      fail(
        `click y was ${sent![2]} DIP; the button centre is ${expected.y} CSS px at ${zf.toFixed(2)}x zoom = ${Math.round(expected.y * zf)} DIP`
      )
    console.log('[panes-smoke] click coordinates are converted CSS px -> DIP under zoom')

    // 2. Covered target: OS input would hit the overlay, so it must fall back
    //    to dispatching on the element — and SAY that it did.
    await gammaWc!.loadURL(`http://127.0.0.1:${port}/c?covered`)
    await new Promise((r) => setTimeout(r, 400))
    const coveredClick = await paneManager.clickByLabel('task-c', 'Gamma Button')
    if (!/synthetic/.test(coveredClick))
      fail(`covered click claimed a real hit: "${coveredClick}"`)
    if ((await gammaWc!.executeJavaScript('window.fired')) !== 1)
      fail('covered click never reached the element')
    console.log('[panes-smoke] a covered target falls back to the element and reports it')

    // --- declutter -------------------------------------------------------
    // Injected by the pane's own dom-ready hook, so this exercises the real
    // wiring rather than a sheet the test built for itself.
    const deltaWc = paneManager.viewForSmoke('pane-d')?.webContents
    if (!deltaWc) fail('pane-d missing')
    const shown = async (sel: string): Promise<boolean | 'missing'> =>
      (await deltaWc!.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)})
           if (!el) return 'missing'
           const s = getComputedStyle(el)
           return s.display !== 'none' && s.visibility !== 'hidden' })()`
      )) as boolean | 'missing'
    for (const sel of ['#onetrust-consent-sdk', '#intercom-container', '.smartbanner']) {
      if ((await shown(sel)) !== false) fail(`declutter left "${sel}" visible`)
    }
    // The line that matters: it hides interruptions, never the site itself.
    if ((await shown('nav.site-nav')) !== true) fail('declutter hid site navigation')
    if ((await shown('main.keep')) !== true) fail('declutter hid page content')
    if (
      (await deltaWc!.executeJavaScript(`getComputedStyle(document.body).overflow === 'hidden'`)) ===
      true
    )
      fail('declutter removed the consent wall but left the page scroll-locked')
    console.log('[panes-smoke] declutter strips interruptions and leaves the site alone')

    // --- LRU eviction is announced ---------------------------------------
    // The renderer keeps its own "already opened" set. A pane main throws
    // away without saying so leaves a tab that looks open, is gone in main,
    // and renders blank forever — every setVisible/setBounds for it is a
    // silent no-op. That was the intermittent "a tab just doesn't load".
    const sentChannels: string[] = []
    const realSend = win.webContents.send.bind(win.webContents)
    ;(win.webContents as unknown as { send: (c: string, ...a: unknown[]) => void }).send = (
      channel: string,
      ...rest: unknown[]
    ) => {
      sentChannels.push(channel)
      realSend(channel, ...rest)
    }
    for (let i = 0; i < 20; i++) {
      paneManager.open(`pane-fill-${i}`, { url: `http://127.0.0.1:${port}/a` }, 'task-fill')
    }
    if (!sentChannels.includes(IPC.PANES_GONE))
      fail('panes were evicted under the cap without telling the renderer')
    const survivors = Array.from({ length: 20 }, (_, i) => `pane-fill-${i}`).filter((id) =>
      paneManager.viewForSmoke(id)
    )
    if (survivors.length === 20) fail('eviction never ran, so this proves nothing')
    console.log(
      `[panes-smoke] eviction is announced (${20 - survivors.length} panes retired, renderer told)`
    )

    // --- the context header is owner-scoped too ---------------------------
    // buildPaneContext feeds every agent turn; it must be as blind to other
    // workspaces' tabs as snapshotAll is, and say NOTHING for private tasks.
    {
      const tasksSvc = await import('./services/tasks')
      const { buildPaneContext } = await import('./services/context')
      const ctxA = tasksSvc.createTask({ title: 'Ctx A' })
      const ctxB = tasksSvc.createTask({ title: 'Ctx B' })
      const ctxP = tasksSvc.createTask({ title: 'Ctx Private', aiDisabled: true })
      paneManager.open('ctx-pane-a', { url: `http://127.0.0.1:${port}/a` }, ctxA.id)
      paneManager.open('ctx-pane-b', { url: `http://127.0.0.1:${port}/b` }, ctxB.id)
      paneManager.open('ctx-pane-p', { url: `http://127.0.0.1:${port}/a` }, ctxP.id)
      await new Promise((r) => setTimeout(r, 800))
      const headerA = buildPaneContext(ctxA.id)
      if (!headerA.includes('ctx-pane') && !headerA.includes(`/a`))
        fail(`context header for A missed its own pane: "${headerA}"`)
      if (headerA.includes('/b')) fail("context header for A leaked task B's pane")
      if (buildPaneContext(ctxP.id) !== '')
        fail('context header exists for a PRIVATE task')
      paneManager.close('ctx-pane-a')
      paneManager.close('ctx-pane-b')
      paneManager.close('ctx-pane-p')
      tasksSvc.deleteTask(ctxA.id)
      tasksSvc.deleteTask(ctxB.id)
      tasksSvc.deleteTask(ctxP.id)
      console.log('[panes-smoke] the context header is owner-scoped and silent for private tasks')
    }

    server.close()
    console.log('[panes-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[panes-smoke] FAIL:', err)
    app.exit(1)
  }
}

// MANUAL network probe (deliberately NOT in scripts/smoke.cjs — it talks to
// Google): ASIT_SMOKE_GOOGLE=1 electron out/main/index.js
// Answers "does Google sign-in accept ASIT's browser identity?" by loading
// the real login page on the browse partition with applyBrowserIdentity
// applied — the exact code path the accounts modal and every pane use — and
// classifying what Google serves: the email form (accepted), or the
// "browser or app may not be secure" wall (rejected). It then submits a
// probe email to see whether the SECOND step is served too (the wall
// sometimes appears only after the identifier). No credentials are ever
// entered.
async function runGoogleSigninProbe(): Promise<void> {
  const finish = (verdict: string, ok: boolean): void => {
    console.log(`[google-probe] VERDICT: ${verdict}`)
    console.log(ok ? '[google-probe] ALL PASS' : '[google-probe] FAIL: blocked')
    app.exit(ok ? 0 : 1)
  }
  try {
    const { applyBrowserIdentity, browserUserAgent } = await import('./services/useragent')
    applyBrowserIdentity('persist:asit-browse')
    console.log(`[google-probe] identity: ${browserUserAgent()}`)

    // Mirror accounts.openLogin('google') exactly — partition + identity.
    // Parked off-screen (same trick as the panes smoke): shown for real
    // layout + input, never on the user's screen.
    const win = new BrowserWindow({
      show: false,
      x: -3000,
      y: -3000,
      width: 980,
      height: 760,
      webPreferences: { partition: 'persist:asit-browse', sandbox: true, contextIsolation: true }
    })
    win.showInactive()
    await win.loadURL('https://accounts.google.com/')
    await new Promise((r) => setTimeout(r, 2500))

    const read = (): Promise<{ url: string; text: string; hasEmail: boolean }> =>
      win.webContents.executeJavaScript(
        `({
          url: location.href,
          text: (document.body?.innerText || '').slice(0, 1500),
          hasEmail: !!document.querySelector('input[type=email], #identifierId')
        })`,
        true
      ) as Promise<{ url: string; text: string; hasEmail: boolean }>

    const blockedIn = (text: string): boolean =>
      /may not be secure|couldn.t sign you in|not be secure|use a supported browser|update your browser/i.test(
        text
      )

    const first = await read()
    console.log(`[google-probe] landed on ${first.url}`)
    if (blockedIn(first.text)) {
      console.log(`[google-probe] page says: ${first.text.slice(0, 300).replace(/\n+/g, ' | ')}`)
      finish('BLOCKED at the sign-in page — Google refuses this browser identity', false)
      return
    }
    if (!first.hasEmail) {
      // Maybe already signed in (real profile) or an interstitial.
      if (/myaccount|signinoptions|manage your google account/i.test(first.text + first.url)) {
        finish('ALREADY SIGNED IN on this profile — sign-in evidently works', true)
        return
      }
      console.log(`[google-probe] unexpected page: ${first.text.slice(0, 300).replace(/\n+/g, ' | ')}`)
      finish('no email form and no known wall — inspect manually', false)
      return
    }
    console.log('[google-probe] email form served — identifier page accepts us')

    // Step 2: submit a probe identifier (no password is ever entered — the
    // goal is only to see whether Google serves the next step or a wall).
    await win.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('input[type=email], #identifierId')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, 'asit.probe.check@gmail.com')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        const next = document.querySelector('#identifierNext button, #identifierNext')
        if (next) next.click()
      })()`,
      true
    )
    await new Promise((r) => setTimeout(r, 3500))
    const second = await read()
    if (blockedIn(second.text)) {
      console.log(`[google-probe] page says: ${second.text.slice(0, 300).replace(/\n+/g, ' | ')}`)
      finish('BLOCKED after the identifier — the wall appears at step 2', false)
      return
    }
    if (/enter your password|couldn.t find your google account|wrong number of|try again/i.test(second.text)) {
      finish('ACCEPTED — Google serves the full sign-in flow to this identity', true)
      return
    }
    console.log(`[google-probe] step-2 page: ${second.text.slice(0, 300).replace(/\n+/g, ' | ')}`)
    finish('identifier page accepted; step-2 response inconclusive — inspect above', true)
  } catch (err) {
    console.error('[google-probe] FAIL:', err)
    app.exit(1)
  }
}

// Headless workflow-engine check: ASIT_SMOKE_WORKFLOWS=1 electron out/main/index.js
// CLI-free: proves the runner end to end — param substitution, per-step
// outcomes, on_failure continue vs stop, wait_for timeout against a live
// pane, the confirm pause/resume, run-row persistence, and the startup
// interrupted sweep.
async function runWorkflowsSmokeTest(): Promise<void> {
  const { createServer } = await import('http')
  const wf = await import('./services/workflows')
  const tasksSvc = await import('./services/tasks')
  const todos = await import('./services/todos')
  const { getDb: db } = await import('./db')

  const fail = (msg: string): never => {
    console.error('[workflows-smoke] FAIL:', msg)
    app.exit(1)
    throw new Error(msg)
  }
  const waitRun = async (runId: string, want: string, ms = 60_000): Promise<void> => {
    const deadline = Date.now() + ms
    for (;;) {
      const run = wf.getRun(runId)
      if (run?.status === want) return
      if (
        run &&
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status) &&
        run.status !== want
      )
        fail(`run finished as ${run.status}, wanted ${want}`)
      if (Date.now() > deadline) fail(`run never reached ${want} (at ${wf.getRun(runId)?.status})`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  try {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<title>WF</title><button aria-label="Alpha Button">Alpha Button</button>')
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    const win = new BrowserWindow({ show: false, width: 900, height: 600, x: -3000, y: -3000 })
    paneManager.attach(win)
    win.showInactive()

    const task = tasksSvc.createTask({ title: 'Workflow Smoke' })
    paneManager.open('wf-pane', { url: `http://127.0.0.1:${port}/` }, task.id)
    paneManager.setBounds('wf-pane', { x: 0, y: 0, width: 900, height: 600 })
    paneManager.setVisible('wf-pane', true)
    // Let the page load so assert/wait_for see real content.
    for (let i = 0; i < 20; i++) {
      if (await paneManager.existsCondition(task.id, { text: 'Alpha Button' })) break
      await new Promise((r) => setTimeout(r, 300))
    }

    // The full mixed run: params, live-pane assert, continue-on-fail,
    // wait_for timeout, confirm gate, and a final action.
    const saved = wf.saveWorkflow({
      name: 'smoke-mixed',
      taskId: task.id,
      params: [{ name: 'item', required: true }],
      steps: [
        { kind: 'action', action: { action: 'add_todo', value: 'wf {{item}}' } },
        { kind: 'assert', text: 'Alpha Button' },
        { kind: 'action', action: { action: 'add_todo' }, on_failure: 'continue' },
        { kind: 'wait_for', text: 'never-appears-xyz', timeout_min: 0.1, on_failure: 'continue' },
        { kind: 'confirm', message: 'Carry on?' },
        { kind: 'action', action: { action: 'list_todos' } }
      ]
    })
    if (!saved.ok) fail(`save failed: ${saved.reason}`)

    const missing = await wf.runWorkflow('smoke-mixed', { params: {} })
    if (missing.started) fail('run started without a required param')

    const started = await wf.runWorkflow('smoke-mixed', { params: { item: 'alpha' } })
    if (!started.started || !started.runId) fail(`run did not start: ${started.reason}`)
    const runId = started.runId!

    await waitRun(runId, 'waiting_confirm', 90_000)
    const paused = wf.getRun(runId)!
    if (!paused.confirmMessage?.includes('Carry on'))
      fail('waiting_confirm run has no confirm message')
    const results = paused.stepResults
    if (!results[0]?.ok) fail(`param step failed: ${results[0]?.outcome}`)
    if (!todos.listTodos().some((t) => t.text === 'wf alpha'))
      fail('{{param}} was not substituted into the action value')
    if (!results[1]?.ok) fail(`live-pane assert failed: ${results[1]?.outcome}`)
    if (results[2]?.ok) fail('an argless add_todo was reported ok')
    if (results[3]?.ok) fail('wait_for on absent text did not time out')
    console.log('[workflows-smoke] params, live-pane assert, continue-on-fail, wait_for timeout ✓')

    if (wf.confirmRun('not-the-run', true) === 'approved') fail('confirm accepted a wrong run id')
    wf.confirmRun(runId, true)
    await waitRun(runId, 'succeeded', 60_000)
    const done = wf.getRun(runId)!
    if (done.stepResults.length !== 6) fail(`expected 6 step results, got ${done.stepResults.length}`)
    if (!done.stepResults[4].ok) fail('approved confirm step not recorded ok')
    console.log('[workflows-smoke] confirm paused the run and a user click resumed it ✓')

    // Default on_failure is STOP: the second step must never run.
    wf.saveWorkflow({
      name: 'smoke-stop',
      taskId: task.id,
      steps: [
        { kind: 'assert', text: 'never-appears-xyz' },
        { kind: 'action', action: { action: 'add_todo', value: 'must-not-exist' } }
      ]
    })
    const stopRun = await wf.runWorkflow('smoke-stop', {})
    if (!stopRun.started) fail('stop-run did not start')
    await waitRun(stopRun.runId!, 'failed', 60_000)
    if (wf.getRun(stopRun.runId!)!.stepResults.length !== 1)
      fail('a failing step did not stop the run')
    if (todos.listTodos().some((t) => t.text === 'must-not-exist'))
      fail('a step after a failure still executed')
    console.log('[workflows-smoke] a failed step stops the run by default ✓')

    // Runs persist; a row left "running" by a dead process sweeps to interrupted.
    if (wf.listRuns().length < 2) fail('run history missing rows')
    db()
      .prepare(
        "INSERT INTO workflow_runs (id, workflow_id, task_id, status, trigger, current_step, step_results_json, cost_usd, started_at) VALUES ('dead-run', 'x', NULL, 'running', 'manual', 0, '[]', 0, ?)"
      )
      .run(new Date().toISOString())
    if (wf.sweepInterruptedRuns() < 1) fail('sweep found nothing to interrupt')
    const sweptRow = db()
      .prepare("SELECT status FROM workflow_runs WHERE id = 'dead-run'")
      .get() as { status: string }
    if (sweptRow.status !== 'interrupted') fail('dead run not marked interrupted')
    console.log('[workflows-smoke] run history persists; dead runs sweep to interrupted ✓')

    server.close()
    console.log('[workflows-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[workflows-smoke] FAIL:', err)
    app.exit(1)
  }
}

// Headless agent-tooling check: ASIT_SMOKE_AGENT=1 electron out/main/index.js
// Proves: scoped Edit(**)/Write(**) permissions let the CLI edit notes.md and
// append app actions; the action executor performs them.
async function runAgentSmokeTest(): Promise<void> {
  const { readFileSync, existsSync } = await import('fs')
  const { join } = await import('path')
  const tasks = await import('./services/tasks')
  const questionsSvc = await import('./services/questions')
  const actions = await import('./services/actions')
  const { runClaudeStream } = await import('./services/claude')

  const task = tasks.createTask({ title: 'Agent Smoke Test' })
  const finish = (ok: boolean, msg: string): void => {
    console.log(ok ? `[agent-smoke] PASS: ${msg}` : `[agent-smoke] FAIL: ${msg}`)
    tasks.deleteTask(task.id)
    app.exit(ok ? 0 : 1)
  }

  // The watcher powers the act→verify loop the model uses in production.
  actions.watchTaskActions(task.id)

  runClaudeStream(
    {
      cwd: task.folderPath,
      prompt:
        'Do exactly this: (1) append the line "AGENT-EDIT-OK" to the end of notes.md; ' +
        '(2) APPEND this exact single line to .asit/actions.ndjson (Read it, Write it back with the line added at the end): ' +
        '{"action":"add_questions","questions":[{"q":"smoke q","a":"smoke a"}]} ' +
        '(3) Then Read .asit/actions-result.md repeatedly until it contains a batch echoing your action (takes ~2s), ' +
        'and reply with ONLY the outcome text that appears after the arrow for it.',
      allowedTools: 'Read,Glob,Grep,Edit(**),Write(**)'
    },
    {
      onResult: async ({ text: reply, isError }) => {
        if (isError) return finish(false, 'CLI returned error')
        const notes = readFileSync(join(task.folderPath, 'notes.md'), 'utf-8')
        if (!notes.includes('AGENT-EDIT-OK'))
          return finish(false, 'notes.md not edited — Edit(**) permission did not work')
        console.log('[agent-smoke] notes.md edited by CLI ✓')

        const actionsFile = actions.actionsFileFor(task.folderPath)
        if (!existsSync(actionsFile)) return finish(false, 'actions.ndjson not written')
        const qs = questionsSvc.listQuestions(task.id)
        if (qs.length !== 1 || qs[0].question !== 'smoke q')
          return finish(false, 'watcher did not execute the appended action')
        console.log('[agent-smoke] watcher executed the action ✓')
        if (!/questions added/i.test(reply))
          return finish(false, `model did not read its outcome back (replied: ${reply.slice(0, 120)})`)
        console.log('[agent-smoke] model read its own outcome from actions-result.md ✓')
        finish(true, 'full act→verify loop works: append → execute → result file → model reads it')
      },
      onError: (m) => finish(false, m)
    }
  )
}

// Headless question-pipeline check: ASIT_SMOKE_QGEN=1 electron out/main/index.js
// Proves: SM-2 math, generation job queue end-to-end (claude reads a file in
// the task folder, returns parseable questions), answer flow reschedules.
async function runQuestionSmokeTest(): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs')
  const { join } = await import('path')
  const tasks = await import('./services/tasks')
  const resources = await import('./services/resources')
  const q = await import('./services/questions')

  // 1. SM-2 unit checks (pure function)
  const fresh = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 }
  const now = new Date('2026-08-10T12:00:00Z')
  const good1 = q.scheduleNext(fresh, 2, now)
  const again = q.scheduleNext(fresh, 0, now)
  const good3 = q.scheduleNext({ ease: 2.5, intervalDays: 3, reps: 2, lapses: 0 }, 2, now)
  if (good1.intervalDays !== 1) return fail('SM-2: first Good should be 1d')
  if (again.reps !== 0 || again.lapses !== 1 || !again.dueAt.includes('12:10'))
    return fail('SM-2: Again should reset + due in 10min')
  if (Math.abs(good3.intervalDays - 7.5) > 0.01) return fail('SM-2: 3d * 2.5 ease should be 7.5d')
  console.log('[qgen-smoke] SM-2 math ok')

  // 2. Generation pipeline (uses a text file standing in for a PDF —
  //    the CLI Read tool handles both; PDF parsing is its own capability)
  const task = tasks.createTask({ title: 'QGen Smoke Test' })
  mkdirSync(join(task.folderPath, 'pdfs'), { recursive: true })
  const srcPath = join(task.folderPath, 'source.txt')
  writeFileSync(
    srcPath,
    'The water cycle: evaporation turns surface water into vapor driven by solar energy. ' +
      'Condensation forms clouds when vapor cools at altitude. Precipitation returns water to the surface as rain or snow. ' +
      'Infiltration recharges groundwater aquifers, while runoff returns water to rivers and oceans.'
  )
  const resource = resources.addPdfResource(task.id, srcPath, task.folderPath)

  q.initQuestions(() => null)

  const finishTest = (ok: boolean, msg: string): void => {
    console.log(ok ? `[qgen-smoke] PASS: ${msg}` : `[qgen-smoke] FAIL: ${msg}`)
    tasks.deleteTask(task.id)
    app.exit(ok ? 0 : 1)
  }
  function fail(msg: string): void {
    console.log(`[qgen-smoke] FAIL: ${msg}`)
    app.exit(1)
  }

  q.enqueueGeneration(task.id, resource.id, 'generate')

  // Poll for completion (single-concurrency queue, generous timeout)
  const startedAt = Date.now()
  const poll = setInterval(async () => {
    const generated = q.listQuestions(task.id)
    if (generated.length > 0) {
      clearInterval(poll)
      console.log(`[qgen-smoke] ${generated.length} questions generated, e.g.:`)
      console.log('  Q:', generated[0].question)
      console.log('  A:', generated[0].answer)
      const due = q.dueQuestions(20, task.id)
      if (due.length !== generated.length) return finishTest(false, 'new questions not due')
      const result = await q.answerQuestion(generated[0].id, { selfGrade: 2 })
      const after = q.dueQuestions(20, task.id)
      if (after.length !== due.length - 1) return finishTest(false, 'Good answer did not defer question')

      const { getDb } = await import('./db')
      const usageRow = getDb()
        .prepare("SELECT COUNT(*) AS c, COALESCE(SUM(cost_usd),0) AS cost FROM usage_log WHERE task_id = ? AND kind = 'generate'")
        .get(task.id) as { c: number; cost: number }
      if (usageRow.c < 1) return finishTest(false, 'usage_log has no generate row')
      console.log(`[qgen-smoke] usage logged: ${usageRow.c} call(s), $${usageRow.cost.toFixed(4)}`)

      // Cross-document pipeline: fuzzy file resolution + parametrized job
      const beforeCount = q.listQuestions(task.id).length
      const enq = q.enqueueCustomGeneration(task.id, {
        sources: ['source'], // fuzzy-matches source.txt
        mode: 'generate',
        count: 3,
        instructions: 'focus on the phases of the water cycle'
      })
      console.log('[qgen-smoke] custom job:', enq)
      const customStart = Date.now()
      const customPoll = setInterval(() => {
        const now = q.listQuestions(task.id).length
        if (now > beforeCount) {
          clearInterval(customPoll)
          console.log(`[qgen-smoke] custom pipeline added ${now - beforeCount} questions ✓`)
          finishTest(true, `generation + due + reschedule + usage + custom pipeline all work (next due ${result.nextDueAt})`)
        } else if (Date.now() - customStart > 8 * 60 * 1000) {
          clearInterval(customPoll)
          finishTest(false, 'custom pipeline timed out')
        }
      }, 3000)
    } else if (Date.now() - startedAt > 8 * 60 * 1000) {
      clearInterval(poll)
      finishTest(false, 'generation timed out')
    }
  }, 3000)
}

// Headless Claude-pipeline check: ASIT_SMOKE_CHAT=1 electron out/main/index.js
// Proves: path resolution, spawn, cwd context (reads a file without being told
// where it is), streaming deltas, session resume.
async function runChatSmokeTest(): Promise<void> {
  const { writeFileSync } = await import('fs')
  const { join } = await import('path')
  const tasks = await import('./services/tasks')
  const { runClaudeStream } = await import('./services/claude')

  const task = tasks.createTask({ title: 'Chat Smoke Test', description: 'smoke' })
  writeFileSync(
    join(task.folderPath, 'notes.md'),
    '# Notes\n\nThe secret codeword for this task is BLUEBIRD.\n'
  )

  const finish = (ok: boolean, msg: string): void => {
    console.log(ok ? `[chat-smoke] PASS: ${msg}` : `[chat-smoke] FAIL: ${msg}`)
    tasks.deleteTask(task.id)
    app.exit(ok ? 0 : 1)
  }

  let sessionId: string | null = null
  let deltas = 0

  runClaudeStream(
    {
      cwd: task.folderPath,
      prompt: 'Read notes.md and reply with ONLY the secret codeword it contains.'
    },
    {
      onInit: (id) => {
        sessionId = id
        console.log('[chat-smoke] init, session', id)
      },
      onDelta: () => {
        deltas++
      },
      onResult: ({ text, isError }) => {
        console.log('[chat-smoke] turn 1 result:', JSON.stringify(text.slice(0, 100)), 'deltas:', deltas)
        if (isError || !/BLUEBIRD/i.test(text)) {
          finish(false, 'codeword not found — cwd context broken')
          return
        }
        if (!sessionId) {
          finish(false, 'no session id captured')
          return
        }
        // Turn 2: resume — proves conversation continuity.
        runClaudeStream(
          {
            cwd: task.folderPath,
            prompt: 'Repeat the codeword you just told me, lowercase, nothing else.',
            resumeSessionId: sessionId
          },
          {
            onResult: ({ text: t2, isError: e2 }) => {
              console.log('[chat-smoke] turn 2 result:', JSON.stringify(t2.slice(0, 100)))
              if (e2 || !/bluebird/.test(t2)) finish(false, 'resume did not carry context')
              else finish(true, `streaming (${deltas} deltas) + cwd context + resume all work`)
            },
            onError: (m) => finish(false, `turn 2: ${m}`)
          }
        )
      },
      onError: (m) => finish(false, `turn 1: ${m}`)
    }
  )
}

// Headless data-layer check: ASIT_SMOKE=1 electron out/main/index.js
async function runSmokeTest(): Promise<void> {
  const { existsSync, readFileSync } = await import('fs')
  const { join } = await import('path')
  const tasks = await import('./services/tasks')
  const resources = await import('./services/resources')
  const settings = await import('./services/settings')

  try {
    const task = tasks.createTask({
      title: 'Smoke Test Task',
      description: 'created by smoke test',
      priority: 1,
      dueDate: '2026-09-01'
    })
    console.log('[smoke] created task', task.id, 'at', task.folderPath)

    if (!existsSync(join(task.folderPath, 'CLAUDE.md'))) throw new Error('CLAUDE.md missing')
    if (!existsSync(join(task.folderPath, 'notes.md'))) throw new Error('notes.md missing')
    console.log('[smoke] folder provisioned with CLAUDE.md + notes.md')

    resources.addUrlResource(task.id, 'Overleaf', 'overleaf.com')
    tasks.refreshClaudeMd(task.id)
    const claudeMd = readFileSync(join(task.folderPath, 'CLAUDE.md'), 'utf-8')
    if (!claudeMd.includes('https://overleaf.com')) throw new Error('CLAUDE.md not refreshed')
    console.log('[smoke] resource added + CLAUDE.md inventory updated')

    // The agent can tidy the rail, not just add to it. Unpinning is only safe
    // to hand a model because it drops the row and leaves files alone.
    const actions = await import('./services/actions')
    resources.addUrlResource(task.id, 'Piazza', 'piazza.com')
    resources.addUrlResource(task.id, 'Gradescope', 'gradescope.com')
    await actions.executeAction(task.id, {
      action: 'reorder_pins',
      order: ['Gradescope', 'Overleaf']
    })
    let titles = resources.listResources(task.id).map((r) => r.title)
    if (titles[0] !== 'Gradescope' || titles[1] !== 'Overleaf')
      throw new Error(`reorder_pins did not apply: ${titles.join(', ')}`)
    if (!titles.includes('Piazza'))
      throw new Error('reorder_pins dropped a pin the agent did not name')
    await actions.executeAction(task.id, { action: 'rename_pin', target: 'piazza', title: 'Q&A' })
    await actions.executeAction(task.id, { action: 'unpin', target: 'Gradescope' })
    titles = resources.listResources(task.id).map((r) => r.title)
    if (titles.includes('Gradescope')) throw new Error('unpin did not remove the pin')
    if (!titles.includes('Q&A')) throw new Error('rename_pin did not apply')
    const missTarget = await actions.executeAction(task.id, { action: 'unpin', target: 'nope' })
    if (!missTarget.startsWith('unpin: no pin')) throw new Error('unpin invented a match')
    console.log('[smoke] agent can unpin / rename / reorder the resource rail')

    // Drag-and-drop from Explorer lands here. The renderer resolves the paths
    // (webUtils, since Electron 32 removed File.path) and main copies them in.
    const fsMod = await import('fs')
    const { tmpdir } = await import('os')
    const dropDir = join(tmpdir(), 'asit-drop-smoke')
    fsMod.mkdirSync(dropDir, { recursive: true })
    fsMod.writeFileSync(join(dropDir, 'dropped.pdf'), '%PDF-1.4 ')
    fsMod.writeFileSync(join(dropDir, 'notes.txt'), 'hello')
    const droppedPdf = resources.addLocalFile(task.id, join(dropDir, 'dropped.pdf'), task.folderPath)
    const droppedTxt = resources.addLocalFile(task.id, join(dropDir, 'notes.txt'), task.folderPath)
    if (droppedPdf.kind !== 'pdf' || !droppedPdf.filePath?.includes('pdfs'))
      throw new Error('dropped PDF did not land in pdfs/')
    if (droppedTxt.kind !== 'file' || !droppedTxt.filePath?.includes('files'))
      throw new Error('dropped non-PDF did not land in files/')
    if (!existsSync(droppedPdf.filePath!) || !existsSync(droppedTxt.filePath!))
      throw new Error('dropped file was not copied into the task folder')
    // Dropping the same name twice must not overwrite the first.
    const again = resources.addLocalFile(task.id, join(dropDir, 'dropped.pdf'), task.folderPath)
    if (again.filePath === droppedPdf.filePath)
      throw new Error('a second drop of the same filename overwrote the first')
    const lib = await import('./services/library')
    const libFiles = lib.addPathsToLibrary([join(dropDir, 'notes.txt')])
    if (!libFiles.some((f) => f.name === 'notes.txt'))
      throw new Error('drop onto the library did not add the file')
    console.log('[smoke] dropped files copy into the task folder and the library')

    // Browsing history: what the address bar completes against. The private
    // exclusion is the load-bearing part — a workspace the user marked private
    // must not have its URLs indexed into a global searchable list.
    const hist = await import('./services/history')
    hist.clearHistory()
    hist.recordVisit('https://gradescope.com/courses/1', 'Gradescope', task.id)
    hist.recordVisit('https://gradescope.com/courses/1', 'Gradescope', task.id) // same page again
    hist.recordVisit('https://piazza.com/class', 'Piazza', task.id)
    hist.recordVisit('http://127.0.0.1:9999/local', 'Local', task.id)
    const histPriv = tasks.createTask({ title: 'History Private' })
    tasks.setTaskPrivacy(histPriv.id, true)
    hist.recordVisit('https://secret.example.com/x', 'Secret', histPriv.id)

    const all = hist.recentHistory()
    if (all.some((h) => h.url.includes('secret.example.com')))
      throw new Error('a private workspace leaked into browsing history')
    if (all.some((h) => h.url.includes('127.0.0.1')))
      throw new Error('localhost noise was recorded')
    const grade = all.find((h) => h.url.includes('gradescope'))
    if (!grade || grade.visitCount !== 2)
      throw new Error(`revisits should merge and count up, got ${grade?.visitCount}`)
    const hits = hist.searchHistory('grade')
    if (hits[0]?.url !== 'https://gradescope.com/courses/1')
      throw new Error('history search did not rank the obvious match first')
    if (hist.searchHistory('piaz').length !== 1) throw new Error('title/url search missed')
    tasks.deleteTask(histPriv.id)
    console.log('[smoke] history records, ranks, and never sees private workspaces')

    // Both halves of the app derive their keys from one table; a key claimed
    // by two different actions means the second silently never fires.
    const { conflictingAccelerators } = await import('@shared/shortcuts')
    const clashes = conflictingAccelerators()
    if (clashes.length > 0)
      throw new Error(`two actions share these accelerators: ${clashes.join(', ')}`)
    // Every channel the preload can call must actually have a handler.
    // Registration is imperative code: a handler can be skipped, mistyped, or
    // stranded after an early return, and today the only way to find out is a
    // user clicking the thing and getting "Error invoking remote method 'x'".
    {
      const { registerIpc, registeredIpcChannels } = await import('./ipc')
      registerIpc(() => null)
      const { readFileSync: readSrc } = await import('fs')
      const { IPC } = await import('@shared/ipc-contract')
      const preloadSrc = readSrc(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf-8')
      const wanted = new Set<string>()
      for (const m of preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*IPC\.([A-Z_]+)/g)) {
        const channel = (IPC as unknown as Record<string, string>)[m[1]]
        if (channel) wanted.add(channel)
      }
      if (wanted.size < 50) throw new Error(`only found ${wanted.size} preload calls — the scan broke`)
      const have = new Set(registeredIpcChannels())
      const missing = [...wanted].filter((c) => !have.has(c))
      if (missing.length > 0)
        throw new Error(`the preload calls these, but nothing handles them: ${missing.join(', ')}`)
      console.log(`[smoke] all ${wanted.size} IPC channels the preload calls have handlers`)
    }

    const { ungroupedShortcuts } = await import('@shared/shortcuts')
    const missing = ungroupedShortcuts()
    if (missing.length > 0)
      throw new Error(`these shortcuts would not appear on the cheat sheet: ${missing.join(', ')}`)
    console.log('[smoke] no shortcut is double-booked, and every one is listed on the sheet')

    // Backups. Written after six days of work vanished with a WAL: the main
    // database file was perfectly intact and six days stale, so nothing
    // reported an error — the app just came up missing a week.
    {
      const { app: electronApp } = await import('electron')
      const dbmod = await import('./db')
      const backup = await import('./db/backup')
      const { readdirSync: rd, writeFileSync: wf2, copyFileSync } = await import('fs')
      const userData = electronApp.getPath('userData')
      const live = dbmod.getDb()

      if (!backup.isHealthy(live)) throw new Error('a healthy database reported unhealthy')
      const snapPath = backup.snapshot(live, userData, 'smoke')
      if (!snapPath || !existsSync(snapPath)) throw new Error('snapshot was not written')
      // A snapshot has to be a usable database, not just a file that exists.
      const Sqlite = (await import('better-sqlite3')).default
      const snapDb = new Sqlite(snapPath, { readonly: true })
      const snapTasks = (snapDb.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c
      snapDb.close()
      if (snapTasks < 1) throw new Error('the snapshot contains no tasks')
      console.log(`[smoke] database snapshot written and readable (${snapTasks} tasks)`)

      // Now corrupt a COPY and prove the open path detects it and restores.
      const scratch = join(tmpdir(), 'asit-db-rescue-smoke')
      ;(await import('fs')).rmSync(scratch, { recursive: true, force: true })
      ;(await import('fs')).mkdirSync(join(scratch, 'backups'), { recursive: true })
      const brokenPath = join(scratch, 'asit.db')
      copyFileSync(snapPath, join(scratch, 'backups', 'asit-2020-01-01T00-00-00-000Z-daily.db'))
      wf2(brokenPath, 'this is definitely not a sqlite database')

      let broken: InstanceType<typeof Sqlite> | null = null
      try {
        broken = new Sqlite(brokenPath)
        if (backup.isHealthy(broken)) throw new Error('a corrupt database passed the health check')
        broken.close()
      } catch {
        broken = null // could not even open it — also a failure we must handle
      }
      // An EMPTY database passes quick_check — it is a structurally perfect
      // file with nothing in it. Restoring one looks like a successful
      // recovery and destroys everything, so plant one NEWER than the good
      // backup and prove it is skipped rather than used.
      wf2(join(scratch, 'backups', 'asit-2099-01-01T00-00-00-000Z-daily.db'), '')
      const usedBackup = backup.restoreFromSnapshot(brokenPath, scratch)
      if (usedBackup && usedBackup.startsWith('asit-2099'))
        throw new Error('restored from an EMPTY backup — that would wipe the user')
      if (!usedBackup) throw new Error('no backup was used to restore a corrupt database')
      const healed = new Sqlite(brokenPath, { readonly: true })
      const healedTasks = (healed.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c
      healed.close()
      if (healedTasks !== snapTasks)
        throw new Error(`restore lost data: ${healedTasks} tasks, expected ${snapTasks}`)
      if (!rd(scratch).some((f) => f.startsWith('asit.db.unreadable-')))
        throw new Error('the corrupt database was deleted instead of kept aside')
      console.log('[smoke] a corrupt database is detected, kept aside, and restored from backup')
    }

    const listed = tasks.listTasks()
    if (!listed.some((t) => t.id === task.id)) throw new Error('task not listed')

    const s = settings.getSettings()
    console.log('[smoke] settings defaults ok, claudePath =', s.claudePath)

    // Search-engine setting must actually steer search URL building.
    if (s.searchEngine !== 'google') throw new Error('searchEngine default is not google')
    const search = await import('./services/search')
    if (!search.searchUrlFor('smoke query').includes('google.com'))
      throw new Error('default search URL is not Google')
    settings.setSettings({ searchEngine: 'duckduckgo' })
    if (!search.searchUrlFor('smoke query').includes('duckduckgo.com'))
      throw new Error('search URL ignored the engine setting')
    settings.setSettings({ searchEngine: 'custom', searchUrlCustom: 'https://x.example/s?q={q}' })
    if (search.searchUrlFor('a b') !== 'https://x.example/s?q=a%20b')
      throw new Error('custom search template not applied')
    settings.setSettings({ searchEngine: 'google', searchUrlCustom: '' })
    console.log('[smoke] search engine setting steers searchUrlFor')

    // Global bookmarks: CRUD round-trip and the UNIQUE-url upsert (starring
    // twice must refresh, never duplicate).
    const bookmarks = await import('./services/bookmarks')
    const bm = bookmarks.addBookmark('https://example.com/a', 'Example A')
    bookmarks.addBookmark('https://example.com/a', 'Example A (renamed)')
    const listed1 = bookmarks.listBookmarks().filter((b) => b.url === 'https://example.com/a')
    if (listed1.length !== 1) throw new Error('bookmark upsert duplicated the row')
    if (listed1[0].title !== 'Example A (renamed)')
      throw new Error('bookmark upsert did not refresh the title')
    if (!bookmarks.isBookmarked('https://example.com/a'))
      throw new Error('isBookmarked missed a stored URL')
    bookmarks.updateBookmark(bm.id, { folder: 'work' })
    if (bookmarks.listBookmarks()[0]?.folder !== 'work')
      throw new Error('bookmark folder update lost')
    bookmarks.removeBookmark(bm.id)
    if (bookmarks.isBookmarked('https://example.com/a'))
      throw new Error('bookmark not removed')
    const { MIGRATION_COUNT } = await import('./db/migrations')
    const version = (await import('./db')).getDb().pragma('user_version', { simple: true })
    if (version !== MIGRATION_COUNT)
      throw new Error(`user_version ${version} != MIGRATION_COUNT ${MIGRATION_COUNT}`)
    console.log('[smoke] bookmarks CRUD + upsert ok, schema at version', version)

    // One-click setup plumbing loads and answers coherently (no network, no
    // terminal — just the read-only status path the UI polls).
    const setupSvc = await import('./services/setup')
    const login = setupSvc.cliLoginStatus()
    if (typeof login.installed !== 'boolean')
      throw new Error('cliLoginStatus returned a bad shape')
    const installState = setupSvc.cliInstallState()
    if (installState.installing !== false) throw new Error('installer claims to be running at boot')
    console.log(
      `[smoke] setup status path ok (installed=${login.installed}, loggedIn=${login.loggedIn})`
    )

    // PDF text extraction (pure-JS, no CLI involved) using a sample PDF
    const samplePdf = join(process.cwd(), 'node_modules', 'pdf-parse', 'test', 'data', '05-versions-space.pdf')
    if (existsSync(samplePdf)) {
      const copied = resources.addPdfResource(task.id, samplePdf, task.folderPath)
      const txt = await resources.ensurePdfText(copied.filePath!)
      if (!txt || !existsSync(txt)) throw new Error('PDF text extraction failed')
      console.log('[smoke] PDF text extracted to', txt.split(/[\\/]/).pop())
    } else {
      console.log('[smoke] (skipped PDF extraction — sample not found)')
    }

    // To-do capture from notes: writeNote must sync "to-do:" lines into the
    // global list, completion must strike the source line through, and deleting
    // the line must drop the to-do. (This path was silently dead in packaged
    // builds until the lazy require() was replaced with a static import.)
    const todos = await import('./services/todos')
    const notePath = join(task.folderPath, 'notes.md')
    resources.writeNote(notePath, '# Notes\n\n- to-do: smoke capture item\n')
    const captured = todos.listTodos().find((t) => t.text === 'smoke capture item')
    if (!captured) throw new Error('to-do not captured from notes')
    if (captured.taskId !== task.id) throw new Error('captured to-do not linked to its task')
    todos.setTodoDone(captured.id, true)
    if (!/~~to-?do: smoke capture item~~/i.test(readFileSync(notePath, 'utf-8')))
      throw new Error('completed to-do not struck through in notes')
    resources.writeNote(notePath, '# Notes\n')
    if (todos.listTodos(true).some((t) => t.id === captured.id && !t.done))
      throw new Error('removed to-do line left an open to-do')
    console.log('[smoke] to-do capture: notes → list → strike-through → removal')

    tasks.deleteTask(task.id)
    if (tasks.getTask(task.id)) throw new Error('task not deleted')
    if (existsSync(task.folderPath)) throw new Error('folder not moved to trash')
    console.log('[smoke] delete: row cascaded, folder moved to .trash')

    // Private (no-AI) task lifecycle
    const priv = tasks.createTask({ title: 'Private Smoke', aiDisabled: true })
    if (!priv.folderPath.includes('private')) throw new Error('private task not in private root')
    if (existsSync(join(priv.folderPath, 'CLAUDE.md')))
      throw new Error('private task has an AI context file')
    const unlocked = tasks.setTaskPrivacy(priv.id, false)
    if (!unlocked || unlocked.aiDisabled || !unlocked.folderPath.includes('tasks'))
      throw new Error('privacy toggle off failed')
    if (!existsSync(join(unlocked.folderPath, 'CLAUDE.md')))
      throw new Error('CLAUDE.md not created after enabling AI')
    const relocked = tasks.setTaskPrivacy(priv.id, true)
    if (!relocked?.aiDisabled || !relocked.folderPath.includes('private'))
      throw new Error('privacy toggle on failed')
    if (existsSync(join(relocked.folderPath, 'CLAUDE.md')))
      throw new Error('CLAUDE.md not removed after making private')
    tasks.deleteTask(priv.id)
    console.log('[smoke] private tasks: folder isolation + context stripping both ways')

    // Scratchpad save-session round trip
    const scratch = tasks.getOrCreateScratch()
    resources.addUrlResource(scratch.id, 'HackTest', 'example.com')
    const { writeFileSync: wf } = await import('fs')
    wf(join(scratch.folderPath, 'notes.md'), '# Notes\n\nSCRATCH-NOTE-KEEP\n')
    const saved = tasks.saveScratchSession('Saved Session Smoke')
    const savedResources = resources.listResources(saved.id)
    if (savedResources.length !== 1 || savedResources[0].url !== 'https://example.com')
      throw new Error('scratch resources did not move to saved task')
    if (!readFileSync(join(saved.folderPath, 'notes.md'), 'utf-8').includes('SCRATCH-NOTE-KEEP'))
      throw new Error('scratch notes did not move')
    if (resources.listResources(scratch.id).length !== 0)
      throw new Error('scratch not reset after save')
    if (readFileSync(join(scratch.folderPath, 'notes.md'), 'utf-8').includes('SCRATCH-NOTE-KEEP'))
      throw new Error('scratch notes not reset')
    tasks.deleteTask(saved.id)
    console.log('[smoke] scratchpad save-session: resources + notes moved, scratch reset')

    console.log('[smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[smoke] FAIL:', err)
    app.exit(1)
  }
}
