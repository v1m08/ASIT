import { BrowserWindow, type WebContents } from 'electron'
import { paneManager } from './panes'

// WhatsApp Web sender: free, local, uses the user's own linked account.
//
// Two hard-won constraints shape this file:
//  1. WhatsApp allows ONE active tab per session. If the user has a WhatsApp
//     pane open, we must drive THAT — a hidden window on the same session
//     just gets the "open in another window" takeover screen.
//  2. WhatsApp redesigns its DOM. Element hunting is strategy-layered
//     (ids → aria → geometry) and every step verifies its outcome; on any
//     miss we abort with a specific reason, never a silent wrong-chat send.

const BROWSE_PARTITION = 'persist:asit-browse'
const WA_URL = 'https://web.whatsapp.com/'

export interface SendResult {
  ok: boolean
  detail: string
}

let waWindow: BrowserWindow | null = null
let idleTimer: NodeJS.Timeout | null = null
let sending = false

function getHiddenWindow(): BrowserWindow {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (waWindow && !waWindow.isDestroyed()) return waWindow
  waWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 850,
    webPreferences: { partition: BROWSE_PARTITION, sandbox: true, contextIsolation: true }
  })
  waWindow.loadURL(WA_URL).catch(() => undefined)
  return waWindow
}

// The slow part of a background send is WhatsApp Web's ~5-10s cold load. Called
// the moment the user starts a "> " command (before they finish typing the
// message), so by Enter the page is usually already logged-in and ready —
// making the background send feel as instant as driving an open pane. No-op if
// a WhatsApp pane is open (that path needs no hidden window) or one is warming.
export function prewarmWhatsApp(): void {
  if (sending) return
  if (paneManager.whatsappWebContents()) return // pane path — nothing to warm
  getHiddenWindow() // creates + starts loading; idle timer keeps it ~5min
  scheduleIdleClose()
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  // 5 min: a warm, logged-in window makes every send in a session instant;
  // the ~100MB is reclaimed once the user is clearly done messaging.
  idleTimer = setTimeout(() => {
    if (waWindow && !waWindow.isDestroyed()) waWindow.destroy()
    waWindow = null
  }, 300_000)
}

export function closeWhatsApp(): void {
  if (idleTimer) clearTimeout(idleTimer)
  if (waWindow && !waWindow.isDestroyed()) waWindow.destroy()
  waWindow = null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Recipient identity check: "Mom" matches "Mom ❤️", "Manav Sharma" matches
// "Manav". Emoji/punctuation are ignored so decorated contact names still pass.
function looselyMatches(chatTitle: string, requested: string): boolean {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9+ ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const a = norm(chatTitle)
  const b = norm(requested)
  if (!a || !b) return false
  if (a.includes(b) || b.includes(a)) return true
  // All requested words present (handles "sharma manav" vs "Manav Sharma").
  const words = b.split(' ').filter((w) => w.length > 1)
  return words.length > 0 && words.every((w) => a.includes(w))
}

async function exec<T>(wc: WebContents, script: string): Promise<T> {
  return (await wc.executeJavaScript(script, true)) as T
}

// Page state: 'ready' (chat UI), 'qr' (not linked), 'takeover' (session held
// by another tab), 'loading'. Selector-agnostic where possible.
const STATE_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : ''
  if (/use here/i.test(text) && /another window|other window|somewhere else/i.test(text)) return 'takeover'
  if (/update (google )?chrome|browser (isn.t|not) supported|use one of these browsers/i.test(text)) return 'blocked'
  if (document.querySelector('[data-ref] canvas') || (/scan|log in with phone|link with phone/i.test(text) && document.querySelector('canvas'))) return 'qr'
  // 'ready' needs POSITIVE logged-in evidence — the login page also has an
  // editor (its phone-number input), which once fooled an any-editor check.
  const chatList = document.querySelector('#pane-side, #side, [aria-label="Chat list"], [data-testid="chat-list"]')
    || document.querySelectorAll('[role="listitem"]').length >= 3
  if (chatList) return 'ready'
  if (/log in|steps to log/i.test(text)) return 'qr-loading' // login page, QR still rendering
  return 'loading'
})()`

// When we're stuck, say what the page actually WAS — "did not load" hid two
// completely different failures (browser-block wall vs session takeover).
const DIAG_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 140) : '(no body)'
  const editors = document.querySelectorAll('[contenteditable="true"], [role="textbox"]').length
  return 'page says: "' + text + '" (' + editors + ' editors, ' + document.querySelectorAll('canvas').length + ' canvas)'
})()`

// Click the "Use here" button when another tab holds the session. Explicit
// user command justifies claiming it; the other tab shows its own takeover
// screen afterward (standard WhatsApp behavior).
const TAKEOVER_SCRIPT = `(() => {
  const btns = [...document.querySelectorAll('button, [role="button"]')]
  const btn = btns.find(b => /use here/i.test(b.textContent || ''))
  if (!btn) return false
  btn.click()
  return true
})()`

