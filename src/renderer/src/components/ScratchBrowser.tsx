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
 * tab there instead; failing that, start it somewhere neutral.
 */
export function reviveDeadEnd(url: string): string {
  if (!/\/signin\/rejected|\/sorry\/index|accounts\.google\.com\/.*rejected/i.test(url)) {
    return url
  }
  try {
    const target = new URL(url).searchParams.get('continue')
    if (target && /^https?:\/\//i.test(target)) return target
  } catch {
    // malformed — fall through
  }
  return HOME_URL
}

/**
 * Google refuses to run the sign-in CEREMONY (password entry) inside an
 * embedded pane — that is the "this browser may not be secure" wall, and it is
 * a deliberate account-security control, not something to defeat. But ASIT's
 * dedicated login window is a real top-level browser window on the SAME cookie
 * partition as every pane, so a session obtained there is live in the tabs
 * immediately. When a tab hits the wall, offer that door instead of a dead end.
 */
function isGoogleSigninWall(url: string): boolean {
  return /accounts\.google\.com\/(v3\/signin|signin\/(rejected|identifier)|ServiceLogin)/i.test(
    url
  )
}

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
  // Find-in-page: Ctrl+F was simply dead on the Home browser.
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState<{ activeMatch: number; matches: number } | null>(
    null
  )
  const findInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<BrowserTab[]>([])
  tabsRef.current = tabs
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  // Which tab was last auto-scrolled into view (see the tab ref callback).
  const scrolledToRef = useRef<string | null>(null)

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
    const stored = (restored?.tabs ?? [])
      .filter((t) => t.id && /^https?:/i.test(t.url))
      .map((t) => ({ ...t, url: reviveDeadEnd(t.url) }))
    if (stored.length === 0) {
      openTab(HOME_URL)
    } else {
      const created: BrowserTab[] = stored.map((t) => {
        // fresh: this is a RESTORE, so the page must revalidate rather than
        // redraw whatever it looked like when the app last closed.
        window.asit.panes.open(t.id, { url: t.url, fresh: true }, ownerId) // no-op if parked
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

  // Register as the app-wide URL opener while Home is on screen, so history
  // and command-palette clicks open a tab here instead of doing nothing.
  const setUrlOpener = useStore((st) => st.setUrlOpener)
  useEffect(() => {
    setUrlOpener((url) => openTab(url))
    return () => setUrlOpener(null)
  }, [setUrlOpener, openTab])

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
      },
      find: () => {
        setFindOpen(true)
        setTimeout(() => findInputRef.current?.select(), 40)
      },
      copyAddress: () => {
        const tab = tabsRef.current.find((t) => t.id === activeRef.current)
        if (tab) void navigator.clipboard.writeText(tab.url)
      }
    })
    return () => setTabSurface(null)
    // openTab/closeTab are stable enough for the lifetime of this screen.
  }, [setTabSurface, openTab])

  // Ctrl+F pressed while an embedded page held focus (main replays it as an
  // app event), or "Find in page…" from the page's context menu.
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const e = args[0] as { type: string; paneId?: string }
      if (e.type !== 'find-in-page') return
      if (e.paneId && !e.paneId.startsWith('scratch-tab-')) return
      setFindOpen(true)
      setTimeout(() => findInputRef.current?.select(), 40)
    })
  }, [])

  // Find results stream from main as the user types.
  useEffect(() => {
    return window.asit.on(IPC.PANES_FIND_RESULT, (...args: unknown[]) => {
      const r = args[0] as { paneId: string; activeMatch: number; matches: number }
      if (r.paneId !== activeRef.current) return
      setFindResult({ activeMatch: r.activeMatch, matches: r.matches })
    })
  }, [])

  const runFind = useCallback((text: string, findNext: boolean, forward = true): void => {
    const id = activeRef.current
    if (!id) return
    setFindText(text)
    if (!text) setFindResult(null)
    void window.asit.panes.find(id, text, forward, findNext)
  }, [])

  const closeFind = useCallback((): void => {
    const id = activeRef.current
    if (id) void window.asit.panes.findStop(id)
    setFindOpen(false)
    setFindText('')
    setFindResult(null)
  }, [])

  function cycle(dir: 1 | -1): void {
    const list = tabsRef.current
    if (list.length < 2) return
    const at = list.findIndex((t) => t.id === activeRef.current)
    const next = list[(at + dir + list.length) % list.length]
    setActiveId(next.id)
  }

  // Native menu, not an HTML dropdown — the page would paint over a DOM one
  // (invariant 2). Same options as the workspace tab menu where they apply.
  async function tabMenu(tab: BrowserTab): Promise<void> {
    const ids = tabsRef.current.map((t) => t.id)
    const at = ids.indexOf(tab.id)
    const picked = await window.asit.ui.contextMenu([
      { id: 'reload', label: 'Reload' },
      { id: 'duplicate', label: 'Duplicate tab' },
      { separator: true },
      { id: 'copy', label: 'Copy address' },
      { id: 'external', label: 'Open in your default browser' },
      { separator: true },
      { id: 'close', label: 'Close tab' },
      { id: 'others', label: 'Close other tabs', enabled: ids.length > 1 },
      { id: 'right', label: 'Close tabs to the right', enabled: at < ids.length - 1 }
    ])
    if (!picked) return
    if (picked === 'reload') window.asit.panes.navigate(tab.id, { nav: 'reload' })
    else if (picked === 'duplicate') openTab(tab.url)
    else if (picked === 'copy') void navigator.clipboard.writeText(tab.url)
    else if (picked === 'external') void window.asit.resources.openExternal({ url: tab.url })
    else if (picked === 'close') closeTab(tab.id)
    else if (picked === 'others') closeMany(ids.filter((id) => id !== tab.id))
    else if (picked === 'right') closeMany(ids.slice(at + 1))
  }

  // Batch close in ONE state update. Looping closeTab left activeId pointing
  // at a tab a later iteration had closed (activeRef is stale inside a
  // synchronous loop), which blanked the whole browser.
  function closeMany(ids: string[]): void {
    if (ids.length === 0) return
    const doomed = new Set(ids)
    for (const id of ids) window.asit.panes.close(id)
    setTabs((prev) => {
      const next = prev.filter((t) => !doomed.has(t.id))
      if (activeRef.current && doomed.has(activeRef.current)) {
        setActiveId(next[next.length - 1]?.id ?? null)
      }
      if (next.length === 0) localStorage.removeItem(STORE_KEY)
      return next
    })
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
            // Once per activation — inline refs re-run on every render, and
            // nav-state pushes would yank the strip mid-scroll otherwise.
            ref={(el) => {
              if (el && tab.id === activeId && scrolledToRef.current !== tab.id) {
                scrolledToRef.current = tab.id
                el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
              }
            }}
            onClick={() => {
              setActiveId(tab.id)
            }}
            // Middle-click closes, same as the workspace strip.
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeTab(tab.id)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              void tabMenu(tab)
            }}
            title={tab.url}
          >
            <span className="tab-icon">
              {navStates[tab.id]?.loading ? (
                <span className="tab-spinner" />
              ) : navStates[tab.id]?.favicon ? (
                <img
                  className="tab-favicon"
                  src={navStates[tab.id]!.favicon!}
                  alt=""
                  onError={(e) => (e.currentTarget.style.display = 'none')}
                />
              ) : (
                '◍'
              )}
            </span>
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
          title={nav?.loading ? 'Stop loading' : 'Reload'}
          onClick={() =>
            active &&
            window.asit.panes.navigate(active.id, { nav: nav?.loading ? 'stop' : 'reload' })
          }
        >
          {nav?.loading ? '✕' : '⟳'}
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

      {findOpen && (
        <div className="find-bar">
          <input
            ref={findInputRef}
            autoFocus
            placeholder="Find in page…"
            value={findText}
            onChange={(e) => runFind(e.target.value, false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runFind(findText, true, !e.shiftKey)
              }
            }}
          />
          <span className="find-count">
            {findText
              ? findResult && findResult.matches > 0
                ? `${findResult.activeMatch}/${findResult.matches}`
                : findResult
                  ? 'no matches'
                  : '…'
              : ''}
          </span>
          <button
            className="nav-btn"
            title="Previous (Shift+Enter)"
            onClick={() => runFind(findText, true, false)}
          >
            ↑
          </button>
          <button className="nav-btn" title="Next (Enter)" onClick={() => runFind(findText, true, true)}>
            ↓
          </button>
          <button className="nav-btn" title="Close (Esc)" onClick={closeFind}>
            ✕
          </button>
        </div>
      )}

      {(() => {
        const activeUrl = (activeId && (navStates[activeId]?.url ?? tabs.find((t) => t.id === activeId)?.url)) || ''
        if (!isGoogleSigninWall(activeUrl)) return null
        return (
          <div className="signin-handoff">
            <span>
              Google blocks sign-in inside embedded browsers. Sign in through a dedicated window —
              it shares this profile, so you land back here signed in.
            </span>
            <button
              className="btn btn-primary"
              onClick={async () => {
                await window.asit.accounts.openLogin('google')
                // The login window shares the partition, so the cookie is now
                // live; reload the tab from the network to pick it up.
                if (activeId) window.asit.panes.navigate(activeId, { nav: 'reload' })
              }}
            >
              Sign in to Google
            </button>
          </div>
        )
      })()}
      <div className="browser-content" ref={contentRef} />
    </div>
  )
}
