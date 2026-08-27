import { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { hostOf } from './AddressBar'
import TabStrip from '../browser/TabStrip'
import BrowserToolbar from '../browser/BrowserToolbar'
import FindBar from '../browser/FindBar'
import { useFindInPage } from '../browser/useFindInPage'
import { usePaneGeometry } from '../browser/usePaneGeometry'
import { useClosedTabs } from '../browser/useClosedTabs'
import { showTabMenu } from '../browser/tabContextMenu'
import {
  useTabs,
  reviveDeadEnd,
  flatTabsToLayout,
  isNewTabUrl,
  NEW_TAB_URL,
  type FlatTab
} from '../browser/useTabs'
import NewTabPage from '../browser/NewTabPage'
import BookmarkStar, { toggleBookmark } from '../browser/BookmarkStar'
import type { Task, WorkspaceLayout } from '@shared/types'

// The scratchpad's browser: real tabs, address/search bar, back/forward —
// feels like a browser, runs on the same pane engine (so AI page snapshots,
// pinning, and session-saving all keep working).
//
// Tabs persist in the scratch task's layout_json — the SAME shape a workspace
// stores — so "save session" hands the open tabs to the new workspace through
// scratchSave's existing layout handoff, and there is exactly one tab
// persistence format in the app. (They used to live in localStorage; the
// restore below imports that store once, then retires it.)

export interface BrowserTab {
  id: string
  url: string
  title: string
}

export interface ScratchBrowserApi {
  openTab: (url: string) => void
  currentTabs: () => BrowserTab[]
  /** Write any pending layout persist — call before scratchSave reads it. */
  flushLayout: () => Promise<void>
}

const LEGACY_STORE_KEY = 'asit-scratch-tabs'

/**
 * Google refuses to run its sign-in CEREMONY inside any embedded browser (the
 * "this browser or app may not be secure" wall). This is a deliberate
 * account-security control and it applies to every Electron app, not just this
 * one — there is no user-agent or window trick that legitimately clears it.
 *
 * And it cannot be worked around by cookie transfer: the browsers Google
 * TRUSTS (real Chrome) encrypt their cookies against every other app, so ASIT
 * can never read them; the only cookie jar ASIT can read is its own. Those two
 * sets do not overlap, by design.
 *
 * So the honest path for Google specifically is the one the user actually
 * wants: open it in their REAL browser, where they are already trusted and
 * signed in. ASIT keeps hosting everything that does not block.
 */
function isGoogleSigninWall(url: string): boolean {
  return /accounts\.google\.com\/(v3\/signin|signin\/(rejected|identifier)|ServiceLogin)/i.test(
    url
  )
}

/** Where the user was actually trying to go, if the wall URL carries it. */
function signinDestination(wallUrl: string): string {
  try {
    const cont = new URL(wallUrl).searchParams.get('continue')
    if (cont && /^https?:\/\//i.test(cont)) return cont
  } catch {
    // fall through
  }
  return 'https://www.google.com/'
}

/** Stored tabs for this mount: layout_json first, legacy localStorage once. */
function restoreScratchTabs(task: Task): { tabs: FlatTab[]; activeId: string | null } {
  try {
    const layout = JSON.parse(task.layoutJson ?? 'null') as WorkspaceLayout | null
    if (layout?.webTabs) {
      const ids = (layout.slots?.[0] ?? []).filter((id) => !!layout.webTabs?.[id])
      const tabs = ids.map((id) => {
        const url = reviveDeadEnd(layout.webTabs![id], () => NEW_TAB_URL)
        return { id, url, title: isNewTabUrl(url) ? 'New tab' : hostOf(url) }
      })
      if (tabs.length > 0) {
        const active = layout.active?.[0]
        return { tabs, activeId: active && ids.includes(active) ? active : tabs[0].id }
      }
    }
  } catch {
    // corrupt layout — fall through to the legacy store / a fresh tab
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORE_KEY) ?? 'null') as {
      tabs?: { id: string; url: string; title?: string }[]
      active?: number
    } | null
    const tabs = (legacy?.tabs ?? [])
      .filter((t) => /^https?:/i.test(t.url))
      .map((t) => {
        const url = reviveDeadEnd(t.url, () => NEW_TAB_URL)
        // Keep the stored pane id: within a run it revives a parked pane, and
        // a stale id after a restart just opens fresh.
        return { id: t.id, url, title: t.title || hostOf(url) }
      })
    if (tabs.length > 0) {
      return { tabs, activeId: tabs[Math.min(legacy?.active ?? 0, tabs.length - 1)].id }
    }
  } catch {
    // unreadable legacy store — start fresh
  }
  return { tabs: [], activeId: null }
}