// Find + focus the sidebar search box. Strategies, most-specific first:
// legacy #side contenteditable → aria/placeholder mentioning search → the
// top-most editable in the left third of the window (layout truth: WhatsApp
// has always had search at top-left of the chat list).
const FOCUS_SEARCH_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 40 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' }
  const editors = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"], input[type="text"], input:not([type])')].filter(visible)
  let el = document.querySelector('#side [contenteditable="true"]')
  if (!el || !visible(el)) {
    el = editors.find(e => /search/i.test((e.getAttribute('aria-label') || '') + (e.getAttribute('aria-placeholder') || '') + (e.getAttribute('placeholder') || '') + (e.getAttribute('title') || '')))
  }
  if (!el) {
    const third = window.innerWidth / 3
    el = editors
      .filter(e => e.getBoundingClientRect().left < third)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
  }
  if (!el) return false
  el.focus()
  document.execCommand('selectAll', false)
  document.execCommand('delete', false)
  return true
})()`

// Find + focus the message composer: bottom-most editable in the right
// two-thirds (the conversation column), aria fallbacks first.
const FOCUS_COMPOSER_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 40 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' }
  let el = document.querySelector('#main footer [contenteditable="true"]')
  if (!el || !visible(el)) {
    const editors = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')].filter(visible)
    el = editors.find(e => /type a message|message/i.test((e.getAttribute('aria-label') || '') + (e.getAttribute('aria-placeholder') || '') + (e.getAttribute('placeholder') || '')))
    if (!el) {
      const third = window.innerWidth / 3
      el = editors
        .filter(e => e.getBoundingClientRect().left > third)
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
    }
  }
  if (!el) return false
  el.focus()
  return true
})()`

// The sidebar search box's current text (confirms our insert landed).
const SEARCH_TEXT_SCRIPT = `(() => {
  const side = document.querySelector('#side') || document.querySelector('#pane-side')
  const box = side && side.querySelector('[contenteditable="true"], input[type="text"]')
  if (!box) return ''
  return (box.textContent || box.value || '').trim()
})()`

// Title of the FIRST search result — checked against the requested recipient
// before Enter, so a stale list can never route the message to someone else.
const TOP_RESULT_SCRIPT = `(() => {
  const side = document.querySelector('#pane-side') || document.querySelector('#side')
  if (!side) return ''
  const row = side.querySelector('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]')
  if (!row) return ''
  const t = row.querySelector('span[title]')
  return ((t && t.getAttribute('title')) || row.innerText || '').split('\\n')[0].slice(0, 80).trim()
})()`

const COMPOSER_TEXT_SCRIPT = `(() => {
  const el = document.activeElement
  return el && (el.isContentEditable || el.getAttribute('role') === 'textbox') ? (el.textContent || '') : ''
})()`

// The open chat's title: conversation header, several generations of markup.
const CHAT_TITLE_SCRIPT = `(() => {
  const header = document.querySelector('#main header') || document.querySelector('[data-testid="conversation-header"]')
  if (header) {
    const t = header.querySelector('span[title]')
    if (t) return t.getAttribute('title')
    const s = header.querySelector('span[dir="auto"]')
    if (s) return (s.textContent || '').slice(0, 60)
    return (header.textContent || '').slice(0, 60) || null
  }
  return null
})()`

// Poll a condition instead of sleeping a fixed worst case — sends finish as
// fast as the page actually reacts (usually 3-4× sooner).
async function pollUntil<T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  stepMs = 90
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await probe().catch(() => null as T)
    if (v !== null && ok(v)) return v
    if (Date.now() > deadline) return v
    await sleep(stepMs)
  }
}

/**
 * Insert text instantly (one editing command, not N keystrokes) and CONFIRM it
 * landed; per-character typing is the fallback for editors that only react to
 * real key events. This is most of the send latency: a 60-char message went
 * from ~200ms of keystrokes to a single call.
 */
async function typeText(
  wc: WebContents,
  text: string,
  verify: () => Promise<boolean>
): Promise<boolean> {
  wc.insertText(text)
  if ((await pollUntil(verify, (v) => v === true, 700, 80)) === true) return true
  for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch })
  return (await pollUntil(verify, (v) => v === true, 1500, 100)) === true
}

function pressEnter(wc: WebContents): void {
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
}

export async function sendWhatsApp(recipient: string, message: string): Promise<SendResult> {
  const to = recipient.trim()
  const text = message.trim().replace(/\s*\n\s*/g, ' ')
  if (!to || !text) return { ok: false, detail: 'need both a recipient and a message' }
  if (sending) return { ok: false, detail: 'another WhatsApp send is in progress — try again in a few seconds' }
  sending = true
  const result = await Promise.race([
    sendInner(to, text),
    new Promise<SendResult>((r) =>
      setTimeout(() => r({ ok: false, detail: 'send timed out after 75s — check WhatsApp before retrying.' }), 75_000)
    )
  ])
  sending = false
  // Only the hidden window gets idle-closed; a user's pane is theirs.
  if (waWindow) scheduleIdleClose()
  return result
}

