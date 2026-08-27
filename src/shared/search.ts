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
