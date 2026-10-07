import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useOverlay } from '../hooks/useOverlay'
import { useStore } from '../store/useStore'
import { toNavUrl } from '../lib/url'
import { OmniRowView, useOmnibox } from '../browser/useOmnibox'

// The address bar, for every surface that shows a web page — the sidebar
// pill, the new-tab page's search box and the compact toolbar.
//
// The workspace had no editable address bar at all: the URL was a read-only
// span, so the only ways to reach a page were the search tab or a link. Ctrl+L
// targeted `.browser-address`, which existed solely on the standalone browser
// screen — the shortcut was real and did nothing in a workspace. Rather than
// give the workspace its own copy, both surfaces now render this.
//
// Its dropdown is the omnibox (browser/useOmnibox) — the same ranking as the
// Ctrl+T command bar, minus the app-wide rows: the top row is always what
// Enter does, then open tabs, engine suggestions, bookmarks and history, with
// inline completion of the sites you visit.

// Re-exported for the many callers that import them from here.
export { hostOf, looksLikeUrl, toNavUrl } from '../lib/url'

export default function AddressBar({
  url,
  onNavigate,
  className = '',
  placeholder = 'Search or enter address',
  autoFocus = false,
  idleLabel,
  overPanes = true,
  onDraftChange,
  onAltSubmit
}: {
  /** The page currently shown; displayed whenever the user isn't typing. */
  url: string
  onNavigate: (target: string) => void
  className?: string
  placeholder?: string
  /** New-tab page: land the caret in the box, like every browser. */
  autoFocus?: boolean
  /** Shown instead of the URL while not editing — the sidebar shows just the
   *  domain, Arc-style; focusing reveals (and selects) the full address. */
  idleLabel?: string
  /** False when the suggestions open over app DOM only (the sidebar): no
   *  page can cover them, so the pages need not vanish while you type. */
  overPanes?: boolean
  /** Reports what is typed (the new-tab page's "Browse for me" reads it). */
  onDraftChange?: (value: string) => void
  /** Shift+Enter — the new-tab page hands the query to the agent. */
  onAltSubmit?: (value: string) => void
}): JSX.Element {
  // null means "not editing" — show the live URL. A plain value-state would
  // freeze the bar on whatever was last typed while the page navigates on.
  const [draft, setDraft] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [allowComplete, setAllowComplete] = useState(false)
  // Focusing swaps in the full URL; until you change it, there is nothing to
  // suggest (and Enter just reloads where you are, as before).
  const [edited, setEdited] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // The dropdown hangs down over the page area, and WebContentsViews paint
  // above ALL renderer DOM (invariant 2) — without this the suggestions were
  // simply invisible wherever a page was showing. Keyed to the editing
  // session (focus…blur), NOT the suggestion count: the count crosses 0↔N
  // per keystroke, and each crossing would flash every pane hidden/visible.
  useOverlay(overPanes && draft !== null)

  const close = useCallback((): void => {
    setDraft(null)
    setHighlight(0)
    setAllowComplete(false)
    setEdited(false)
  }, [])

  const goUrl = (target: string, newTab: boolean): void => {
    close()
    inputRef.current?.blur()
    const tabs = newTab ? useStore.getState().tabSurface : null
    if (tabs) tabs.openInNewTab(target)
    else onNavigate(target)
  }

  // Nothing typed, nothing to suggest: simply focusing the box must not drop
  // a list over whatever is behind it (the NTP autofocuses its box).
  const typed = draft ?? ''
  const editing = draft !== null && edited
  const { rows, completion } = useOmnibox(editing ? typed : '', {
    open: editing,
    includeApp: false,
    emptyRows: false,
    allowComplete,
    go: goUrl
  })
  const shown =
    draft === null ? (idleLabel ?? url ?? '') : typed + (editing ? (completion?.text ?? '') : '')
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el || !completion || document.activeElement !== el) return
    el.setSelectionRange(typed.length, shown.length)
  }, [shown, typed, completion])
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, rows.length - 1)))
  }, [rows.length])

  // Clicking anywhere else closes the dropdown. Pages paint over app DOM, so
  // a click that lands on a pane never reaches us — blur covers that case.
  useEffect(() => {
    if (rows.length === 0) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [rows.length, close])

  const submit = (newTab: boolean): void => {
    const pick = rows[highlight]
    if (pick) {
      close()
      inputRef.current?.blur()
      pick.run({ newTab })
      return
    }
    const value = draft ?? url
    if (!value?.trim()) return
    goUrl(toNavUrl(value), newTab)
  }

  return (
    <div className={`address-box ${className}`} ref={boxRef}>
      <input
        ref={inputRef}
        className="browser-address"
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        value={shown}
        onChange={(e) => {
          const kind = (e.nativeEvent as InputEvent).inputType ?? ''
          setAllowComplete(!kind.startsWith('delete'))
          setDraft(e.target.value)
          setEdited(true)
          setHighlight(0)
          onDraftChange?.(e.target.value)
        }}
        onFocus={(e) => {
          window.asit.browser.preconnect()
          // The real address, not the idle label — then select it all once
          // React has swapped it in.
          setDraft(url ?? e.target.value)
          e.target.select()
          requestAnimationFrame(() => inputRef.current?.select())
        }}
        onBlur={() => {
          // Deferred: a click on a suggestion blurs the input first, and
          // closing immediately would unmount the row before it registers.
          setTimeout(close, 120)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.shiftKey && onAltSubmit) {
            const value = typed.trim()
            if (value) {
              close()
              onAltSubmit(value)
            }
            return
          }
          if (e.key === 'Enter') {
            submit(e.metaKey || e.ctrlKey)
            return
          }
          if (e.key === 'Tab' && completion && !e.shiftKey) {
            e.preventDefault()
            setDraft(typed + completion.text)
            setEdited(true)
            setAllowComplete(false)
            return
          }
          if (e.key === 'Escape') {
            close()
            inputRef.current?.blur()
            return
          }
          if (e.key === 'ArrowDown' && rows.length > 0) {
            e.preventDefault()
            setHighlight((h) => (h + 1) % rows.length)
            return
          }
          if (e.key === 'ArrowUp' && rows.length > 0) {
            e.preventDefault()
            setHighlight((h) => (h <= 0 ? rows.length - 1 : h - 1))
          }
        }}
      />
      {editing && typed.trim() && rows.length > 0 && (
        <div className="address-suggestions omni-list">
          {rows.map((row, i) => (
            <OmniRowView
              key={row.id}
              row={row}
              query={typed}
              on={i === highlight}
              onHover={() => setHighlight(i)}
              onPick={(newTab) => {
                close()
                inputRef.current?.blur()
                row.run({ newTab })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
