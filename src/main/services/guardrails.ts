import { getSettings } from './settings'

// Hard limits on what agents can reach and do. Everything here is enforced in
// MAIN, from the USER's own words or from data the model never controls —
// none of it is "the model was told not to". A prompt-injected or confused
// agent hits the same walls.

// ---------------------------------------------------------------------------
// 1. Sensitive-content blocking for mail/web search
//
// Two layers, both mandatory:
//   query  — a search containing a blocked term never runs at all
//   result — every returned line is dropped if it mentions a blocked term,
//            so a benign query ("confirmation") can't surface a tax or
//            password email by accident. Blocked text never reaches the model.
// ---------------------------------------------------------------------------

export const SENSITIVE_DEFAULTS = [
  'password',
  'passwd',
  'passphrase',
  'credential',
  'private key',
  'seed phrase',
  'recovery code',
  'backup code',
  'api key',
  'secret key',
  'tax',
  'irs',
  '1099',
  'w-2',
  'w2 ',
  'taxpayer',
  'ssn',
  'social security',
  'routing number',
  'account number',
  'card number',
  'cvv',
  'bank statement',
  'medical',
  'diagnosis',
  'prescription',
  'health record',
  'lab result',
  'therapy',
  'passport',
  'visa application',
  'immigration',
  'attorney',
  'lawsuit',
  'settlement'
]

export function sensitiveTerms(): string[] {
  // Custom terms ADD to the built-ins — the baseline can't be edited away.
  const custom = getSettings().sensitiveTerms ?? []
  return [...SENSITIVE_DEFAULTS, ...custom].map((t) => t.toLowerCase().trim()).filter(Boolean)
}

/** The blocked term a query trips, or null. */
export function blockedTermIn(text: string): string | null {
  const haystack = ` ${text.toLowerCase()} `
  for (const term of sensitiveTerms()) {
    if (haystack.includes(term)) return term
  }
  return null
}

/** Drop every line that mentions a protected term. */
export function filterSensitiveLines(lines: string[]): { kept: string[]; removed: number } {
  const terms = sensitiveTerms()
  const kept = lines.filter((l) => {
    const low = ` ${l.toLowerCase()} `
    return !terms.some((t) => low.includes(t))
  })
  return { kept, removed: lines.length - kept.length }
}

// ---------------------------------------------------------------------------
// 2. Send authorization
//
// Sending is DENY-BY-DEFAULT. The only thing that opens the gate is the
// USER's own message text for the current turn, parsed here in main — never
// the model's claim that the user asked. Email is stricter than chat: it
// needs an explicit mail word AND a send verb.
// ---------------------------------------------------------------------------

export type SendKind = 'whatsapp' | 'email'

interface SendGrant {
  whatsapp: boolean
  email: boolean
  at: number
  named: string[] // recipient-ish words the user actually wrote
}

let grant: SendGrant = { whatsapp: false, email: false, at: 0, named: [] }
const GRANT_TTL_MS = 10 * 60_000 // a turn's authority doesn't outlive the turn by much

// "tell me" / "show me" are NOT send intents; "tell Mom" is.
const CHAT_SEND =
  /\b(send|text|whatsapp|dm)\b|\b(message|msg|tell|reply|remind)\s+(?!me\b|us\b)[a-z]/i
const MAIL_WORD = /\b(e-?mail|gmail|outlook|inbox|mailbox)\b/i
const SEND_VERB = /\b(send|reply|respond|forward|shoot|fire off)\b/i
const EMAIL_AS_VERB = /\be-?mail\s+(?!me\b|us\b)[a-z]/i

export function authorizeSendsFromUserMessage(message: string): void {
  const m = message ?? ''
  const email = (SEND_VERB.test(m) && MAIL_WORD.test(m)) || EMAIL_AS_VERB.test(m)
  const whatsapp = CHAT_SEND.test(m) || email
  grant = {
    whatsapp,
    email,
    at: Date.now(),
    // Capitalised words + quoted names: a cheap record of who the USER named.
    named: (m.match(/\b[A-Z][a-z]{1,20}\b/g) ?? []).map((w) => w.toLowerCase())
  }
}

export function clearSendAuthorization(): void {
  grant = { whatsapp: false, email: false, at: 0, named: [] }
}

export function sendAuthorized(kind: SendKind): boolean {
  if (Date.now() - grant.at > GRANT_TTL_MS) return false
  return kind === 'email' ? grant.email : grant.whatsapp
}

export function sendRefusalReason(kind: SendKind): string {
  return kind === 'email'
    ? 'BLOCKED: sending email requires the user to ask for it explicitly in their own message (e.g. "email Prof Chen that…"). You may read, search, summarize and DRAFT email freely — but the app will not let you send it. Show the draft and let the user send or ask again.'
    : 'BLOCKED: sending messages requires the user to ask for it explicitly in their own message (e.g. "text Mom that…"). Show what you would send instead.'
}

/**
 * Recipient guard. If the user configured an allowlist, only those recipients
 * are reachable. Otherwise any recipient is allowed — but the send still had
 * to pass the intent gate above, and every send is surfaced in a toast.
 */
export function recipientAllowed(recipient: string): { ok: boolean; reason?: string } {
  const list = (getSettings().sendAllowlist ?? []).map((r) => r.toLowerCase().trim()).filter(Boolean)
  if (list.length === 0) return { ok: true }
  const target = recipient.toLowerCase().trim()
  const hit = list.some((allowed) => target.includes(allowed) || allowed.includes(target))
  return hit
    ? { ok: true }
    : {
        ok: false,
        reason: `BLOCKED: "${recipient}" is not in your send allowlist (Settings → Guardrails). Allowed: ${list.join(', ')}`
      }
}

// ---------------------------------------------------------------------------
// 3. Mail-UI send controls
//
// The real email risk isn't an API — it's an agent clicking "Send" in the
// Gmail tab you're already signed into. Block that at the click/keystroke
// layer whenever email sending isn't authorized.
// ---------------------------------------------------------------------------

const MAIL_HOSTS =
  /(^|\.)(mail\.google\.com|inbox\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|mail\.proton\.me)$/i

export function isMailHost(url: string): boolean {
  try {
    return MAIL_HOSTS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

const SEND_CONTROL = /^\s*(send|send email|send message|send now|reply all|reply|forward)\b/i

/** True when this click/keystroke would fire off mail and isn't authorized. */
export function mailSendBlocked(url: string, labelOrKey: string): boolean {
  if (!isMailHost(url)) return false
  if (sendAuthorized('email')) return false
  const t = (labelOrKey ?? '').trim()
  // Gmail/Outlook send shortcuts as well as the button itself.
  if (/^(ctrl|cmd|meta)\+enter$/i.test(t) || /^(ctrl|cmd|meta)\+shift\+enter$/i.test(t)) return true
  return SEND_CONTROL.test(t)
}
