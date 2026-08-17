import type { BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { execFile } from 'child_process'
import { randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import webPush from 'web-push'
import QRCode from 'qrcode'
import type { CompanionStatus } from '@shared/types'
import { IPC } from '@shared/ipc-contract'
import { bus } from './bus'
import { getSettings, setSettings } from './settings'
import { listTodos, addTodo, setTodoDone, deleteTodo } from './todos'
import { dueQuestions, answerQuestion } from './questions'
import { listActivity } from './activity'
import { getOrCreateScratch, tasksRoot, writeTasksIndex } from './tasks'
import { readNote, writeNote } from './resources'
import { runClaudeStream } from './claude'
import { quickFetch } from './quickfetch'
import { logUsage } from './usage'
import {
  cancelJarvis,
  jarvisBusy,
  jarvisLive,
  queuedPrompts,
  startJarvisTurn
} from './jarvis'
import { assistantHistory } from './assistant'
import { parseSendCommand, sendWhatsApp } from './whatsapp'

// Phone companion: a small HTTP+WebSocket server for the PWA on the user's
// phone. SECURITY MODEL — three layers, all required:
//   1. Binds 127.0.0.1 ONLY. The phone reaches it exclusively through
//      `tailscale serve`, i.e. over the user's private WireGuard tailnet with
//      a real HTTPS cert. The server is never exposed to the LAN or internet.
//   2. Every /api and /ws request carries the pairing token (random 32 bytes,
//      shown once as a QR in Settings), compared constant-time.
//   3. Push notification payloads are E2E-encrypted by the Web Push protocol
//      itself (RFC 8291) — Apple/Google relays only ever see ciphertext.

let server: Server | null = null
let wss: WebSocketServer | null = null
let getWindow: (() => BrowserWindow | null) | null = null
const sockets = new Set<WebSocket>()

function staticDir(): string {
  // out/main/ → ../../resources/companion. Holds in dev, `electron out/main/
  // index.js` smoke runs, and inside the packaged app.asar alike —
  // app.getAppPath() does NOT (it follows the entry script's directory).
  return join(__dirname, '..', '..', 'resources', 'companion')
}

// ---------------------------------------------------------------------------
// Config: token + VAPID keys are generated once, on first enable.
// ---------------------------------------------------------------------------

export function ensureCompanionConfig(): { token: string; vapidPublic: string } {
  const s = getSettings()
  let { companionToken, vapidPublicKey, vapidPrivateKey } = s
  const patch: Record<string, string> = {}
  if (!companionToken) {
    companionToken = randomBytes(32).toString('base64url')
    patch.companionToken = companionToken
  }
  if (!vapidPublicKey || !vapidPrivateKey) {
    const keys = webPush.generateVAPIDKeys()
    vapidPublicKey = keys.publicKey
    vapidPrivateKey = keys.privateKey
    patch.vapidPublicKey = vapidPublicKey
    patch.vapidPrivateKey = vapidPrivateKey
  }
  if (Object.keys(patch).length > 0) setSettings(patch)
  return { token: companionToken, vapidPublic: vapidPublicKey }
}

function tokenOk(provided: string | undefined): boolean {
  const expected = getSettings().companionToken
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerOf(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined
}

// ---------------------------------------------------------------------------
// Pairing-code flow. iOS home-screen web apps get a storage container that is
// SEPARATE from Safari's, so a token delivered via the QR's URL fragment never
// reaches the installed app. Instead: the unpaired app requests a short code,
// the user approves that code on the PC, and only then does the server hand
// the token to that exact request. The two unauthenticated endpoints leak
// nothing: /pair/start returns a random code, /pair/poll requires the
// unguessable requestId and returns the token only after desktop approval.
// ---------------------------------------------------------------------------

interface PendingPair {
  requestId: string
  code: string
  createdAt: number
  approved: boolean
}

const pendingPairs = new Map<string, PendingPair>()
const PAIR_TTL_MS = 5 * 60_000
const MAX_PENDING = 3

function prunePairs(): void {
  const now = Date.now()
  for (const [id, p] of pendingPairs) {
    if (now - p.createdAt > PAIR_TTL_MS) pendingPairs.delete(id)
  }
}

// pair/start is necessarily unauthenticated — rate-limit it so a hostile
// local process or drive-by web page can't spam approval toasts or exhaust
// the pending slots (it can never obtain the token either way).
let pairStarts: number[] = []
let lastPairToast = 0

function startPair(): { requestId: string; code: string } | null {
  const now = Date.now()
  pairStarts = pairStarts.filter((t) => now - t < 60_000)
  if (pairStarts.length >= 5) return null
  pairStarts.push(now)
  prunePairs()
  if (pendingPairs.size >= MAX_PENDING) return null
  const requestId = randomBytes(16).toString('base64url')
  const code = String(Math.floor(100000 + Math.random() * 900000)) // 6 digits
  pendingPairs.set(requestId, { requestId, code, createdAt: Date.now(), approved: false })
  // Surface it in the app immediately — the user is standing at their phone.
  // (One toast per 30s: repeated requests still show in Settings.)
  const win = getWindow?.()
  if (win && !win.isDestroyed() && Date.now() - lastPairToast > 30_000) {
    lastPairToast = Date.now()
    win.webContents.send(IPC.APP_EVENT, {
      type: 'toast',
      text: `📱 Phone asking to pair — code ${code}. Approve in Settings → Phone.`
    })
  }
  return { requestId, code }
}

export function pendingPairRequest(): { requestId: string; code: string } | null {
  prunePairs()
  const first = [...pendingPairs.values()].find((p) => !p.approved)
  return first ? { requestId: first.requestId, code: first.code } : null
}

export function approvePair(requestId: string): boolean {
  prunePairs()
  const p = pendingPairs.get(requestId)
  if (!p) return false
  p.approved = true
  return true
}

export function denyPair(requestId: string): void {
  pendingPairs.delete(requestId)
}

// ---------------------------------------------------------------------------
// Tailscale detection (best-effort; the app never requires it to run).
// ---------------------------------------------------------------------------

interface TailscaleInfo {
  state: 'ok' | 'not-installed' | 'not-running'
  dnsName: string | null
}

// The Windows installer puts tailscale.exe here but PATH only updates for
// NEW processes/logins — an already-running ASIT would see ENOENT and wrongly
// report "not installed". Probe the standard locations directly.
function tailscaleBin(): string {
  const candidates = [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'tailscale' // fall back to PATH (correct on fresh shells / other setups)
}

export function tailscaleInfo(): Promise<TailscaleInfo> {
  return new Promise((resolve) => {
    execFile(tailscaleBin(), ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code
        resolve({ state: code === 'ENOENT' ? 'not-installed' : 'not-running', dnsName: null })
        return
      }
      try {
        const j = JSON.parse(stdout) as {
          BackendState?: string
          Self?: { DNSName?: string }
        }
        if (j.BackendState !== 'Running') return resolve({ state: 'not-running', dnsName: null })
        const dns = (j.Self?.DNSName ?? '').replace(/\.$/, '')
        resolve({ state: 'ok', dnsName: dns || null })
      } catch {
        resolve({ state: 'not-running', dnsName: null })
      }
    })
  })
}

export function tailscaleServe(port: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      tailscaleBin(),
      ['serve', '--bg', String(port)],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) resolve(`tailscale serve failed: ${stderr || err.message}`)
        else resolve(stdout.trim() || 'Serving over your tailnet.')
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

function configurePush(): boolean {
  const s = getSettings()
  if (!s.vapidPublicKey || !s.vapidPrivateKey) return false
  webPush.setVapidDetails('mailto:asit@localhost.invalid', s.vapidPublicKey, s.vapidPrivateKey)
  return true
}

export async function notifyPhone(title: string, body: string, tag?: string): Promise<void> {
  const s = getSettings()
  if (s.companionSubs.length === 0 || !configurePush()) return
  const payload = JSON.stringify({ title, body, tag })
  const dead: string[] = []
  await Promise.all(
    s.companionSubs.map(async (sub) => {
      try {
        await webPush.sendNotification(sub, payload, { TTL: 3600 })
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) dead.push(sub.endpoint) // unsubscribed
      }
    })
  )
  if (dead.length > 0) {
    // Re-read before pruning: a subscription added mid-send must survive.
    const fresh = getSettings().companionSubs
    setSettings({ companionSubs: fresh.filter((x) => !dead.includes(x.endpoint)) })
  }
}

// ---------------------------------------------------------------------------
// Phone assistant: same read-only global assistant as the ⚡ bar (haiku,
// cwd = tasks root — private workspaces are physically outside it), plus the
// agentless "?" quick-fetch path. One at a time; fresh short sessions.
// ---------------------------------------------------------------------------

let phoneSessionId: string | undefined
let phoneBusy = false

async function phoneAssistant(prompt: string): Promise<string> {
  const q = prompt.trim()
  if (q.startsWith('>')) {
    const cmd = parseSendCommand(q)
    if (!cmd) return 'Format: > name: message (sends on WhatsApp from your linked account)'
    const res = await sendWhatsApp(cmd.recipient, cmd.message)
    return res.ok ? `✅ ${res.detail}` : `⚠️ ${res.detail}`
  }
  if (q.startsWith('?')) {
    const res = await quickFetch(q.slice(1).trim())
    if (res.otp) return `🔑 ${res.otp} (${res.source})`
    if (res.error) return `Nothing found: ${res.error}`
    if (res.lines.length > 0) return res.lines.map((l) => `• ${l}`).join('\n')
    return `No matches in ${res.source || 'your sources'}.`
  }
  if (phoneBusy) return 'Still working on your previous question — try again in a moment.'
  phoneBusy = true
  writeTasksIndex()
  try {
    return await new Promise<string>((resolve) => {
      runClaudeStream(
        {
          cwd: tasksRoot(),
          prompt: q,
          resumeSessionId: phoneSessionId,
          model: 'haiku',
          allowedTools: 'Read(**),Glob,Grep(**)'
        },
        {
          onInit: (id) => {
            phoneSessionId = id
          },
          onDelta: () => undefined,
          onToolUse: () => undefined,
          onResult: ({ text, isError, usage }) => {
            logUsage(null, 'assistant', usage)
            resolve(isError ? `Assistant error: ${text || 'unknown'}` : text)
          },
          onError: (message) => resolve(`Assistant error: ${message}`)
        }
      )
    })
  } finally {
    phoneBusy = false
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const appliedOpIds = new Set<string>()

function captureToScratch(text: string): void {
  const scratch = getOrCreateScratch()
  const notePath = join(scratch.folderPath, 'notes.md')
  const existing = readNote(notePath)
  const stamp = new Date().toLocaleString()
  writeNote(notePath, `${existing.replace(/\n*$/, '\n\n')}${text.trim()}\n<!-- 📱 ${stamp} -->\n`)
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(data)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Enforce the cap WHILE streaming — buffering first would let a client OOM
  // the main process before the check ever ran.
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > 64 * 1024) {
      req.destroy()
      throw new Error('body too large')
    }
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET'

  // The only two unauthenticated endpoints — see the pairing-flow note above.
  if (path === 'pair/start' && method === 'POST') {
    const started = startPair()
    if (!started) return sendJson(res, 429, { error: 'too many pairing attempts — wait a minute' })
    return sendJson(res, 200, started)
  }
  if (path.startsWith('pair/poll') && method === 'GET') {
    const rid = new URL(req.url ?? '', 'http://x').searchParams.get('rid') ?? ''
    prunePairs()
    const p = pendingPairs.get(rid)
    if (!p) return sendJson(res, 404, { error: 'expired' })
    if (!p.approved) return sendJson(res, 200, { pending: true })
    pendingPairs.delete(rid) // one-shot delivery
    return sendJson(res, 200, { token: ensureCompanionConfig().token })
  }

  if (!tokenOk(bearerOf(req))) return sendJson(res, 401, { error: 'unauthorized' })

  if (path === 'state' && method === 'GET') {
    return sendJson(res, 200, {
      todos: listTodos(false),
      dueCount: dueQuestions(200).length,
      activity: listActivity()
    })
  }
  if (path === 'todos' && method === 'POST') {
    const b = await readBody(req)
    const todo = addTodo({
      text: String(b.text ?? ''),
      dueDate: typeof b.dueDate === 'string' ? b.dueDate : null
    })
    return sendJson(res, todo ? 200 : 400, { todo })
  }
  const todoDone = path.match(/^todos\/([\w-]+)\/done$/)
  if (todoDone && method === 'POST') {
    const b = await readBody(req)
    setTodoDone(todoDone[1], b.done !== false)
    return sendJson(res, 200, { ok: true })
  }
  const todoDel = path.match(/^todos\/([\w-]+)$/)
  if (todoDel && method === 'DELETE') {
    deleteTodo(todoDel[1])
    return sendJson(res, 200, { ok: true })
  }
  if (path === 'review' && method === 'GET') {
    return sendJson(res, 200, { due: dueQuestions(50) })
  }
  const grade = path.match(/^review\/([\w-]+)$/)
  if (grade && method === 'POST') {
    const b = await readBody(req)
    const g = Number(b.grade)
    if (![0, 1, 2, 3].includes(g)) return sendJson(res, 400, { error: 'bad grade' })
    const result = await answerQuestion(grade[1], { selfGrade: g as 0 | 1 | 2 | 3 })
    return sendJson(res, 200, { result })
  }
  if (path === 'capture' && method === 'POST') {
    const b = await readBody(req)
    const text = String(b.text ?? '').trim()
    if (!text) return sendJson(res, 400, { error: 'empty' })
    captureToScratch(text)
    return sendJson(res, 200, { ok: true })
  }
  // Offline catch-up: the phone queues review grades, to-do changes, and
  // captures while the PC is unreachable, then replays them here in order.
  // Ops carry client ids and are deduped: a retry after a lost response (or
  // two racing flushes) must never double-apply an SM-2 grade.
  if (path === 'sync' && method === 'POST') {
    const b = await readBody(req)
    const ops = Array.isArray(b.ops) ? (b.ops as Record<string, unknown>[]) : []
    let applied = 0
    for (const op of ops.slice(0, 300)) {
      const opId = typeof op.opId === 'string' ? op.opId.slice(0, 64) : null
      if (opId && appliedOpIds.has(opId)) continue
      // Mark applied only AFTER success — a transient failure must stay
      // retryable, not get dedup-blocked into silent loss.
      let ok = false
      try {
        if (op.t === 'review' && [0, 1, 2, 3].includes(Number(op.grade))) {
          await answerQuestion(String(op.id), { selfGrade: Number(op.grade) as 0 | 1 | 2 | 3 })
          ok = true
        } else if (op.t === 'tododone') {
          setTodoDone(String(op.id), op.done !== false)
          ok = true
        } else if (op.t === 'todoadd' && String(op.text ?? '').trim()) {
          ok = !!addTodo({ text: String(op.text), dueDate: null })
        } else if (op.t === 'capture' && String(op.text ?? '').trim()) {
          captureToScratch(String(op.text))
          ok = true
        }
      } catch {
        // an op referencing since-deleted data — skip, keep replaying the rest
      }
      if (ok) {
        applied++
        if (opId) {
          appliedOpIds.add(opId)
          if (appliedOpIds.size > 2000) {
            for (const id of appliedOpIds) {
              appliedOpIds.delete(id)
              if (appliedOpIds.size <= 1000) break
            }
          }
        }
      }
    }
    return sendJson(res, 200, { applied })
  }
  if (path === 'assistant' && method === 'POST') {
    const b = await readBody(req)
    const prompt = String(b.prompt ?? '').trim()
    if (!prompt) return sendJson(res, 400, { error: 'empty' })
    if (b.mode === 'jarvis') {
      // Fire and forget: a Jarvis turn can now run far longer than any phone
      // or proxy will hold a request open, so the phone watches /api/jarvis
      // instead of blocking on the reply.
      const started = startJarvisTurn(prompt.slice(0, 2000))
      return sendJson(res, started.started ? 200 : 409, started)
    }
    const reply = await phoneAssistant(prompt.slice(0, 2000))
    return sendJson(res, 200, { reply })
  }

  // The agent conversation: what it's doing right now plus past exchanges,
  // shared with the desktop panel (same log, same rolling session).
  if (path === 'jarvis' && method === 'GET') {
    return sendJson(res, 200, {
      live: jarvisLive(),
      busy: jarvisBusy(),
      queued: queuedPrompts(),
      history: assistantHistory(25)
    })
  }
  if (path === 'jarvis/cancel' && method === 'POST') {
    cancelJarvis()
    return sendJson(res, 200, { ok: true })
  }
  if (path === 'push/key' && method === 'GET') {
    return sendJson(res, 200, { key: ensureCompanionConfig().vapidPublic })
  }
  if (path === 'push/subscribe' && method === 'POST') {
    const b = await readBody(req)
    const endpoint = String(b.endpoint ?? '')
    const keys = b.keys as { p256dh?: string; auth?: string } | undefined
    if (!/^https:\/\//.test(endpoint) || !keys?.p256dh || !keys?.auth)
      return sendJson(res, 400, { error: 'bad subscription' })
    const s = getSettings()
    const subs = s.companionSubs.filter((x) => x.endpoint !== endpoint)
    subs.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } })
    setSettings({ companionSubs: subs.slice(-8) }) // a handful of devices, not a herd
    return sendJson(res, 200, { ok: true })
  }
  sendJson(res, 404, { error: 'not found' })
}

