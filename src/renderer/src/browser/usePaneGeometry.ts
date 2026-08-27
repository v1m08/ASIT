import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

// Bounds + visibility sync for WebContentsView-backed panes.
//
// A pane is positioned from a DOM rect, so ANYTHING that changes the layout
// has to re-measure — and the set of such things is not knowable from a
// dependency list (the page toolbar appears only once a page reports a URL;
// the find bar comes and goes; headers change height). Getting this wrong
// once put a pane on top of its own toolbar, where it silently ate every
// click on back/reload/the address bar — nothing LOOKED wrong, because a
// WebContentsView draws over app DOM without disturbing it.
//
// So: re-measure after EVERY render (useLayoutEffect with no dependency
// array — deliberate), deduped so the IPC only fires when a number actually
// changed. Cheap: a couple of getBoundingClientRect calls per render.

export interface PaneGeometryEntry {
  id: string
  active: boolean
  /** The element whose rect the pane should fill; null when not showing. */
  el: HTMLElement | null
}

export function usePaneGeometry(entries: () => PaneGeometryEntry[]): {
  sync: () => void
  /** Call when main reports a pane died — its replacement starts blank. */
  forget: (id: string) => void
} {
  const sentGeometry = useRef<Record<string, string>>({})
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  const sync = useCallback((): void => {
    for (const { id, active, el } of entriesRef.current()) {
      const rect = active && el ? el.getBoundingClientRect() : null
      const key = rect
        ? `${active}:${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`
        : `${active}`
      if (sentGeometry.current[id] === key) continue
      sentGeometry.current[id] = key
      window.asit.panes.setVisible(id, active)
      if (rect) {
        window.asit.panes.setBounds(id, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        })
      }
    }
  }, [])

  // Content elements can resize without a React render (split drag on a
  // sibling, header wrap). One observer, attached lazily as elements mount —
  // the every-render effect below keeps the observed set current.
  const observerRef = useRef<ResizeObserver | null>(null)
  const observedEls = useRef(new WeakSet<HTMLElement>())

  // No dependency array on purpose — see the header comment. useLayoutEffect
  // so the pane moves in the same frame the layout changed, not one late.
  useLayoutEffect(() => {
    sync()
    observerRef.current ??= new ResizeObserver(() => sync())
    for (const { el } of entriesRef.current()) {
      if (el && !observedEls.current.has(el)) {
        observedEls.current.add(el)
        observerRef.current.observe(el)
      }
    }
  })

  // Window resizes don't re-render React but do move every rect.
  useEffect(() => {
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('resize', sync)
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [sync])

  const forget = useCallback((id: string): void => {
    delete sentGeometry.current[id]
  }, [])

  return { sync, forget }
}
