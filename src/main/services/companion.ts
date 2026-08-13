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
// Tailscale detection (best-effort; the app never requires it to run).
// ---------------------------------------------------------------------------

interface TailscaleInfo {
  state: 'ok' | 'not-installed' | 'not-running'
  dnsName: string | null
}

export function tailscaleInfo(): Promise<TailscaleInfo> {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
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
      'tailscale',
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
    setSettings({ companionSubs: s.companionSubs.filter((x) => !dead.includes(x.endpoint)) })
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
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return {}
  if (raw.length > 64 * 1024) throw new Error('body too large')
  return JSON.parse(raw) as Record<string, unknown>
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!tokenOk(bearerOf(req))) return sendJson(res, 401, { error: 'unauthorized' })
  const method = req.method ?? 'GET'

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
    const scratch = getOrCreateScratch()
    const notePath = join(scratch.folderPath, 'notes.md')
    const existing = readNote(notePath)
    const stamp = new Date().toLocaleString()
    writeNote(notePath, `${existing.replace(/\n*$/, '\n\n')}${text}\n<!-- 📱 ${stamp} -->\n`)
    return sendJson(res, 200, { ok: true })
  }
  if (path === 'assistant' && method === 'POST') {
    const b = await readBody(req)
    const prompt = String(b.prompt ?? '').trim()
    if (!prompt) return sendJson(res, 400, { error: 'empty' })
    const reply = await phoneAssistant(prompt.slice(0, 2000))
    return sendJson(res, 200, { reply })
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
    wss!.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
    })
  })

  // 127.0.0.1 ONLY — reachability comes from `tailscale serve`, nothing else.
  server.listen(port, '127.0.0.1')
  server.on('error', (err) => {
    console.error('companion server error:', err)
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
    subscriptions: s.companionSubs.length
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