async function sendInner(to: string, text: string): Promise<SendResult> {
  try {
    // Prefer the user's own open WhatsApp pane — it ALREADY holds the
    // session; a hidden window would just hit the takeover screen.
    let wc = paneManager.whatsappWebContents()
    const usingPane = wc !== null
    if (!wc) wc = getHiddenWindow().webContents

    let state = 'loading'
    // Tighter poll: a prewarmed window is usually ready on the first check;
    // a cold one still resolves within the same overall budget (~30s).
    for (let i = 0; i < 120; i++) {
      if (wc.isDestroyed()) return { ok: false, detail: 'WhatsApp window closed mid-send' }
      state = await exec<string>(wc, STATE_SCRIPT).catch(() => 'loading')
      if (state === 'ready') break
      if (state === 'qr' || state === 'qr-loading')
        return {
          ok: false,
          detail:
            'WhatsApp is not linked on this PC yet — open ⚙ Settings → 🔑 Connected accounts → WhatsApp and scan the QR with your phone (one time).'
        }
      if (state === 'blocked')
        return {
          ok: false,
          detail:
            'WhatsApp is refusing this browser version. Restart ASIT (a fix ships with updates) and if it persists, tell me the exact message WhatsApp shows.'
        }
      if (state === 'takeover') {
        // Claim the session for this window (explicit user command).
        await exec<boolean>(wc, TAKEOVER_SCRIPT).catch(() => false)
        await sleep(700)
        continue
      }
      await sleep(150)
    }
    if (state !== 'ready') {
      const diag = await exec<string>(wc, DIAG_SCRIPT).catch(() => 'page unreadable')
      return {
        ok: false,
        detail: `WhatsApp Web did not become ready (stuck at "${state}"). ${diag}`
      }
    }

    if (!(await exec<boolean>(wc, FOCUS_SEARCH_SCRIPT)))
      return { ok: false, detail: 'could not find the WhatsApp search box — the site layout may have changed; nothing sent.' }
    wc.focus()
    const needle = to.slice(0, 60)
    const typedSearch = await typeText(wc, needle, async () =>
      (await exec<string>(wc, SEARCH_TEXT_SCRIPT).catch(() => '')).length > 0
    )
    if (!typedSearch)
      return { ok: false, detail: 'could not type into the WhatsApp search box — nothing sent.' }

    // Wait for the RESULT to actually match the recipient before pressing
    // Enter. The old fixed debounce could hit Enter while the previous chat
    // was still first in the list — i.e. message the wrong person.
    const topResult = await pollUntil(
      () => exec<string>(wc, TOP_RESULT_SCRIPT),
      (t) => !!t && looselyMatches(t, needle),
      3000
    )
    if (!topResult || !looselyMatches(topResult, needle))
      return {
        ok: false,
        detail: `no WhatsApp chat matched "${to}"${topResult ? ` (closest: "${topResult}")` : ''} — nothing was sent.`
      }
    pressEnter(wc)

    // Chat opened? Poll for a conversation header instead of a fixed wait.
    const opened = await pollUntil(
      () => exec<string | null>(wc, CHAT_TITLE_SCRIPT),
      (t) => !!t,
      2500
    )
    if (!opened)
      return {
        ok: false,
        detail: `no WhatsApp chat matched "${to}" — nothing was sent. Check the name as it appears in WhatsApp.`
      }
    // Final identity check before anything is typed into a conversation.
    if (!looselyMatches(opened, needle))
      return {
        ok: false,
        detail: `refused: the open chat is "${opened}", which doesn't match "${to}" — nothing sent.`
      }

    if (!(await exec<boolean>(wc, FOCUS_COMPOSER_SCRIPT)))
      return { ok: false, detail: `chat "${opened}" opened but the message box was not found — nothing sent.` }
    const body = text.slice(0, 1500)
    const typedBody = await typeText(wc, body, async () =>
      (await exec<string>(wc, COMPOSER_TEXT_SCRIPT).catch(() => '')).includes(body.slice(0, 40))
    )
    if (!typedBody)
      return { ok: false, detail: `typing into the "${opened}" composer failed — nothing sent.` }
    pressEnter(wc)

    // Emptied composer == WhatsApp accepted the Enter and sent.
    const emptiedProbe = `(() => {
      const editors = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
      return !editors.some(el => (el.textContent || '').includes(${JSON.stringify(text.slice(0, 40))}))
    })()`
    const emptied = await pollUntil(() => exec<boolean>(wc, emptiedProbe), (v) => v === true, 2500)
    if (!emptied)
      return { ok: false, detail: `send to "${opened}" could not be confirmed — check WhatsApp before retrying.` }
    return { ok: true, detail: `sent to ${opened}${usingPane ? '' : ' (background)'}` }
  } catch (err) {
    return { ok: false, detail: `WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function parseSendCommand(input: string): { recipient: string; message: string } | null {
  const m = input.match(/^>\s*(?:wa|whatsapp)?\s*([^:]{1,60}):\s*(.+)$/is)
  if (!m) return null
  return { recipient: m[1].trim(), message: m[2].trim() }
}
