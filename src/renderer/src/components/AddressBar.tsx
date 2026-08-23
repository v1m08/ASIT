import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { useOverlay } from '../hooks/useOverlay'

// The address bar, for every surface that shows a web page.
//
// The workspace had no editable address bar at all: the URL was a read-only
// span, so the only ways to reach a page were the search tab or a link. Ctrl+L
// targeted `.browser-address`, which existed solely on the standalone browser
// screen — the shortcut was real and did nothing in a workspace. Rather than
// give the workspace its own copy, both surfaces now render this.

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
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function AddressBar({
  url,
  onNavigate,
  className = '',
  placeholder = 'Search or enter address'
}: {
  /** The page currently shown; displayed whenever the user isn't typing. */
  url: string
  onNavigate: (target: string) => void
  className?: string
  placeholder?: string
}): JSX.Element {
  // null means "not editing" — show the live URL. A plain value-state would
  // freeze the bar on whatever was last typed while the page navigates on.
  const [draft, setDraft] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([])
  const [highlight, setHighlight] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // The dropdown hangs down over the page area, and WebContentsViews paint
  // above ALL renderer DOM (invariant 2) — without this the suggestions were
  // simply invisible wherever a page was showing. Keyed to the editing
  // session (focus…blur), NOT the suggestion count: the count crosses 0↔N
  // per keystroke, and each crossing would flash every pane hidden/visible.
  useOverlay(draft !== null)

  const close = useCallback((): void => {
    setDraft(null)
    setSuggestions([])
    setHighlight(-1)
  }, [])

  // Debounced, and guarded against out-of-order replies: history lookups are
  // async, so a slow one for "g" could otherwise land after "github" and
  // replace good suggestions with stale ones.
  useEffect(() => {
    if (draft === null) return
    let live = true
    const t = setTimeout(() => {
      void window.asit.history.search(draft, 8).then((rows) => {
        if (live) {
          setSuggestions(rows)
          setHighlight(-1)
        }
      })
    }, 90)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [draft])

  // Clicking anywhere else closes the dropdown. Pages paint over app DOM, so
  // a click that lands on a pane never reaches us — blur covers that case.
  useEffect(() => {
    if (suggestions.length === 0) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [suggestions.length, close])

  const go = (value: string): void => {
    if (!value.trim()) return
    close()
    inputRef.current?.blur()
    onNavigate(toNavUrl(value))
  }

  return (
    <div className={`address-box ${className}`} ref={boxRef}>
      <input
        ref={inputRef}
        className="browser-address"
        placeholder={placeholder}
        spellCheck={false}
        value={draft ?? url ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(e.target.value)
          e.target.select()
        }}
        onBlur={() => {
          // Deferred: a click on a suggestion blurs the input first, and
          // closing immediately would unmount the row before it registers.
          setTimeout(close, 120)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const pick = highlight >= 0 ? suggestions[highlight] : null
            go(pick ? pick.url : (draft ?? url))
            return
          }
          if (e.key === 'Escape') {
            close()
            inputRef.current?.blur()
            return
          }
          if (e.key === 'ArrowDown' && suggestions.length > 0) {
            e.preventDefault()
            setHighlight((h) => (h + 1) % suggestions.length)
            return
          }
          if (e.key === 'ArrowUp' && suggestions.length > 0) {
            e.preventDefault()
            setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
          }
        }}
      />
      {draft !== null && suggestions.length > 0 && (
        <div className="address-suggestions">
          {suggestions.map((s, i) => (
            <div
              key={s.id}
              className={`address-suggestion ${i === highlight ? 'address-suggestion-on' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault() // keep focus so onBlur doesn't race the click
                go(s.url)
              }}
            >
              <span className="address-suggestion-title">{s.title || hostOf(s.url)}</span>
              <span className="address-suggestion-url">{hostOf(s.url)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
