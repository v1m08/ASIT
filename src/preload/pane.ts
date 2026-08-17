/// <reference lib="dom" />
import { ipcRenderer } from 'electron'

// Injected into every embedded web pane (isolated world — the page can't see
// or call any of this). Makes "/KEY " snippets expand inside ANY form on any
// website, exactly like they do in the app's own inputs.

let snippets: Record<string, string> = {}
let fetchedAt = 0

// "/otp" is a LIVE snippet: it resolves to the newest code from the user's
// mail at expansion time, like /gtid resolves to a saved value.
async function resolveSnippet(key: string): Promise<string | undefined> {
  if (key.toLowerCase() === 'otp') {
    try {
      return ((await ipcRenderer.invoke('otp:get')) as string | null) ?? undefined
    } catch {
      return undefined
    }
  }
  await ensureSnippets()
  return snippets[key]
}

async function ensureSnippets(): Promise<void> {
  if (Date.now() - fetchedAt < 15000) return
  try {
    snippets = (await ipcRenderer.invoke('snippets:get')) ?? {}
  } catch {
    // main not ready — try again next time
  }
  fetchedAt = Date.now()
}

const TEXT_TYPES = new Set(['', 'text', 'email', 'search', 'url', 'tel', 'password', 'number'])

// ---------------------------------------------------------------------------
// One-time-code autofill (the iOS trick, for any site)
//
// When a verification-code field is focused, ask main for the newest code from
// the user's own signed-in mail and fill it. Sites mark these fields for
// password managers (autocomplete="one-time-code"); we also sniff the usual
// names/labels and the 6-box split-digit layouts.
// ---------------------------------------------------------------------------

const OTP_FIELD =
  /(^|[^a-z])(otp|one.?time|verification|verify|auth(entication)?.?code|security.?code|sms.?code|2fa|mfa|passcode|totp)([^a-z]|$)/i

function looksLikeOtpField(el: HTMLInputElement): boolean {
  const type = (el.type || '').toLowerCase()
  if (!TEXT_TYPES.has(type)) return false
  if ((el.autocomplete || '').toLowerCase().includes('one-time-code')) return true
  const hay = [
    el.name,
    el.id,
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    el.getAttribute('data-testid'),
    el.labels?.[0]?.textContent ?? ''
  ]
    .filter(Boolean)
    .join(' ')
  if (OTP_FIELD.test(hay)) return true
  // Split-digit layouts: several tiny 1-char boxes in a row.
  const maxLen = el.maxLength
  if (maxLen === 1) {
    const siblings = el.form?.querySelectorAll('input[maxlength="1"]')?.length ?? 0
    if (siblings >= 4) return true
  }
  return false
}

let lastOtpFetch = 0
const filledFields = new WeakSet<HTMLInputElement>()

