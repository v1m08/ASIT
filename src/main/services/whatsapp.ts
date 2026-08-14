import { BrowserWindow } from 'electron'

// WhatsApp Web sender: free, local, uses the user's own linked account.
// The user links WhatsApp Web ONCE (QR scan, persists in the shared browser
// profile); after that a hidden window can open a chat by name and deliver a
// message in a few seconds — no API, no third party, nothing transits anyone
// else's servers.
//
// This path is DETERMINISTIC (no model in the loop): it runs only from an
// explicit user command ("> name: message" in the assistant) or the Jarvis
// send_whatsapp action, and every send reports back who it actually went to.

const BROWSE_PARTITION = 'persist:asit-browse'
const WA_URL = 'https://web.whatsapp.com/'

export interface SendResult {
  ok: boolean
  detail: string // "sent to Manav Sharma" | error with guidance
}

let waWindow: BrowserWindow | null = null
let idleTimer: NodeJS.Timeout | null = null
let sending = false

function getWaWindow(): BrowserWindow {
  if (waWindow && !waWindow.isDestroyed()) return waWindow
  waWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 850,
    webPreferences: { partition: BROWSE_PARTITION, sandbox: true, contextIsolation: true }
  })
  waWindow.loadURL(WA_URL)
  return waWindow
}

// WhatsApp Web reloads take ~5-10s — keep the window warm briefly so a burst
// of sends is fast, then free the memory.
function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (waWindow && !waWindow.isDestroyed()) waWindow.destroy()
    waWindow = null
  }, 90_000)
}

export function closeWhatsApp(): void {
  if (idleTimer) clearTimeout(idleTimer)
  if (waWindow && !waWindow.isDestroyed()) waWindow.destroy()
  waWindow = null
}

async function exec<T>(win: BrowserWindow, script: string): Promise<T> {
  return (await win.webContents.executeJavaScript(script, true)) as T
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Selector notes: WhatsApp Web renders both the sidebar search and the message
// composer as contenteditable[data-tab] with aria-labels/placeholder that vary
// by locale + build. We match structurally (position in #side vs footer) and
// verify outcomes after every step instead of trusting any single selector.
const FIND_SEARCH = `(() => {
  const side = document.querySelector('#side')
  const box = side && side.querySelector('[contenteditable="true"]')
  if (!box) return false
  box.focus()
  document.execCommand('selectAll', false)
  document.execCommand('delete', false)
  return true
})()`

const FIND_COMPOSER = `(() => {
  const footer = document.querySelector('#main footer')
  const box = footer && footer.querySelector('[contenteditable="true"]')
  if (!box) return false
  box.focus()
  return true
})()`

export async function sendWhatsApp(recipient: string, message: string): Promise<SendResult> {
  const to = recipient.trim()
  const text = message.trim().replace(/\s*\n\s*/g, ' ') // composer Enter sends; keep one line
  if (!to || !text) return { ok: false, detail: 'need both a recipient and a message' }
  if (sending) return { ok: false, detail: 'another WhatsApp send is in progress — try again in a few seconds' }
  sending = true
  try {
    const win = getWaWindow()

    // Wait for the app to be ready: chat list (linked) or QR (not linked).
    let state = 'loading'
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      if (win.isDestroyed()) return { ok: false, detail: 'window closed mid-send' }
      state = await exec<string>(
        win,
        `(() => {
          if (document.querySelector('#side [contenteditable="true"]')) return 'ready'
          if (document.querySelector('[data-ref] canvas, canvas[aria-label]')) return 'qr'
          return 'loading'
        })()`
      ).catch(() => 'loading')
      if (state !== 'loading') break
    }
    if (state === 'qr')
      return {
        ok: false,
        detail:
          'WhatsApp is not linked on this PC yet — open ⚙ Settings → 🔑 Connected accounts → WhatsApp and scan the QR with your phone (one time).'
      }
    if (state !== 'ready')
      return { ok: false, detail: 'WhatsApp Web did not load — check your internet and try again.' }

    // Search the contact and open the top result.
    if (!(await exec<boolean>(win, FIND_SEARCH)))
      return { ok: false, detail: 'could not find the WhatsApp search box (site update?) — send skipped.' }
    for (const ch of to.slice(0, 60)) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(15)
    }
    await sleep(1600) // results populate
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(1200)

    // Verify a chat actually opened, and learn WHO it is.
    const opened = await exec<string | null>(
      win,
      `(() => {
        const header = document.querySelector('#main header')
        if (!header) return null
        const title = header.querySelector('span[title]')
        return title ? title.getAttribute('title') : (header.textContent || '').slice(0, 60)
      })()`
    )
    if (!opened)
      return {
        ok: false,
        detail: `no WhatsApp chat matched "${to}" — nothing was sent. Check the name as it appears in WhatsApp.`
      }

    // Type into the real composer and send with Enter.
    if (!(await exec<boolean>(win, FIND_COMPOSER)))
      return { ok: false, detail: `chat "${opened}" opened but the message box was not found — nothing sent.` }
    for (const ch of text.slice(0, 1500)) {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      if (text.length < 200) await sleep(4)
    }
    await sleep(300)
    // Composer must still hold our text (guards against focus theft mid-type).
    const composed = await exec<string>(
      win,
      `(() => {
        const footer = document.querySelector('#main footer')
        const box = footer && footer.querySelector('[contenteditable="true"]')
        return box ? (box.textContent || '') : ''
      })()`
    )
    if (!composed.includes(text.slice(0, 40)))
      return { ok: false, detail: `typing into the "${opened}" composer failed — nothing sent.` }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(900)

    // Composer should be empty now; the outgoing bubble should exist.
    const confirmed = await exec<boolean>(
      win,
      `(() => {
        const footer = document.querySelector('#main footer')
        const box = footer && footer.querySelector('[contenteditable="true"]')
        const emptied = !box || (box.textContent || '').trim().length === 0
        const bubbles = [...document.querySelectorAll('#main .message-out')].slice(-3)
        const landed = bubbles.some((b) => (b.textContent || '').includes(${JSON.stringify(text.slice(0, 40))}))
        return emptied && (landed || bubbles.length > 0)
      })()`
    ).catch(() => false)
    if (!confirmed)
      return { ok: false, detail: `send to "${opened}" could not be confirmed — check WhatsApp before retrying.` }
    return { ok: true, detail: `sent to ${opened}` }
  } catch (err) {
    return { ok: false, detail: `WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    sending = false
    scheduleIdleClose()
  }
}

// "> name: message" / ">wa name: message" from the assistant bar.
export function parseSendCommand(input: string): { recipient: string; message: string } | null {
  const m = input.match(/^>\s*(?:wa|whatsapp)?\s*([^:]{1,60}):\s*(.+)$/is)
  if (!m) return null
  return { recipient: m[1].trim(), message: m[2].trim() }
}
