import { session } from 'electron'
import { searchUrlFor as sharedSearchUrlFor, suggestUrlFor } from '@shared/search'
import { getSettings } from './settings'

// Main-process face of the shared search-engine table, for the few places
// outside the renderer that build a search URL (pane context menu,
// quickfetch's web-search window) — plus the two things that make typing a
// search feel instant: type-ahead suggestions and a pre-warmed connection.

const BROWSE_PARTITION = 'persist:asit-browse'

export function searchUrlFor(query: string): string {
  return sharedSearchUrlFor(getSettings(), query)
}

/**
 * Open sockets to the search engine while the user is still typing, so the
 * results page skips DNS + TCP + TLS (a few hundred ms on a cold
 * connection). Called when the command bar / address box opens. Cheap and
 * idempotent: Chromium ignores it when a warm socket already exists.
 */
export function preconnectSearch(): void {
  try {
    const origin = new URL(searchUrlFor('x')).origin
    const ses = session.fromPartition(BROWSE_PARTITION)
    ses.preconnect({ url: origin, numSockets: 2 })
    const suggest = suggestUrlFor(getSettings(), 'x')
    if (suggest && getSettings().searchSuggestions !== false)
      ses.preconnect({ url: new URL(suggest).origin, numSockets: 1 })
  } catch {
    /* custom engine with a malformed template — nothing to warm */
  }
}

/**
 * Engine type-ahead, like any browser's omnibox. User-driven only (the
 * command bar and address box call it on keystrokes); no agent path exists.
 * Fetched on the browse partition so it is the same client the results page
 * is — and it is the user's own typed text going to the engine they chose,
 * exactly what pressing Enter would send. Off when `searchSuggestions` is.
 */
export async function suggest(query: string): Promise<string[]> {
  const q = query.trim()
  const settings = getSettings()
  if (!q || q.length > 200 || settings.searchSuggestions === false) return []
  const url = suggestUrlFor(settings, q)
  if (!url) return []
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await session.fromPartition(BROWSE_PARTITION).fetch(url, { signal: ctrl.signal })
    if (!res.ok) return []
    const body = (await res.json()) as unknown
    const list = Array.isArray(body) && Array.isArray(body[1]) ? (body[1] as unknown[]) : []
    return list
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .filter((s) => s.toLowerCase() !== q.toLowerCase())
      .slice(0, 6)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