export default function ScratchBrowser({
  task,
  onPin,
  onApi
}: {
  /** The scratch task — its id stamps every pane so only the scratchpad's own
   *  chat can see or drive these tabs; its layout_json holds the tabs. */
  task: Task
  onPin: (title: string, url: string) => void
  onApi?: (api: ScratchBrowserApi) => void
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)

  const t = useTabs({
    ownerId: task.id,
    restore: () => restoreScratchTabs(task),
    persist: async (tabs, activeId) => {
      await window.asit.tasks.update(task.id, {
        layoutJson: JSON.stringify(flatTabsToLayout(tabs, activeId))
      })
      // The layout_json is the store now; the legacy key must not resurrect
      // old tabs on the next launch.
      localStorage.removeItem(LEGACY_STORE_KEY)
    },
    emptyUrl: () => NEW_TAB_URL
  })
  const { tabs, activeId, navStates, tabsRef, activeRef, openTab, cycle } = t

  const find = useFindInPage({
    ownsPane: (id) => tabsRef.current.some((tab) => tab.id === id),
    activePaneId: () => activeRef.current
  })

  // Bounds + visibility: single visible view under the toolbar. NTP tabs have
  // no pane at all, so they're simply absent here — when one is active, every
  // real pane is inactive and the DOM new-tab page shows.
  usePaneGeometry(() =>
    tabsRef.current
      .filter((tab) => !isNewTabUrl(tab.url))
      .map((tab) => ({
        id: tab.id,
        active: tab.id === activeRef.current,
        el: contentRef.current
      }))
  )

  const closed = useClosedTabs<string>()
  function closeTab(id: string): void {
    const tab = tabsRef.current.find((x) => x.id === id)
    if (tab) closed.push(tab.url)
    t.closeTab(id)
  }

  useEffect(() => {
    onApi?.({ openTab, currentTabs: () => tabsRef.current, flushLayout: t.flush })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onApi, openTab, t.flush])

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
  useEffect(() => {
    setTabSurface({
      newTab: () => openTab(NEW_TAB_URL),
      closeTab: () => {
        if (activeRef.current) closeTab(activeRef.current)
      },
      reopenTab: () => {
        const url = closed.pop()
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
        if (activeRef.current) find.openFind(activeRef.current)
      },
      copyAddress: () => {
        const tab = tabsRef.current.find((x) => x.id === activeRef.current)
        if (tab && !isNewTabUrl(tab.url)) void navigator.clipboard.writeText(tab.url)
      },
      bookmarkPage: () => {
        const tab = tabsRef.current.find((x) => x.id === activeRef.current)
        if (tab && /^https?:/i.test(tab.url)) void toggleBookmark(tab.url, tab.title)
      }
    })
    return () => setTabSurface(null)
    // openTab/closeTab are stable enough for the lifetime of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTabSurface, openTab])

  async function tabMenu(tab: BrowserTab): Promise<void> {
    const ids = tabsRef.current.map((x) => x.id)
    const at = ids.indexOf(tab.id)
    const ntp = isNewTabUrl(tab.url)
    const picked = await showTabMenu({
      url: ntp ? '' : tab.url,
      canReload: !ntp,
      count: ids.length,
      index: at
    })
    if (!picked) return
    if (picked === 'reload') window.asit.panes.navigate(tab.id, { nav: 'reload' })
    else if (picked === 'duplicate') openTab(tab.url)
    else if (picked === 'copy') void navigator.clipboard.writeText(tab.url)
    else if (picked === 'external') void window.asit.resources.openExternal({ url: tab.url })
    else if (picked === 'close') closeTab(tab.id)
    else if (picked === 'others') t.closeMany(ids.filter((id) => id !== tab.id))
    else if (picked === 'right') t.closeMany(ids.slice(at + 1))
  }

  const active = tabs.find((x) => x.id === activeId) ?? null
  const activeIsNtp = !!active && isNewTabUrl(active.url)
  const nav = active ? navStates[active.id] : null

  return (
    <div
      className="browser"
      data-focus-zone={active && !activeIsNtp ? hostOf(active.url) : 'Browser'}
      data-focus-pane={activeIsNtp ? undefined : active?.id}
    >
      <TabStrip
        tabs={tabs.map((tab) => ({
          id: tab.id,
          label: isNewTabUrl(tab.url) ? 'New tab' : tab.title || hostOf(tab.url),
          tooltip: isNewTabUrl(tab.url) ? 'New tab' : tab.url,
          loading: navStates[tab.id]?.loading,
          favicon: navStates[tab.id]?.favicon,
          glyph: isNewTabUrl(tab.url) ? '＋' : undefined
        }))}
        activeId={activeId}
        onSelect={t.select}
        onClose={closeTab}
        onContextMenu={(id) => {
          const tab = tabsRef.current.find((x) => x.id === id)
          if (tab) void tabMenu(tab)
        }}
        onNewTab={() => openTab(NEW_TAB_URL)}
      />

      <BrowserToolbar
        paneId={activeIsNtp ? null : (active?.id ?? null)}
        nav={activeIsNtp ? null : nav}
        url={activeIsNtp ? '' : (active?.url ?? '')}
        onNavigate={t.navigate}
        className="browser-toolbar"
      >
        {active && !activeIsNtp && (
          <BookmarkStar
            url={active.url}
            title={active.title || active.url}
            favicon={nav?.favicon}
          />
        )}
        <button
          className="nav-btn"
          title="Pin this page to the session (kept when you save it as a task)"
          disabled={!active || activeIsNtp}
          onClick={() => active && onPin(active.title || active.url, active.url)}
        >
          ⌾
        </button>
      </BrowserToolbar>

      {find.findFor && <FindBar find={find} />}

      {(() => {
        const activeUrl = (activeId && (navStates[activeId]?.url ?? tabs.find((x) => x.id === activeId)?.url)) || ''
        if (!isGoogleSigninWall(activeUrl)) return null
        const dest = signinDestination(activeUrl)
        return (
          <div className="signin-handoff">
            <span>
              Google won’t let you sign in inside an app — it blocks every embedded
              browser. Open it in your real browser, where you’re already trusted.
            </span>
            <button
              className="btn btn-primary"
              onClick={() => void window.asit.resources.openExternal({ url: dest })}
            >
              Open in my browser ↗
            </button>
            <button
              className="btn btn-ghost"
              title="Try ASIT’s own sign-in window (shares this profile, but Google may still refuse it)"
              onClick={async () => {
                await window.asit.accounts.openLogin('google')
                if (activeId) window.asit.panes.navigate(activeId, { nav: 'reload' })
              }}
            >
              Try in-app window
            </button>
          </div>
        )
      })()}
      <div className="browser-content" ref={contentRef}>
        {activeIsNtp && <NewTabPage onNavigate={t.navigate} />}
      </div>
    </div>
  )
}
