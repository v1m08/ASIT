import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, type CommandBarState } from '../store/useStore'
import { useOverlay } from '../hooks/useOverlay'
import { toNavUrl } from '../lib/url'
import { BROWSE_COLOR, groupColor } from './GroupBar'
import { OmniIcon, OmniRowView, useOmnibox, type OmniRow } from './useOmnibox'

// Arc's command bar. Ctrl+T (and the sidebar's "+ New Tab") opens it to start
// a new tab; Ctrl+L opens it on the focused tab, starting from its address;
// Ctrl+P is the same box. It floats over the page instead of replacing it.
//
// Invariant 2 still holds: pages paint above all DOM, so the bar hides them
// (useOverlay) — but only after photographing them, and the photos stand in
// at the same bounds. To the eye the page simply stays behind the bar.
//
// Keys: ↑↓ move · Enter opens · Ctrl/⌘+Enter forces a new tab · Shift+Enter
// asks the agent · Tab accepts the inline completion · Esc closes.

interface Shot {
  x: number
  y: number
  w: number
  h: number
  src: string
}

export default function CommandBar(): JSX.Element | null {
  const bar = useStore((s) => s.commandBar)
  if (!bar) return null
  return <CommandBarInner key={bar.at} bar={bar} />
}

function CommandBarInner({ bar }: { bar: CommandBarState }): JSX.Element {
  const close = useStore((s) => s.closeCommandBar)
  // The bar mounts outside .shell, so carry the space's colour in by hand —
  // its accent is how you know which space the new tab lands in.
  const spaceColor = useStore((s) =>
    !s.activeTask || s.activeTask.id === s.scratchTask?.id ? BROWSE_COLOR : groupColor(s.activeTask.id)
  )
  const [typed, setTyped] = useState(bar.initial)
  // Ctrl+L starts from the current address, selected. Until you type, the
  // list is the empty-box list (your tabs), not matches for that URL.
  const [edited, setEdited] = useState(bar.mode === 'new')
  const [allowComplete, setAllowComplete] = useState(false)
  const [highlight, setHighlight] = useState(bar.mode === 'new' ? 0 : -1)
  const [shots, setShots] = useState<Shot[] | null>(null)
  const [hidePanes, setHidePanes] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useOverlay(hidePanes)

  useEffect(() => {
    window.asit.browser.preconnect()
    let done = false
    const finish = (s: Shot[]): void => {
      if (done) return
      done = true
      setShots(s)
      setHidePanes(true)
      // Main focused the window's webContents while capturing; make sure the
      // caret is (still) in the box, without undoing what was typed.
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el && document.activeElement !== el) el.focus()
      })
    }
    // A slow capture must not hold the bar hostage: past 250ms, hide anyway.
    const t = setTimeout(() => finish([]), 250)
    void window.asit.panes
      .captureVisible()
      .then(finish)
      .catch(() => finish([]))
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => clearTimeout(t)
  }, [])

  const go = (url: string, newTab: boolean): void => {
    const surface = useStore.getState().tabSurface
    if (!surface) return useStore.getState().openUrlInWorkspace(url)
    if (newTab) surface.openInNewTab(url)
    else surface.navigateCurrent(url)
  }

  const query = edited ? typed : ''
  const { rows, completion } = useOmnibox(query, {
    open: true,
    includeApp: true,
    emptyRows: true,
    offerNewTabPage: bar.mode === 'new',
    allowComplete: allowComplete && edited,
    go
  })

  const shown = typed + (edited && completion ? completion.text : '')
  // Keep the completion suffix selected, so the next keystroke replaces it.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el || !edited || !completion || document.activeElement !== el) return
    el.setSelectionRange(typed.length, shown.length)
  }, [shown, typed, edited, completion])

  useEffect(() => {
    setHighlight((h) => (h < 0 ? h : Math.min(h, Math.max(0, rows.length - 1))))
  }, [rows.length])
  useEffect(() => {
    listRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const pick = (row: OmniRow | undefined, newTab: boolean): void => {
    close()
    if (row) {
      // After the overlay lifts, so whatever the row does to panes isn't
      // fighting the visibility restore.
      setTimeout(() => row.run({ newTab }), 0)
      return
    }
    const text = typed.trim()
    if (!text || text === bar.initial) return // Ctrl+L, Enter: nothing changed
    setTimeout(() => go(toNavUrl(text), newTab), 0)
  }

  const newTabFor = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
    bar.mode === 'new' || e.metaKey || e.ctrlKey

  const current = highlight >= 0 ? rows[highlight] : undefined

  return (
    <div
      className="cmdbar-root"
      style={{ ['--space' as string]: spaceColor }}
      onMouseDown={close}
    >
      {shots?.map((s, i) => (
        <img
          key={i}
          className="cmdbar-shot"
          src={s.src}
          alt=""
          style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
        />
      ))}
      <div className="cmdbar-scrim" />
      <div className="cmdbar" onMouseDown={(e) => e.stopPropagation()} data-focus-zone="Command bar">
        <div className="cmdbar-input-row">
          <OmniIcon row={current ?? (edited ? rows[0] : undefined)} />
          <input
            ref={inputRef}
            className="cmdbar-input"
            data-focus-target
            spellCheck={false}
            autoComplete="off"
            placeholder={bar.mode === 'new' ? 'Search or enter URL…' : 'Search or enter URL'}
            value={shown}
            onChange={(e) => {
              const v = e.target.value
              const kind = (e.nativeEvent as InputEvent).inputType ?? ''
              setAllowComplete(!kind.startsWith('delete'))
              setTyped(v)
              setEdited(true)
              setHighlight(v.trim() ? 0 : bar.mode === 'new' ? 0 : -1)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                return close()
              }
              if (e.key === 'Tab' && completion && edited && !e.shiftKey) {
                e.preventDefault()
                setTyped(typed + completion.text)
                setAllowComplete(false)
                return
              }
              if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
                e.preventDefault()
                setHighlight((h) => (rows.length ? (h + 1) % rows.length : -1))
                return
              }
              if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
                e.preventDefault()
                setHighlight((h) => (rows.length ? (h <= 0 ? rows.length - 1 : h - 1) : -1))
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) {
                  const ask = rows.find((r) => r.kind === 'ask')
                  if (ask) pick(ask, false)
                  return
                }
                pick(current, newTabFor(e))
              }
            }}
          />
          <span className="cmdbar-mode">{bar.mode === 'new' ? 'New tab' : 'This tab'}</span>
        </div>
        {rows.length > 0 && (
          <div className="cmdbar-list" ref={listRef}>
            {rows.map((row, i) => (
              <OmniRowView
                key={row.id}
                row={row}
                query={query}
                on={i === highlight}
                onHover={() => setHighlight(i)}
                onPick={(forceNew) => pick(row, bar.mode === 'new' || forceNew)}
              />
            ))}
          </div>
        )}
        <div className="cmdbar-foot">
          <span>
            <kbd>↵</kbd> open
          </span>
          {bar.mode === 'current' && (
            <span>
              <kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}</kbd>
              <kbd>↵</kbd> new tab
            </span>
          )}
          <span>
            <kbd>⇥</kbd> complete
          </span>
          {rows.some((r) => r.kind === 'ask') && (
            <span>
              <kbd>⇧</kbd>
              <kbd>↵</kbd> ask agent
            </span>
          )}
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
