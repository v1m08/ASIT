import { searchUrlFor as sharedSearchUrlFor } from '@shared/search'
import { getSettings } from './settings'

// Main-process face of the shared search-engine table, for the few places
// outside the renderer that build a search URL (pane context menu,
// quickfetch's web-search window).

export function searchUrlFor(query: string): string {
  return sharedSearchUrlFor(getSettings(), query)
}
