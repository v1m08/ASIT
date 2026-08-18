import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

// Local credential store for the embedded browser.
//
// SEALED FROM AI, structurally — the same way private workspaces are:
//   * The file lives in userData (%APPDATA%\asit), which is OUTSIDE every
//     agent cwd (tasks root, task folders). No agent can read it even with
//     full filesystem tools, because its allowedTools are cwd-scoped.
//   * There is no action verb, no flow verb, and no agent-reachable IPC.
//     Autofill is driven by the pane preload (an isolated world the page
//     can't see) responding to the USER focusing a field.
//   * It is never mentioned in any CLAUDE.md or agent briefing.
//   * Filled password inputs are masked out of agent page snapshots
//     (see panes.ts) so a filled value can't leak back through a screenshot.
//
// Secrets are encrypted with Electron's safeStorage, which on Windows is
// DPAPI — the ciphertext is bound to the OS user account, so copying the file
// to another machine or account yields nothing.

export interface VaultEntry {
  id: string
  origin: string // "https://example.com" — scheme + host
  username: string
  title: string
  updatedAt: string
}

interface StoredEntry extends VaultEntry {
  secret: string // base64 of safeStorage ciphertext (or plaintext marker)
  plain: boolean // true only when OS encryption is unavailable
}

function vaultPath(): string {
  return join(app.getPath('userData'), 'vault.json')
}

function load(): StoredEntry[] {
  try {
    if (!existsSync(vaultPath())) return []
    const parsed = JSON.parse(readFileSync(vaultPath(), 'utf-8'))
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : []
  } catch {
    return [] // a corrupt vault must not take the app down
  }
}

function save(entries: StoredEntry[]): void {
  writeFileSync(vaultPath(), JSON.stringify(entries, null, 2), 'utf-8')
  try {
    chmodSync(vaultPath(), 0o600)
  } catch {
    // best effort on Windows ACLs
  }
}

/** Normalize to scheme://host so "site.com/login?x=1" matches a saved entry. */
export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.hostname}`
  } catch {
    return ''
  }
}

function encrypt(secret: string): { secret: string; plain: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { secret: safeStorage.encryptString(secret).toString('base64'), plain: false }
  }
  // Never silently pretend this is protected — the UI surfaces it.
  return { secret: Buffer.from(secret, 'utf-8').toString('base64'), plain: true }
}

function decrypt(entry: StoredEntry): string {
  try {
    const buf = Buffer.from(entry.secret, 'base64')
    return entry.plain ? buf.toString('utf-8') : safeStorage.decryptString(buf)
  } catch {
    return ''
  }
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** Listing NEVER includes secrets. */
export function listEntries(): VaultEntry[] {
  return load()
    .map(({ id, origin, username, title, updatedAt }) => ({ id, origin, username, title, updatedAt }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

export function saveEntry(input: {
  id?: string
  origin: string
  username: string
  password: string
  title?: string
}): VaultEntry | { error: string } {
  const origin = originOf(input.origin) || originOf(`https://${input.origin}`)
  if (!origin) return { error: 'Enter a valid site, e.g. https://gatech.edu' }
  if (!input.username && !input.password) return { error: 'Enter a username or a password' }

  const entries = load()
  const { secret, plain } = encrypt(input.password)
  const existing = input.id ? entries.find((e) => e.id === input.id) : undefined
  const entry: StoredEntry = {
    id: existing?.id ?? `v-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    origin,
    username: input.username,
    title: input.title?.trim() || new URL(origin).hostname,
    updatedAt: new Date().toISOString(),
    secret,
    plain
  }
  const next = existing ? entries.map((e) => (e.id === entry.id ? entry : e)) : [...entries, entry]
  save(next)
  const { secret: _s, plain: _p, ...safe } = entry
  return safe
}

export function deleteEntry(id: string): void {
  save(load().filter((e) => e.id !== id))
}

/** User-initiated reveal in Settings. Not reachable from any agent path. */
export function revealPassword(id: string): string | null {
  const entry = load().find((e) => e.id === id)
  return entry ? decrypt(entry) : null
}

/**
 * The autofill lookup. Called ONLY by the pane preload when the user focuses
 * a login field on a matching site. Exact-origin match: no subdomain
 * wildcarding, so a lookalike host never receives a credential.
 */
export function credentialsForOrigin(url: string): { username: string; password: string } | null {
  const origin = originOf(url)
  if (!origin) return null
  const entry = load().find((e) => e.origin.toLowerCase() === origin.toLowerCase())
  if (!entry) return null
  return { username: entry.username, password: decrypt(entry) }
}

// --- "save this password?" -------------------------------------------------
//
// The credential goes preload -> MAIN and stops there. The renderer is only
// ever told the site and username, never the password: the prompt is app UI,
// and a secret that never enters the renderer cannot be read out of it.
// Nothing here is agent-reachable, same as the rest of this file.

let pending: { origin: string; username: string; password: string } | null = null

/** Called by the pane preload when the user submits a login form. */
export function offerToSave(url: string, username: string, password: string): boolean {
  const origin = originOf(url)
  if (!origin || !password) return false
  const existing = load().find((e) => e.origin.toLowerCase() === origin.toLowerCase())
  // Nothing to ask about if we already hold exactly this.
  if (existing && existing.username === username && decrypt(existing) === password) return false
  pending = { origin, username, password }
  return true
}

/** What the renderer may know: the site and the username. Never the secret. */
export function pendingSaveInfo(): { origin: string; username: string } | null {
  return pending ? { origin: pending.origin, username: pending.username } : null
}

export function commitPendingSave(): VaultEntry | { error: string } | null {
  if (!pending) return null
  const result = saveEntry(pending)
  pending = null
  return result
}

export function discardPendingSave(): void {
  pending = null
}

export function hasCredentialsFor(url: string): boolean {
  const origin = originOf(url)
  return !!origin && load().some((e) => e.origin.toLowerCase() === origin.toLowerCase())
}
