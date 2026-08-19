import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import AddressBar, { hostOf, toNavUrl } from './AddressBar'
import { IPC } from '@shared/ipc-contract'
import type { PaneNavState } from '@shared/types'

// The scratchpad's browser: real tabs, address/search bar, back/forward —
// feels like a browser, runs on the same pane engine (so AI page snapshots,
// pinning, and session-saving all keep working).

export interface BrowserTab {
  id: string
  url: string
  title: string
}

export interface ScratchBrowserApi {
  openTab: (url: string) => void
  currentTabs: () => BrowserTab[]
}

const HOME_URL = 'https://www.google.com'
const STORE_KEY = 'asit-scratch-tabs'

let tabCounter = 0

export default function ScratchBrowser({
  ownerId,
  onPin,
  onApi
}: {
  /** The scratch task's id — stamped on every pane so only the scratchpad's
   *  own chat can see or drive these tabs. */
  ownerId: string
  onPin: (title: string, url: string) => void
  onApi?: (api: ScratchBrowserApi) => void
}): JSX.Element {
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [navStates, setNavStates] = useState<Record<string, PaneNavState>>({})
  const contentRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<BrowserTab[]>([])
  tabsRef.current = tabs
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  const newTabId = (): string => `scratch-tab-${Date.now()}-${++tabCounter}`

  const openTab = useCallback(
    (url: string): void => {
      const id = newTabId()
      const navUrl = toNavUrl(url || HOME_URL)
      window.asit.panes.open(id, { url: navUrl }, ownerId)
      setTabs((prev) => [...prev, { id, url: navUrl, title: hostOf(navUrl) }])
      setActiveId(id)
    },
    [ownerId]
  )

  // Restore tabs — REUSING stored pane ids, so panes parked while you were in
  // a task revive without reloading.
  useEffect(() => {
    // StrictMode double-mounts effects in dev; a second restore before the
    // persist effect has written localStorage opened duplicate tabs + panes.
    if (tabsRef.current.length > 0) return
    let restored: { tabs?: { id: string; url: string; title?: string }[]; active: number } | null =
      null
    try {
      restored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')
    } catch {
      restored = null
    }
    const stored = (restored?.tabs ?? []).filter((t) => t.id && /^https?:/i.test(t.url))
    if (stored.length === 0) {
      openTab(HOME_URL)
    } else {
      const created: BrowserTab[] = stored.map((t) => {
        window.asit.panes.open(t.id, { url: t.url }, ownerId) // no-op if the pane is parked
        return { id: t.id, url: t.url, title: t.title || hostOf(t.url) }
      })
      setTabs(created)
      setActiveId(created[Math.min(restored?.active ?? 0, created.length - 1)].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist tabs (with pane ids) for next visit.
  useEffect(() => {
    if (tabs.length === 0) return
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
        active: Math.max(0, tabs.findIndex((t) => t.id === activeId))
      })
    )
  }, [tabs, activeId])

  // Bounds + visibility: single visible view under the toolbar.
  //
  // Re-measured after every render, deduped so the IPC only fires on a real
  // change. Same reasoning as the workspace grid: a pane is positioned from a
  // DOM rect, so every layout change has to re-measure, and the set of things
  // that change the layout is not knowable from a dependency list. Getting
  // that wrong puts the page on top of the toolbar, where it silently eats
  // every click.
  const sentGeometry = useRef<Record<string, string>>({})
  const sync = useCallback((): void => {
    const el = contentRef.current
    for (const tab of tabsRef.current) {
      const isActive = tab.id === activeRef.current
      const rect = isActive && el ? el.getBoundingClientRect() : null
      const key = rect
        ? `${isActive}:${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`
        : `${isActive}`
      if (sentGeometry.current[tab.id] === key) continue
      sentGeometry.current[tab.id] = key
      window.asit.panes.setVisible(tab.id, isActive)
      if (rect) {
        window.asit.panes.setBounds(tab.id, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        })
      }
    }
  }, [])

  useLayoutEffect(() => {
    sync()
  })

  useEffect(() => {
    const el = contentRef.current
    const obs = new ResizeObserver(() => sync())
    if (el) obs.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      obs.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [sync])

  // Titles/urls/nav-state from the engine.
  useEffect(() => {
    return window.asit.on(IPC.PANES_DID_NAVIGATE, (...args: unknown[]) => {
      const state = args[0] as PaneNavState
      if (!state.paneId.startsWith('scratch-tab-')) return
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

  useEffect(() => {
    onApi?.({ openTab, currentTabs: () => tabsRef.current })
  }, [onApi, openTab])

  // Home's tabs had NO shortcut access at all — every browser key was wired
  // to the workspace grid. Register as the tab surface while home is on
  // screen so Ctrl+T/W/Tab/R/zoom mean the same thing here.
  const setTabSurface = useStore((st) => st.setTabSurface)
  const closedRef = useRef<string[]>([])
  useEffect(() => {
    setTabSurface({
      newTab: () => openTab(HOME_URL),
      closeTab: () => {
        const id = activeRef.current
        if (!id) return
        const tab = tabsRef.current.find((t) => t.id === id)
        if (tab) closedRef.current = [...closedRef.current, tab.url].slice(-10)
        closeTab(id)
      },
      reopenTab: () => {
        const url = closedRef.current.pop()
        if (url) openTab(url)
      },
      nextTab: () => cycle(1),
      prevTab: () => cycle(-1),
      reload: () => activeRef.current && window.asit.panes.navigate(activeRef.current, { nav: 'reload' }),
      back: () => activeRef.current && window.asit.panes.navigate(activeRef.current, { nav: 'back' }),
      forward: () => activeRef.current && window.asit.panes.navigate(activeRef.current, { nav: 'forward' }),
      zoom: (delta) => {
        if (activeRef.current) void window.asit.panes.zoom(activeRef.current, delta)
      }
    })
    return () => setTabSurface(null)
    // openTab/closeTab are stable enough for the lifetime of this screen.
  }, [setTabSurface, openTab])

  function cycle(dir: 1 | -1): void {
    const list = tabsRef.current
    if (list.length < 2) return
    const at = list.findIndex((t) => t.id === activeRef.current)
    const next = list[(at + dir + list.length) % list.length]
    setActiveId(next.id)
  }

  function closeTab(id: string): void {
    window.asit.panes.close(id)
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeRef.current === id) setActiveId(next[next.length - 1]?.id ?? null)
      if (next.length === 0) localStorage.removeItem(STORE_KEY)
      return next
    })
  }

  function navigate(value: string): void {
    const active = tabs.find((t) => t.id === activeId)
    const url = toNavUrl(value)
    if (active) {
      window.asit.panes.navigate(active.id, { url })
      setTabs((prev) => prev.map((t) => (t.id === active.id ? { ...t, url } : t)))
    } else {
      openTab(url)
    }
  }

  const active = tabs.find((t) => t.id === activeId) ?? null
  const nav = active ? navStates[active.id] : null

  return (
    <div
      className="browser"
      data-focus-zone={active ? hostOf(active.url) : 'Browser'}
      data-focus-pane={active?.id}
    >
      <div className="browser-tabstrip">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`browser-tab ${tab.id === activeId ? 'browser-tab-active' : ''}`}
            onClick={() => {
              setActiveId(tab.id)
            }}
            title={tab.url}
          >
            <span className="browser-tab-title">{tab.title || hostOf(tab.url)}</span>
            <button
              className="tab-btn"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="browser-newtab" title="New tab" onClick={() => openTab(HOME_URL)}>
          +
        </button>
      </div>

      <div className="browser-toolbar">
        <button
          className="nav-btn"
          disabled={!nav?.canGoBack}
          onClick={() => active && window.asit.panes.navigate(active.id, { nav: 'back' })}
        >
          ←
        </button>
        <button
          className="nav-btn"
          disabled={!nav?.canGoForward}
          onClick={() => active && window.asit.panes.navigate(active.id, { nav: 'forward' })}
        >
          →
        </button>
        <button
          className="nav-btn"
          onClick={() => active && window.asit.panes.navigate(active.id, { nav: 'reload' })}
        >
          ⟳
        </button>
        <AddressBar url={active?.url ?? ''} onNavigate={navigate} />
        <button
          className="nav-btn"
          title="Pin this page to the session (kept when you save it as a task)"
          disabled={!active}
          onClick={() => active && onPin(active.title || active.url, active.url)}
        >
          ⌾
        </button>
      </div>

      <div className="browser-content" ref={contentRef} />
    </div>
  )
}
