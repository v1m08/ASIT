import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { PaneNavState, WorkspaceLayout } from '@shared/types'
import { hostOf, toNavUrl } from '../components/AddressBar'

// Flat tab-list ownership for a browsing surface: open/close/cycle, nav-state
// tracking, restore and debounced persistence. The workspace grid keeps its
// richer two-slot layout; this is the engine for everything with ONE row of
// tabs (the scratchpad today, any future surface).

export interface FlatTab {
  id: string
  url: string
  title: string
}

// One id mint for every web tab in the app. Shared so a scratch tab's id is a
// first-class web-tab id everywhere — "save session" hands the scratch
// layout_json to the new workspace, and the grid recognizes the ids as its
// own web tabs without a rewrite.
export const WEBTAB_PREFIX = 'webtab-'
let webTabCounter = 0
export const newWebTabId = (): string =>
  `${WEBTAB_PREFIX}${Date.now().toString(36)}-${++webTabCounter}`

// The new-tab page. A tab at this URL is NOT view-backed: no pane is ever
// opened for it, so when it's active every WebContentsView in its area is
// hidden and plain DOM renders there (the builtin-notes pattern — invariant 2
// holds by construction). First navigation converts the tab in place.
export const NEW_TAB_URL = 'asit:newtab'
export const isNewTabUrl = (url: string): boolean => url === NEW_TAB_URL

/**
 * A tab must never restore onto a terminal error page.
 *
 * Google's "Couldn't sign you in" lives at a real URL, so it got saved like
 * any other page and reloaded on every launch — reproducing the same dead end
 * forever and making the whole app look broken, when in fact the session was
 * fine the entire time. Reloading a rejection can only ever produce the
 * rejection again.
 *
 * These pages carry where you were actually going in `continue`, so send the
 * tab there instead; failing that, the caller supplies somewhere neutral.
 */
