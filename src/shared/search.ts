import type { SearchEngine, Settings } from './types'

// The one place that knows how to turn "what the user typed" into a search
// URL. Renderer surfaces (address bar, new-tab actions) and main services
// (context-menu search, quickfetch) both route through here, so changing the
// engine in Settings changes every search in the app.

const ENGINES: Record<Exclude<SearchEngine, 'custom'>, string> = {
  google: 'https://www.google.com/search?q={q}',
  duckduckgo: 'https://duckduckgo.com/?q={q}',
  bing: 'https://www.bing.com/search?q={q}',
  brave: 'https://search.brave.com/search?q={q}'
}

type SearchSettings = Pick<Settings, 'searchEngine' | 'searchUrlCustom'>

/** The search-results URL for a query, per the user's engine choice. */
export function searchUrlFor(settings: SearchSettings, query: string): string {
  const template =
    settings.searchEngine === 'custom' && settings.searchUrlCustom.includes('{q}')
      ? settings.searchUrlCustom
      : (ENGINES[settings.searchEngine as Exclude<SearchEngine, 'custom'>] ?? ENGINES.google)
  return template.replace('{q}', encodeURIComponent(query))
}

// Type-ahead suggestion endpoints. Each answers OpenSearch-suggestions JSON —
// `[query, [suggestion, …], …]` — so one parser covers all of them. A custom
// engine has no known endpoint, so it simply gets no suggestions.
const SUGGEST: Record<Exclude<SearchEngine, 'custom'>, string> = {
  google: 'https://suggestqueries.google.com/complete/search?client=chrome&q={q}',
  duckduckgo: 'https://duckduckgo.com/ac/?type=list&q={q}',
  bing: 'https://api.bing.com/osjson.aspx?query={q}',
  brave: 'https://search.brave.com/api/suggest?q={q}'
}

/** The suggestion URL for a query, or null when the engine has none. */
export function suggestUrlFor(settings: SearchSettings, query: string): string | null {
  if (settings.searchEngine === 'custom') return null
  const template = SUGGEST[settings.searchEngine as Exclude<SearchEngine, 'custom'>] ?? SUGGEST.google
  return template.replace('{q}', encodeURIComponent(query))
}

/** The engine's display name, for "Search Google for …" rows. */
export function engineName(settings: SearchSettings): string {
  switch (settings.searchEngine) {
    case 'duckduckgo':
      return 'DuckDuckGo'
    case 'bing':
      return 'Bing'
    case 'brave':
      return 'Brave'
    case 'custom':
      try {
        return new URL(settings.searchUrlCustom.replace('{q}', 'q')).hostname.replace(/^www\./, '')
      } catch {
        return 'the web'
      }
    default:
      return 'Google'
  }
}