function handleStatic(res: ServerResponse, path: string): void {
  const name = path === '/' ? 'index.html' : path.slice(1)
  // Whitelist, not readFile-what-you're-told: this server faces the tailnet.
  const allowed = ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png']
  if (!allowed.includes(name)) {
    res.writeHead(404)
    res.end()
    return
  }
  const file = join(staticDir(), name)
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end()
    return
  }
  const ext = name.slice(name.lastIndexOf('.'))
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': name.endsWith('.png') ? 'public, max-age=86400' : 'no-cache'
  })
  res.end(readFileSync(file))
}

export function startCompanion(getWin: () => BrowserWindow | null): void {
  if (server) return
  getWindow = getWin
  ensureCompanionConfig()
  const port = getSettings().companionPort

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (path.startsWith('/api/')) {
      handleApi(req, res, path.slice(5)).catch((err) =>
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      )
      return
    }
    handleStatic(res, path)
  })

  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token') ?? undefined)) {
      socket.destroy()
      return
    }
    if (sockets.size >= 10) {
      socket.destroy()
      return
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      ws.on('error', () => sockets.delete(ws)) // errored sockets never emit a clean close
    })
  })

  // 127.0.0.1 ONLY — reachability comes from `tailscale serve`, nothing else.
  server.listen(port, '127.0.0.1')
  server.on('error', (err) => {
    console.error('companion server error:', err)
    wss?.close()
    wss = null
    server = null
  })
}

