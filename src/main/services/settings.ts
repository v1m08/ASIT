import { homedir } from 'os'
import { join } from 'path'
import { getDb } from '../db'
import type { Settings } from '@shared/types'

const DEFAULTS: Settings = {
  // Resolved properly at runtime (services/claude.ts tries every install
  // location); this is only the value shown in Settings before then.
  claudePath: join(
    homedir(),
    '.local',
    'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude'
  ),
  studyEnabled: true, // existing users keep their tools; the shell is the pivot
  workMin: 25,
  breakMin: 5,
  escapePhrase: 'I am choosing to stop studying and I accept that this was my decision',
  holdToQuitSeconds: 30,
  chatModel: 'default',
  codingModel: 'claude-fable-5',
  jarvisModel: 'default',
  searchEngine: 'google',
  searchUrlCustom: '',
  adBlock: true, // the user asked for ads filtered by default
  blockedDomains: [],
  declutter: true,
  declutterExcludeHosts: [],
  declutterCss: '',
  extensionPaths: [],
  hidePin: false,
  hideReview: false,
  hideTerminal: false,
  hideAppWindow: false,
  sensitiveTerms: [], // empty → SENSITIVE_DEFAULTS in guardrails.ts
  sendAllowlist: [], // empty → any recipient (still intent-gated)
  onboarded: false,
  snippets: {},
  fetchSources: [
    { name: 'Gmail', url: 'https://mail.google.com/mail/u/0/#search/{q}' },
    { name: 'Outlook', url: 'https://outlook.live.com/mail/0/' }
  ],
  companionEnabled: false,
  companionPort: 4425,
  companionToken: '',
  vapidPublicKey: '',
  vapidPrivateKey: '',
  companionSubs: []
}

// getSettings is on hot paths (every CLI spawn, CLAUDE.md write, quickfetch,
// timer tick validation) — cache the merged object; setSettings invalidates.
let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  const merged: Settings = { ...DEFAULTS, ...stored }
  // Union built-in fetch sources into a user's saved list so new defaults
  // (e.g. Outlook) reach existing installs.
  const names = new Set((merged.fetchSources ?? []).map((s) => s.name.toLowerCase()))
  for (const d of DEFAULTS.fetchSources) {
    if (!names.has(d.name.toLowerCase())) {
      merged.fetchSources = [...(merged.fetchSources ?? []), d]
    }
  }
  cache = merged
  return merged
}

export function setSettings(patch: Partial<Settings>): Settings {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) stmt.run(k, JSON.stringify(v))
    }
  })()
  cache = null
  return getSettings()
}
