import { searchUrl } from './search'

// What-the-user-typed → where-to-go, shared by every box that takes an
// address (command bar, sidebar pill, new-tab page, compact toolbar).

export function looksLikeUrl(v: string): boolean {
  const t = v.trim()
  if (!t || /\s/.test(t)) return false
  if (/^(https?|file):\/\//i.test(t)) return true
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return true
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|$|\?|#)/i.test(t)
}

/** What the user typed → where to go. Anything that isn't a URL is a search. */
export function toNavUrl(v: string): string {
  const t = v.trim()
  if (/^(https?|file):/i.test(t)) return t
  if (looksLikeUrl(t)) return `https://${t}`
  return searchUrl(t)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** "https://www.github.com/foo" → "github.com/foo" — what inline completion matches. */
export function bareUrl(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '')
}
