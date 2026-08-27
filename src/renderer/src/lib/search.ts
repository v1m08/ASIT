import { searchUrlFor } from '@shared/search'
import { useStore } from '../store/useStore'

// Renderer-side accessors for the shared search-engine table. Settings load
// into the store on boot (and reload on every Settings save), so reading the
// store here means an engine change applies to the next search immediately —
// no restart, no prop-drilling through every surface that can search.

const FALLBACK = { searchEngine: 'google' as const, searchUrlCustom: '' }

export function searchUrl(query: string): string {
  return searchUrlFor(useStore.getState().settings ?? FALLBACK, query)
}
