import { app, BrowserWindow, globalShortcut, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'
import { getDb, closeDb } from './db'
import { registerIpc } from './ipc'
import { paneManager } from './services/panes'
import { lockdown } from './services/lockdown'
import { timer } from './services/timer'
import { initQuestions } from './services/questions'
import { initActions, watchJarvisActions } from './services/actions'
import { initUsage } from './services/usage'
import { initActivity } from './services/activity'
import { initWatchers } from './services/watchers'
import { initTodos } from './services/todos'
import { startCompanion, stopCompanion } from './services/companion'
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

  // External links from the app UI open in the default browser.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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
    app.setPath('documents', joinPath(tmpdir(), 'asit-smoke-docs'))
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

  registerIpc(() => mainWindow)
  timer.init(() => mainWindow)
  initQuestions(() => mainWindow)
  initActions(() => mainWindow)
  initUsage(() => mainWindow)
  initActivity(() => mainWindow)
  initWatchers(() => mainWindow)
  initTodos(() => mainWindow)
  // Jarvis's action file is watched for the app's whole lifetime — the
  // universal agent can act regardless of which screen is open.
  try {
    watchJarvisActions(getOrCreateJarvis().id)
  } catch (err) {
    console.error('jarvis init failed:', err)
  }
  if (getSettings().companionEnabled) startCompanion(() => mainWindow)
  relocateLegacyTrash() // old .trash lived inside the assistant-readable tree
  writeTasksIndex() // keep the global-assistant index fresh from startup
  refreshAllTaskContexts() // guidance updates reach existing tasks immediately
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  // Reap CLI children first — otherwise a running generation job would keep
  // spending tokens after the app closes (Windows children outlive parents).
  const { killAllClaudeChildren } = await import('./services/claude')
  killAllClaudeChildren()
  globalShortcut.unregisterAll() // navigation keys grabbed while a page had focus
  stopCompanion()
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

    tasks.deleteTask(task.id)
    const imported = transfer.importFromZip(zipPath)
    console.log(`[transfer-smoke] imported ${imported.tasks} tasks, ${imported.questions} questions`)

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
    const sync = (await (
      await api('sync', {
        method: 'POST',
        body: JSON.stringify({
          ops: [
            { t: 'todoadd', text: 'offline-queued todo' },
            { t: 'capture', text: 'offline capture\nto-do: from the bus' },
            { t: 'bogus', x: 1 }
          ]
        })
      })
    ).json()) as { applied: number }
    if (sync.applied !== 2) fail(`sync applied ${sync.applied}, expected 2`)
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

    companionSvc.stopCompanion()
    console.log('[companion-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[companion-smoke] FAIL:', err)
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
      const which = req.url === '/b' ? 'Beta' : 'Alpha'
      res.setHeader('content-type', 'text/html')
      res.end(`<title>${which}</title><button aria-label="${which} Button">${which} Button</button>`)
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })

    const win = new BrowserWindow({ show: false, width: 800, height: 600 })
    paneManager.attach(win)
    paneManager.open('pane-a', { url: `http://127.0.0.1:${port}/a` }, 'task-a')
    paneManager.open('pane-b', { url: `http://127.0.0.1:${port}/b` }, 'task-b')

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
    const keyOwnerless = paneManager.keyToPage('task-c', undefined, 'Ctrl+P')
    if (!keyOwnerless.startsWith('no browser pane open'))
      fail(`ownerless key was sent somewhere: "${keyOwnerless}"`)
    const keyOwned = paneManager.keyToPage('task-b', undefined, 'Escape')
    if (!keyOwned.startsWith('sent')) fail(`owner key refused: "${keyOwned}"`)
    console.log('[panes-smoke] keys go to the owner’s panes or nowhere')

    server.close()
    console.log('[panes-smoke] ALL PASS')
    app.exit(0)
  } catch (err) {
    console.error('[panes-smoke] FAIL:', err)
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

    const listed = tasks.listTasks()
    if (!listed.some((t) => t.id === task.id)) throw new Error('task not listed')

    const s = settings.getSettings()
    console.log('[smoke] settings defaults ok, claudePath =', s.claudePath)

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