export function reviveDeadEnd(url: string, fallback: () => string): string {
  if (!/\/signin\/rejected|\/sorry\/index|accounts\.google\.com\/.*rejected/i.test(url)) {
    return url
  }
  try {
    const target = new URL(url).searchParams.get('continue')
    if (target && /^https?:\/\//i.test(target)) return target
  } catch {
    // malformed — fall through
  }
  return fallback()
}

/** Serialize a flat tab list into the same shape a workspace layout uses. */
export function flatTabsToLayout(tabs: FlatTab[], activeId: string | null): WorkspaceLayout {
  return {
    slots: [tabs.map((t) => t.id), []],
    active: [activeId, null],
    split: 0.55,
    collapsed: [false, false],
    direction: 'row',
    webTabs: Object.fromEntries(tabs.map((t) => [t.id, t.url]))
  }
}

export interface UseTabs {
  tabs: FlatTab[]
  activeId: string | null
  navStates: Record<string, PaneNavState>
  tabsRef: React.MutableRefObject<FlatTab[]>
  activeRef: React.MutableRefObject<string | null>
  openTab: (url: string) => void
  closeTab: (id: string) => void
  closeMany: (ids: string[]) => void
  select: (id: string) => void
  cycle: (dir: 1 | -1) => void
  /** Address-bar navigation: reuse the active tab, else open one. */
  navigate: (value: string) => void
  /** Write any pending (debounced) persist NOW; await before reading the
   *  persisted layout elsewhere (e.g. "save session"). */
  flush: () => Promise<void>
}

export function useTabs({
  ownerId,
  restore,
  persist,
  emptyUrl
}: {
  /** Task id stamped on every pane (invariant 6 — pane ownership). */
  ownerId: string
  /** Initial tabs, called once per mount. `fresh` marks an app-restart
   *  restore (pages revalidate) vs a same-run remount (parked panes revive). */
  restore: () => { tabs: FlatTab[]; activeId: string | null }
  persist: (tabs: FlatTab[], activeId: string | null) => Promise<void> | void
  /** Where a brand-new/first tab goes. */
  emptyUrl: () => string
}): UseTabs {
  const [tabs, setTabs] = useState<FlatTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [navStates, setNavStates] = useState<Record<string, PaneNavState>>({})
  const tabsRef = useRef<FlatTab[]>([])
  tabsRef.current = tabs
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  const openTab = useCallback(
    (url: string): void => {
      const id = newWebTabId()
      const raw = url || emptyUrl()
      if (isNewTabUrl(raw)) {
        setTabs((prev) => [...prev, { id, url: NEW_TAB_URL, title: 'New tab' }])
        setActiveId(id)
        return
      }
      const navUrl = toNavUrl(raw)
      window.asit.panes.open(id, { url: navUrl }, ownerId)
      setTabs((prev) => [...prev, { id, url: navUrl, title: hostOf(navUrl) }])
      setActiveId(id)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerId]
  )

  // Restore once per mount — REUSING stored pane ids, so panes parked while
  // the surface was hidden revive without reloading. StrictMode double-mounts
  // effects in dev; the guard stops a second restore duplicating everything.
  useEffect(() => {
    if (tabsRef.current.length > 0) return
    const { tabs: stored, activeId: storedActive } = restore()
    if (stored.length === 0) {
      openTab(emptyUrl())
      return
    }
    for (const t of stored) {
      if (isNewTabUrl(t.url)) continue // NTP tabs never have a pane
      // fresh: a restore must revalidate rather than redraw whatever the page
      // looked like when the app last closed. No-op if the pane is parked.
      window.asit.panes.open(t.id, { url: t.url, fresh: true }, ownerId)
    }
    setTabs(stored)
    setActiveId(storedActive && stored.some((t) => t.id === storedActive) ? storedActive : stored[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist (debounced), flushed on unmount — a dropped pending write is how
  // "the tab I closed came back" bugs happen.
  const persistRef = useRef(persist)
  persistRef.current = persist
  const lastSaved = useRef<string | null>(null)
  const snapshot = useRef<{ tabs: FlatTab[]; activeId: string | null }>({ tabs: [], activeId: null })
  snapshot.current = { tabs, activeId }
  const flush = useCallback(async (): Promise<void> => {
    const key = JSON.stringify(snapshot.current)
    if (key === lastSaved.current) return
    lastSaved.current = key
    await persistRef.current(snapshot.current.tabs, snapshot.current.activeId)
  }, [])
  useEffect(() => {
    const t = setTimeout(() => void flush(), 500)
    return () => clearTimeout(t)
  }, [tabs, activeId, flush])
  useEffect(() => {
    return () => void flush()
  }, [flush])

  // Titles/urls/nav-state from the engine, for OUR tabs only.
  useEffect(() => {
    return window.asit.on(IPC.PANES_DID_NAVIGATE, (...args: unknown[]) => {
      const state = args[0] as PaneNavState
      if (!tabsRef.current.some((t) => t.id === state.paneId)) return
      setNavStates((prev) => ({ ...prev, [state.paneId]: state }))
      setTabs((prev) =>
        prev.map((t) =>
          t.id === state.paneId
            ? { ...t, url: state.url || t.url, title: state.title || hostOf(state.url || t.url) }
            : t
        )
      )
    })
  }, [])

  // Batch close in ONE state update. Looping closeTab left activeId pointing
  // at a tab a later iteration had closed (activeRef is stale inside a
  // synchronous loop), which blanked the whole surface.
  const closeMany = useCallback((ids: string[]): void => {
    if (ids.length === 0) return
    const doomed = new Set(ids)
    for (const id of ids) window.asit.panes.close(id)
    setTabs((prev) => {
      const next = prev.filter((t) => !doomed.has(t.id))
      if (activeRef.current && doomed.has(activeRef.current)) {
        setActiveId(next[next.length - 1]?.id ?? null)
      }
      return next
    })
  }, [])

  const closeTab = useCallback((id: string): void => closeMany([id]), [closeMany])

  const cycle = useCallback((dir: 1 | -1): void => {
    const list = tabsRef.current
    if (list.length < 2) return
    const at = list.findIndex((t) => t.id === activeRef.current)
    setActiveId(list[(at + dir + list.length) % list.length].id)
  }, [])

  const navigate = useCallback(
    (value: string): void => {
      const active = tabsRef.current.find((t) => t.id === activeRef.current)
      const url = toNavUrl(value)
      if (active && isNewTabUrl(active.url)) {
        // Convert the NTP tab in place: its first navigation is what creates
        // the pane (same id, so the tab just "becomes" a page).
        window.asit.panes.open(active.id, { url }, ownerId)
        setTabs((prev) =>
          prev.map((t) => (t.id === active.id ? { ...t, url, title: hostOf(url) } : t))
        )
      } else if (active) {
        window.asit.panes.navigate(active.id, { url })
        setTabs((prev) => prev.map((t) => (t.id === active.id ? { ...t, url } : t)))
      } else {
        openTab(url)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openTab, ownerId]
  )

  return {
    tabs,
    activeId,
    navStates,
    tabsRef,
    activeRef,
    openTab,
    closeTab,
    closeMany,
    select: setActiveId,
    cycle,
    navigate,
    flush
  }
}