export function stopCompanion(): void {
  for (const ws of sockets) ws.close()
  sockets.clear()
  wss?.close()
  wss = null
  server?.close()
  server = null
}

export function companionRunning(): boolean {
  return server !== null
}

// Actual bound port (differs from settings when the smoke test binds port 0).
export function companionAddress(): number | null {
  const addr = server?.address()
  return addr && typeof addr === 'object' ? addr.port : null
}

export async function companionStatus(): Promise<CompanionStatus> {
  const s = getSettings()
  const ts = await tailscaleInfo()
  return {
    enabled: s.companionEnabled,
    running: server !== null,
    port: s.companionPort,
    url: ts.dnsName ? `https://${ts.dnsName}` : null,
    tailscale: ts.state,
    subscriptions: s.companionSubs.length,
    pendingPair: pendingPairRequest()
  }
}

export async function companionQr(): Promise<{ url: string | null; dataUrl: string | null }> {
  const { token } = ensureCompanionConfig()
  const ts = await tailscaleInfo()
  if (!ts.dnsName) return { url: null, dataUrl: null }
  // Token rides in the fragment: never sent in requests or server logs.
  const url = `https://${ts.dnsName}/#${token}`
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 })
  return { url, dataUrl }
}

export function revokeCompanionPairing(): void {
  setSettings({ companionToken: randomBytes(32).toString('base64url'), companionSubs: [] })
  for (const ws of sockets) ws.close()
  sockets.clear()
}

// ---------------------------------------------------------------------------
// Live events from the rest of the app
// ---------------------------------------------------------------------------

bus.on('changed', (what: string) => {
  const msg = JSON.stringify({ type: 'changed', what })
  for (const ws of sockets) {
    try {
      ws.send(msg)
    } catch {
      // socket on its way out
    }
  }
})

bus.on('notify', (n: { title: string; body: string; tag?: string }) => {
  void notifyPhone(n.title, n.body, n.tag)
})

// A chat turn finished — worth a ping only if the user isn't at the PC.
bus.on('chat-done', (p: { title: string }) => {
  const win = getWindow?.()
  if (win && !win.isDestroyed() && win.isFocused()) return
  void notifyPhone('ASIT', `💬 ${p.title}: reply ready`, 'chat-done')
})