function fillOtp(el: HTMLInputElement, code: string): void {
  // Split-digit UIs: one character per box, each with its own events.
  if (el.maxLength === 1 && el.form) {
    const boxes = Array.from(el.form.querySelectorAll<HTMLInputElement>('input[maxlength="1"]'))
    const start = boxes.indexOf(el)
    if (start >= 0 && boxes.length - start >= code.length) {
      code.split('').forEach((ch, i) => {
        const box = boxes[start + i]
        setNativeValue(box, ch)
        box.dispatchEvent(new Event('input', { bubbles: true }))
        box.dispatchEvent(new Event('change', { bubbles: true }))
      })
      boxes[Math.min(start + code.length, boxes.length - 1)].focus()
      return
    }
  }
  setNativeValue(el, code)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

async function tryOtpAutofill(el: HTMLInputElement): Promise<void> {
  if (filledFields.has(el) || el.value) return
  if (Date.now() - lastOtpFetch < 15000) return // don't hammer the mailbox
  lastOtpFetch = Date.now()
  try {
    const code = (await ipcRenderer.invoke('otp:get')) as string | null
    // The user may have typed it themselves while we fetched.
    if (!code || el.value || filledFields.has(el)) return
    filledFields.add(el)
    fillOtp(el, code)
  } catch {
    // no code available — stay silent, the user just types it
  }
}

window.addEventListener(
  'focusin',
  (e: Event) => {
    const el = e.target as HTMLElement | null
    if (!(el instanceof HTMLInputElement)) return
    if (looksLikeOtpField(el)) void tryOtpAutofill(el)
    if ((el.type || '').toLowerCase() === 'password') void tryPasswordAutofill(el)
  },
  true
)

// ---------------------------------------------------------------------------
// Password autofill
//
// Driven entirely by the USER focusing a login field. The vault lives in
// userData — outside every agent cwd — and nothing here is reachable from an
// agent: this preload runs in an isolated world the page cannot see, and no
// action verb exists that could trigger it. We never auto-submit: the user
// always presses the button themselves.
// ---------------------------------------------------------------------------

const filledLogins = new WeakSet<HTMLInputElement>()
let lastVaultLookup = 0

function usernameFieldFor(pw: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = pw.form ?? document
  const candidates = Array.from(
    scope.querySelectorAll<HTMLInputElement>('input')
  ).filter((el) => {
    const t = (el.type || '').toLowerCase()
    return t === 'text' || t === 'email' || t === 'tel' || t === ''
  })
  if (candidates.length === 0) return null
  // The field just above the password is the username on essentially every
  // login form; fall back to an autocomplete/name hint.
  const before = candidates.filter(
    (el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING
  )
  return (
    before[before.length - 1] ??
    candidates.find((el) =>
      /user|email|login|account/i.test(`${el.name} ${el.id} ${el.autocomplete}`)
    ) ??
    null
  )
}

async function tryPasswordAutofill(pw: HTMLInputElement): Promise<void> {
  if (filledLogins.has(pw) || pw.value) return
  if (Date.now() - lastVaultLookup < 800) return
  lastVaultLookup = Date.now()
  try {
    const cred = (await ipcRenderer.invoke('vault:for-origin', location.href)) as {
      username: string
      password: string
    } | null
    if (!cred || !cred.password || pw.value || filledLogins.has(pw)) return
    filledLogins.add(pw)

    const user = usernameFieldFor(pw)
    if (user && !user.value && cred.username) {
      setNativeValue(user, cred.username)
      user.dispatchEvent(new Event('input', { bubbles: true }))
      user.dispatchEvent(new Event('change', { bubbles: true }))
    }
    setNativeValue(pw, cred.password)
    pw.dispatchEvent(new Event('input', { bubbles: true }))
    pw.dispatchEvent(new Event('change', { bubbles: true }))
    // Deliberately NO form.submit() — signing in stays the user's action.
  } catch {
    // no credential saved for this site — the user just types it
  }
}

// Declutter Google SEARCH pages inside narrow panes: hide the left filter
// rail so results get the full width. Scoped to google.*/search only —
// Gmail/Drive navs are untouched.
function injectGoogleDeclutter(): void {
  if (!/(^|\.)google\.[a-z.]+$/.test(location.hostname)) return
  if (!location.pathname.startsWith('/search')) return
  const style = document.createElement('style')
  style.textContent = `
    #lhs, #leftnav, [id="before-appbar"], div[role="navigation"][aria-label*="ilter"] { display: none !important; }
    #center_col, #rcnt { margin-left: 0 !important; }
  `
  document.documentElement.appendChild(style)
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', injectGoogleDeclutter)
} else {
  injectGoogleDeclutter()
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

window.addEventListener(
  'input',
  async (e: Event) => {
    const target = e.target as HTMLElement | null
    if (!target) return

    // Standard inputs / textareas
    if (
      (target instanceof HTMLInputElement && TEXT_TYPES.has((target.type || '').toLowerCase())) ||
      target instanceof HTMLTextAreaElement
    ) {
      const el = target as HTMLInputElement
      const pos = el.selectionStart ?? el.value.length
      const before = el.value.slice(0, pos)
      const m = before.match(/\/([A-Za-z0-9_-]+)( )$/)
      if (!m) return
      const value = await resolveSnippet(m[1])
      if (value === undefined || value.includes(`/${m[1]}`)) return
      const start = pos - m[0].length
      setNativeValue(el, el.value.slice(0, start) + value + ' ' + el.value.slice(pos))
      const caret = start + value.length + 1
      try {
        el.setSelectionRange(caret, caret)
      } catch {
        // number inputs reject setSelectionRange
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }

    // contenteditable editors (docs, rich comment boxes)
    if (target.isContentEditable) {
      const sel = window.getSelection()
      if (!sel || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) return
      const node = sel.anchorNode as Text
      const before = node.data.slice(0, sel.anchorOffset)
      const m = before.match(/\/([A-Za-z0-9_-]+)([  ])$/)
      if (!m) return
      const value = await resolveSnippet(m[1])
      if (value === undefined || value.includes(`/${m[1]}`)) return
      const start = sel.anchorOffset - m[0].length
      node.replaceData(start, m[0].length, value + ' ')
      sel.collapse(node, start + value.length + 1)
      target.dispatchEvent(new Event('input', { bubbles: true }))
    }
  },
  true
)
