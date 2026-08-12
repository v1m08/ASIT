// "/KEY " text expansion. A snippet only expands once a whitespace character
// follows the key, so half-typed keys are never mangled.
export function expandSnippets(text: string, snippets: Record<string, string>): string {
  let out = text
  for (const [rawKey, value] of Object.entries(snippets)) {
    const key = rawKey.replace(/^\//, '')
    if (!key) continue
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`/${escaped}(?=\\s)`, 'g'), value)
  }
  return out
}
