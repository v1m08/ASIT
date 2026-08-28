import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { PaneNavState, Resource, Task, WorkspaceLayout } from '@shared/types'
import NotesEditor from './NotesEditor'
import TerminalPane from './TerminalPane'
import AppWindowPane from './AppWindowPane'
import ReviewPane from './ReviewPane'
import { useStore } from '../store/useStore'
import { useFileDrop } from '../hooks/useFileDrop'
import { hostOf, toNavUrl } from './AddressBar'
import { useOverlay } from '../hooks/useOverlay'
import { searchUrl } from '../lib/search'
import { childPath } from '../utils/paths'
import TabStrip, { type TabDescriptor } from '../browser/TabStrip'
import {
  WEBTAB_PREFIX,
  newWebTabId,
  reviveDeadEnd,
  isNewTabUrl,
  NEW_TAB_URL
} from '../browser/useTabs'
import NewTabPage from '../browser/NewTabPage'
import BrowserToolbar from '../browser/BrowserToolbar'
import FindBar from '../browser/FindBar'
import { useFindInPage } from '../browser/useFindInPage'
import { usePaneGeometry } from '../browser/usePaneGeometry'
import { useClosedTabs } from '../browser/useClosedTabs'
import { showTabMenu } from '../browser/tabContextMenu'
import BookmarkStar, { toggleBookmark } from '../browser/BookmarkStar'

export const BUILTIN_NOTES = 'builtin-notes'
// Retired id, kept ONLY so old saved layouts migrate (see the layout parser
// below) — the single search pane it named no longer exists.
export const BUILTIN_SEARCH = 'builtin-search'
export const BUILTIN_REVIEW = 'builtin-review'
export const BUILTIN_TERMINAL = 'builtin-terminal'
export const BUILTIN_APP = 'builtin-app'

// Ad-hoc browser tabs. The workspace used to have exactly ONE web surface
// (the search pane): Ctrl+T and "open link in new tab" both navigated it,
// clobbering whatever page was showing. Web tabs are real tabs — as many as
// you like, URLs persisted in the layout so they survive a restart. Ids come
// from the shared mint in browser/useTabs so scratch tabs hand over cleanly.

const DEFAULT_LAYOUT: WorkspaceLayout = {
  slots: [[], []],
  active: [null, null],
  split: 0.55,
  collapsed: [false, false],
  direction: 'row',
  webTabs: {}
}

interface TabInfo {
  id: string
  title: string
  kind:
    | 'url'
    | 'ntp'
    | 'pdf'
    | 'note'
    | 'file'
    | 'builtin-note'
    | 'builtin-review'
    | 'builtin-terminal'
    | 'builtin-app'
  viewBacked: boolean
  resource: Resource | null
}

function clampSplit(v: number): number {
  if (!Number.isFinite(v)) return 0.55 // NaN from corrupted layout_json collapses both slots
  return Math.min(0.8, Math.max(0.2, v))
}

export function tabInfoFor(
  id: string,
  task: Task,
  resources: Resource[],
  webTabs?: Record<string, string>
): TabInfo | null {
  if (id === BUILTIN_NOTES) {
    return { id, title: 'Notes', kind: 'builtin-note', viewBacked: false, resource: null }
  }
  if (id.startsWith(WEBTAB_PREFIX)) {
    const url = webTabs?.[id]
    if (!url) return null
    if (isNewTabUrl(url)) {
      // The new-tab page: DOM, no pane — the pane appears when the user
      // navigates and the stored URL stops being the sentinel.
      return { id, title: 'New tab', kind: 'ntp', viewBacked: false, resource: null }
    }
    return { id, title: hostOf(url), kind: 'url', viewBacked: true, resource: null }
  }
  if (id === BUILTIN_REVIEW) {
    // Study tools off ⇒ the review tab simply doesn't exist; validLayout
    // prunes it from stored layouts (reopen it from the rail if re-enabled).
    if (!(useStore.getState().settings?.studyEnabled ?? true)) return null
    return { id, title: 'Review', kind: 'builtin-review', viewBacked: false, resource: null }
  }
  if (id === BUILTIN_TERMINAL) {
    return { id, title: 'Terminal', kind: 'builtin-terminal', viewBacked: false, resource: null }
  }
  if (id === BUILTIN_APP) {
    return { id, title: 'App', kind: 'builtin-app', viewBacked: false, resource: null }
  }
  const r = resources.find((res) => res.id === id)
  if (!r) return null
  return {
    id,
    title: r.title,
    kind: r.kind,
    viewBacked: r.kind === 'url' || r.kind === 'pdf' || r.kind === 'file',
    resource: r
  }
}

function paneTargetFor(tab: TabInfo): { url?: string; filePath?: string } {
  if (tab.resource?.kind === 'url' && tab.resource.url) return { url: tab.resource.url }
  if (tab.resource?.filePath) return { filePath: tab.resource.filePath }
  return {}
}

export interface PaneGridApi {
  openResource: (id: string) => void
  openSearch: (query: string) => void
  // Ctrl/middle-click, or "open link in new tab" from the context menu.
  openUrl: (url: string) => void
}

export default function PaneGrid({
  task,
  resources,
  onApi,
  onPin,
  onAttachLibrary,
  onResourcesChanged
}: {
  task: Task
  resources: Resource[]
  onApi?: (api: PaneGridApi) => void
  onPin?: (title: string, url: string) => void
  // Dropping a global library file attaches a copy to this workspace first.
  onAttachLibrary?: (name: string) => Promise<Resource | null>
  // Files dropped from Explorer become resources, so the rail must reload.
  onResourcesChanged?: () => Promise<void>
}): JSX.Element {
  const [layout, setLayout] = useState<WorkspaceLayout>(() => {
    if (task.layoutJson) {
      try {
        const parsed = JSON.parse(task.layoutJson) as WorkspaceLayout
        // Migrate the retired single search pane: layouts saved before web
        // tabs existed may still hold a `builtin-search` id. It becomes an
        // ordinary web tab, and the special case disappears from the rest of
        // the component.
        const webTabs: Record<string, string> = {}
        for (const [id, url] of Object.entries(parsed.webTabs ?? {})) {
          // Never restore onto a sign-in dead end (see reviveDeadEnd) — the
          // scratchpad learned this the hard way; workspaces get it too.
          webTabs[id] = reviveDeadEnd(url, () => NEW_TAB_URL)
        }
        const migrate = (id: string): string => {
          if (id !== BUILTIN_SEARCH) return id
          const fresh = newWebTabId()
          webTabs[fresh] = NEW_TAB_URL
          return fresh
        }
        const slots: [string[], string[]] = [
          (parsed.slots?.[0] ?? []).map(migrate),
          (parsed.slots?.[1] ?? []).map(migrate)
        ]
        const active: [string | null, string | null] = [
          parsed.active?.[0] === BUILTIN_SEARCH ? null : (parsed.active?.[0] ?? null),
          parsed.active?.[1] === BUILTIN_SEARCH ? null : (parsed.active?.[1] ?? null)
        ]
        return {
          slots,
          active,
          split: clampSplit(parsed.split ?? 0.55),
          collapsed: [parsed.collapsed?.[0] ?? false, parsed.collapsed?.[1] ?? false],
          direction: parsed.direction === 'column' ? 'column' : 'row',
          webTabs
        }
      } catch {
        return DEFAULT_LAYOUT
      }
    }
    return DEFAULT_LAYOUT
  })
  const [navStates, setNavStates] = useState<Record<string, PaneNavState>>({})
  const [dragging, setDragging] = useState(false)
  const dragItem = useStore((st) => st.dragItem)
  const setDragItem = useStore((st) => st.setDragItem)
  const [dropTarget, setDropTarget] = useState<0 | 1 | null>(null)
  const [zoomLabel, setZoomLabel] = useState<number | null>(null)
  // Ctrl+Shift+T: recently closed tabs. Resources reopen by id; web tabs by
  // the URL they were on when closed (the id's pane is gone for good).
  const closedTabs = useClosedTabs<{ id?: string; url?: string }>()
  const hidePin = useStore((st) => st.settings?.hidePin ?? false)
  const studyEnabled = useStore((st) => st.settings?.studyEnabled ?? true)
  // A page painted over the slot would eat every drag event, so the views go
  // away for the duration of the drag — same rule as any overlay (invariant 2).
  useOverlay(dragItem !== null)
  const gridRef = useRef<HTMLDivElement>(null)
  const slotContentRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const openedPanes = useRef(new Set<string>())
  // Bumped when main reports a pane died on its own (LRU eviction, crash).
  // The open-effect depends on this, so the tab gets re-opened rather than
  // sitting there blank.
  const [paneEpoch, setPaneEpoch] = useState(0)

  // Prune tabs whose resources were removed.
  const validLayout = useMemo((): WorkspaceLayout => {
    const valid = (id: string): boolean => !!tabInfoFor(id, task, resources, layout.webTabs)
    const slots: [string[], string[]] = [
      layout.slots[0].filter(valid),
      layout.slots[1].filter(valid)
    ]
    // Web-tab URLs only for tabs that still exist — closed ones must not
    // accumulate in the persisted layout forever.
    const webTabs: Record<string, string> = {}
    for (const id of [...slots[0], ...slots[1]]) {
      if (layout.webTabs?.[id]) webTabs[id] = layout.webTabs[id]
    }
    // Normalize: if only the second slot has tabs, promote them to the first —
    // a lone tab should always occupy the full area, never sit beside an
    // empty pane it can't close.
    if (slots[0].length === 0 && slots[1].length > 0) {
      slots[0] = slots[1]
      slots[1] = []
    }
    const pickActive = (slot: string[], preferred: (string | null)[]): string | null => {
      for (const p of preferred) {
        if (p && slot.includes(p)) return p
      }
      return slot[0] ?? null
    }
    const active: [string | null, string | null] = [
      pickActive(slots[0], [layout.active[0], layout.active[1]]),
      pickActive(slots[1], [layout.active[1]])
    ]
    // A slot may only stay collapsed while the other slot has something to show.
    const rawCollapsed = layout.collapsed ?? [false, false]
    const collapsed: [boolean, boolean] = [
      rawCollapsed[0] && slots[1].length > 0,
      rawCollapsed[1] && slots[0].length > 0
    ]
    if (collapsed[0] && collapsed[1]) collapsed[1] = false
    return {
      slots,
      active,
      split: layout.split,
      collapsed,
      direction: layout.direction ?? 'row',
      webTabs
    }
    // studyEnabled: tabInfoFor consults it (review tab existence).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, task, resources, studyEnabled])

  // The valid layout, reachable from stable callbacks without a stale closure.
  const layoutRef = useRef(validLayout)
  layoutRef.current = validLayout
  // Same, for engine-reported nav state. The tab SURFACE (the object shortcuts
  // dispatch through) is captured in the store, so anything it reads out of a
  // render closure is a snapshot of whenever it was last registered — which is
  // how Ctrl+D pressed just after a page opened could silently do nothing.
  // Every live read goes through these refs.
  const navStatesRef = useRef(navStates)
  navStatesRef.current = navStates

  /**
   * What to call a tab. A web tab is named by the PAGE, like every browser:
   * the resource title is only its bookmark name, so a tab opened as "Google"
   * still said "Google" three articles later. Non-web tabs keep their given
   * name. One function, because three call sites naming tabs three ways is
   * how they drifted apart in the first place.
   */
  const tabLabel = useCallback(
    (tab: TabInfo): string => {
      if (tab.kind !== 'url') return tab.title
      const live = navStates[tab.id]?.title?.trim()
      return live && live !== 'about:blank' ? live : tab.title
    },
    [navStates]
  )

  /**
   * Files dropped on a tab strip: copied into the task folder, pinned, and
   * opened right there. Deliberately NOT on the page area — those pixels
   * belong to the embedded page, and stealing its drops would break dragging
   * an attachment into Gmail, which is a thing a browser has to get right.
   */
  const dropFilesIntoSlot = useCallback(
    async (slotIndex: number, paths: string[]): Promise<void> => {
      const added = await window.asit.resources.addFiles(task.id, paths)
      if (!added || added.length === 0) return
      await onResourcesChanged?.()
      setLayout((prev) => {
        const slots: [string[], string[]] = [[...prev.slots[0]], [...prev.slots[1]]]
        for (const r of added) if (!slots[slotIndex].includes(r.id)) slots[slotIndex].push(r.id)
        const active: [string, string] = [...prev.active] as [string, string]
        active[slotIndex] = added[added.length - 1].id
        return { ...prev, slots, active }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.id, onResourcesChanged]
  )

  // One hook per slot: renderSlot is a plain function, so the hooks have to
  // live at the top level and be picked by index inside it.
  const slot0Drop = useFileDrop((paths) => void dropFilesIntoSlot(0, paths))
  const slot1Drop = useFileDrop((paths) => void dropFilesIntoSlot(1, paths))

  // Open view-backed panes that appear in the layout.
  useEffect(() => {
    for (const slot of validLayout.slots) {
      for (const id of slot) {
        const tab = tabInfoFor(id, task, resources, validLayout.webTabs)
        if (tab?.viewBacked && !openedPanes.current.has(id)) {
          openedPanes.current.add(id)
          const target = id.startsWith(WEBTAB_PREFIX)
            ? { url: validLayout.webTabs?.[id] }
            : paneTargetFor(tab)
          window.asit.panes.open(id, target, task.id)
        }
      }
    }
  }, [validLayout, task, resources, paneEpoch])

  // Close panes for tabs no longer in any slot.
  useEffect(() => {
    const inLayout = new Set([...validLayout.slots[0], ...validLayout.slots[1]])
    for (const id of [...openedPanes.current]) {
      if (!inLayout.has(id)) {
        openedPanes.current.delete(id)
        window.asit.panes.close(id)
      }
    }
  }, [validLayout])

  // Visibility + bounds: for each slot, only the active view-backed tab shows.
  // The re-measure-every-render machinery (and the reasoning for it) lives in
  // usePaneGeometry; this just describes what should be where.
  const geometry = usePaneGeometry(() => {
    const entries: { id: string; active: boolean; el: HTMLElement | null }[] = []
    validLayout.slots.forEach((slot, i) => {
      const activeId = validLayout.active[i]
      const slotCollapsed = validLayout.collapsed?.[i] ?? false
      for (const id of slot) {
        const tab = tabInfoFor(id, task, resources, validLayout.webTabs)
        if (!tab?.viewBacked) continue
        const isActive = id === activeId && !slotCollapsed
        entries.push({ id, active: isActive, el: isActive ? slotContentRefs[i].current : null })
      }
    })
    return entries
  })

  // Pane navigation state pushes (title, url, back/forward).
  useEffect(() => {
    return window.asit.on(IPC.PANES_DID_NAVIGATE, (...args: unknown[]) => {
      const state = args[0] as PaneNavState
      setNavStates((prev) => ({ ...prev, [state.paneId]: state }))
      // Track where each web tab has wandered, so reopening the workspace
      // restores the page you were actually on — not where the tab started.
      if (state.paneId.startsWith(WEBTAB_PREFIX) && /^https?:/i.test(state.url)) {
        setLayout((prev) =>
          prev.webTabs?.[state.paneId] && prev.webTabs[state.paneId] !== state.url
            ? { ...prev, webTabs: { ...prev.webTabs, [state.paneId]: state.url } }
            : prev
        )
      }
    })
  }, [])

  // A pane main destroyed by itself. Forget it so the open-effect re-creates
  // it; without this the tab is permanently blank.
  useEffect(() => {
    return window.asit.on(IPC.PANES_GONE, (...args: unknown[]) => {
      const { paneId } = args[0] as { paneId: string }
      if (!openedPanes.current.delete(paneId)) return
      // The replacement view starts with no bounds, so forget what we sent.
      geometry.forget(paneId)
      setNavStates((prev) => {
        const next = { ...prev }
        delete next[paneId]
        return next
      })
      setPaneEpoch((n) => n + 1)
    })
  }, [])

  // Persist layout (debounced), and FLUSH on unmount — otherwise closing a
  // tab and immediately navigating away dropped the pending write and the
  // tab reappeared next open.
  const lastSavedLayout = useRef<string | null>(task.layoutJson)
  const latestLayout = useRef('')
  latestLayout.current = JSON.stringify(validLayout)

  useEffect(() => {
    const t = setTimeout(() => {
      if (latestLayout.current !== lastSavedLayout.current) {
        lastSavedLayout.current = latestLayout.current
        window.asit.tasks.update(task.id, { layoutJson: latestLayout.current })
      }
    }, 500)
    return () => clearTimeout(t)
  }, [validLayout, task.id])

  useEffect(() => {
    return () => {
      if (latestLayout.current !== lastSavedLayout.current) {
        window.asit.tasks.update(task.id, { layoutJson: latestLayout.current })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openResource = useCallback(
    (id: string): void => {
      setLayout((prev) => {
        // Already open somewhere? Just focus it.
        for (const i of [0, 1] as const) {
          if (prev.slots[i].includes(id)) {
            const active: [string | null, string | null] = [...prev.active]
            active[i] = id
            const collapsed: [boolean, boolean] = [...(prev.collapsed ?? [false, false])]
            collapsed[i] = false
            return { ...prev, active, collapsed }
          }
        }
        const slots: [string[], string[]] = [[...prev.slots[0]], [...prev.slots[1]]]
        slots[0].push(id)
        const collapsed: [boolean, boolean] = [...(prev.collapsed ?? [false, false])]
        collapsed[0] = false // opening a resource reveals its slot
        return { ...prev, slots, active: [id, prev.active[1]], collapsed }
      })
    },
    [setLayout]
  )

  // Drop target version of openResource: put the tab in a CHOSEN slot, moving
  // it out of the other one so dragging between slots works as expected.
  const openResourceInSlot = useCallback(
    (id: string, slotIndex: 0 | 1): void => {
      setLayout((prev) => {
        const slots: [string[], string[]] = [
          prev.slots[0].filter((x) => x !== id),
          prev.slots[1].filter((x) => x !== id)
        ]
        slots[slotIndex].push(id)
        const active: [string | null, string | null] = [...prev.active]
        active[slotIndex] = id
        // The slot it came from may have lost its active tab.
        const other = slotIndex === 0 ? 1 : 0
        if (!active[other] || !slots[other].includes(active[other]!)) {
          active[other] = slots[other][slots[other].length - 1] ?? null
        }
        const collapsed: [boolean, boolean] = [...(prev.collapsed ?? [false, false])]
        collapsed[slotIndex] = false
        return { ...prev, slots, active, collapsed }
      })
    },
    [setLayout]
  )

  const handleDrop = useCallback(
    async (slotIndex: 0 | 1): Promise<void> => {
      const item = useStore.getState().dragItem
      setDragItem(null)
      setDropTarget(null)
      if (!item) return
      if (item.kind === 'resource') {
        openResourceInSlot(item.value, slotIndex)
        return
      }
      // Global library file: attach a copy to this workspace, then show it.
      const resource = await onAttachLibrary?.(item.value)
      if (resource) openResourceInSlot(resource.id, slotIndex)
    },
    [onAttachLibrary, openResourceInSlot, setDragItem]
  )

  // Zoom-level toast (Ctrl+± replayed from a focused page).
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const e = args[0] as { type: string; zoom?: number }
      if (e.type === 'pane-zoom' && typeof e.zoom === 'number') {
        setZoomLabel(Math.round(100 * Math.pow(1.2, e.zoom)))
        setTimeout(() => setZoomLabel(null), 1400)
      }
    })
  }, [])

  // The slot the user last interacted with (clicked a tab, focused a pane).
  // Every keyboard shortcut and new-tab action acts HERE — they used to
  // hard-code slot 0, so in a split Ctrl+W/Ctrl+Tab/Ctrl+R always hit the
  // left pane regardless of which one you were actually using.
  const focusedSlotRef = useRef<0 | 1>(0)
  const focusSlot = useCallback((): 0 | 1 => {
    const want = focusedSlotRef.current
    if (layoutRef.current.active[want]) return want
    return layoutRef.current.active[want === 0 ? 1 : 0] ? (want === 0 ? 1 : 0) : 0
  }, [])
  useEffect(() => {
    return window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const e = args[0] as { type: string; paneId?: string }
      if (e.type !== 'pane-focused' || !e.paneId) return
      const at = layoutRef.current.slots.findIndex((s) => s.includes(e.paneId!))
      if (at === 0 || at === 1) focusedSlotRef.current = at
    })
  }, [])

  // Find-in-page + zoom: the browser basics panes were missing. Only one
  // browsing surface is mounted at a time, so any find event that reaches us
  // is ours.
  const find = useFindInPage({
    ownsPane: () => true,
    activePaneId: () => layoutRef.current.active[focusSlot()]
  })

  /**
   * A NEW browser tab, in the slot the user is browsing in. This is what
   * Ctrl+T, ctrl+click, and "open link in new tab" reach — they used to all
   * navigate the single search pane, replacing whatever it was showing.
   */
  const openWebTab = useCallback(
    (url: string, inSlot?: 0 | 1): void => {
      const id = newWebTabId()
      setLayout((prev) => {
        const viewBackedAt = (i: 0 | 1): boolean => {
          const a = prev.active[i]
          return !!a && !!tabInfoFor(a, task, resources, prev.webTabs)?.viewBacked
        }
        // "The slot the user is browsing in" means the FOCUSED slot first —
        // preferring slot 0 outright sent ctrl+clicked links from the right
        // pane to the left one.
        const focused = focusedSlotRef.current
        const other: 0 | 1 = focused === 0 ? 1 : 0
        const slotIndex: 0 | 1 =
          inSlot ?? (viewBackedAt(focused) ? focused : viewBackedAt(other) ? other : focused)
        focusedSlotRef.current = slotIndex
        const slots: [string[], string[]] = [[...prev.slots[0]], [...prev.slots[1]]]
        slots[slotIndex].push(id)
        const active: [string | null, string | null] = [...prev.active]
        active[slotIndex] = id
        const collapsed: [boolean, boolean] = [...(prev.collapsed ?? [false, false])]
        collapsed[slotIndex] = false
        return { ...prev, slots, active, collapsed, webTabs: { ...prev.webTabs, [id]: url } }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.id, resources]
  )

  const openSearch = useCallback(
    (query: string): void => {
      if (!query.trim()) {
        openWebTab(NEW_TAB_URL)
        return
      }
      const url = searchUrl(query.trim())
      // Like a browser's address bar: searching reuses the tab you're on if
      // it's a web tab; otherwise (notes, a PDF) the results open beside it.
      // "The tab you're on" = the FOCUSED slot's active tab, not slot 0's —
      // in a split that distinction is the whole point (see focusSlot).
      const activeId = layoutRef.current.active[focusSlot()]
      if (activeId && activeId.startsWith(WEBTAB_PREFIX)) {
        if (isNewTabUrl(layoutRef.current.webTabs?.[activeId] ?? '')) {
          // The NTP has no pane yet — updating the stored URL converts it,
          // and the open-effect creates the pane.
          setLayout((prev) => ({ ...prev, webTabs: { ...prev.webTabs, [activeId]: url } }))
          return
        }
        window.asit.panes.navigate(activeId, { url })
        setLayout((prev) => ({ ...prev, webTabs: { ...prev.webTabs, [activeId]: url } }))
        return
      }
      openWebTab(url)
    },
    [openWebTab, focusSlot]
  )

  const openUrl = useCallback((url: string): void => openWebTab(url), [openWebTab])

  // A browser always has a tab. This surface used to be a workspace grid, so
  // an empty group rendered a bare "nothing open" slot — which, now that every
  // group is browsed through here (including a brand-new one), read as a
  // broken window rather than a fresh browser. Open the new-tab page instead;
  // it costs no pane (invariant 2's builtin-notes pattern) and is where the
  // address bar and the dashboard live.
  const openedFirstTab = useRef(false)
  useEffect(() => {
    if (openedFirstTab.current) return
    if (layout.slots[0].length > 0 || layout.slots[1].length > 0) {
      openedFirstTab.current = true
      return
    }
    openedFirstTab.current = true
    openWebTab(NEW_TAB_URL, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard shortcuts fire from a listener registered once, so they reach the
  // CURRENT versions of these through refs rather than a stale closure.
  const openResourceRef = useRef(openResource)
  const openWebTabRef = useRef(openWebTab)
  const closeActiveTabRef = useRef<(() => void) | null>(null)
  const cycleTabRef = useRef<((dir: 1 | -1) => void) | null>(null)
  openResourceRef.current = openResource
  openWebTabRef.current = openWebTab
  closeActiveTabRef.current = () => {
    const slot = focusSlot()
    const id = validLayout.active[slot]
    if (id) closeTab(slot, id)
  }
  cycleTabRef.current = (dir) => {
    const slot = focusSlot()
    const tabs = validLayout.slots[slot]
    if (tabs.length < 2) return
    const at = tabs.indexOf(validLayout.active[slot] ?? '')
    const next = tabs[(at + dir + tabs.length) % tabs.length]
    selectTab(slot, next)
  }

  useEffect(() => {
    onApi?.({ openResource, openSearch, openUrl })
  }, [onApi, openResource, openSearch, openUrl])

  // Right-click a tab; the shared builder keeps the two surfaces' menus in
  // sync (and native, per invariant 2).
  const tabMenu = useCallback(
    async (slotIndex: 0 | 1, tab: TabInfo): Promise<void> => {
      const ids = validLayout.slots[slotIndex]
      const at = ids.indexOf(tab.id)
      const rawUrl =
        navStates[tab.id]?.url ?? tab.resource?.url ?? validLayout.webTabs?.[tab.id] ?? ''
      const url = isNewTabUrl(rawUrl) ? '' : rawUrl
      const picked = await showTabMenu({
        url,
        canReload: tab.viewBacked,
        count: ids.length,
        index: at,
        canMove: true
      })
      if (!picked) return
      if (picked === 'reload') window.asit.panes.navigate(tab.id, { nav: 'reload' })
      else if (picked === 'copy') void navigator.clipboard.writeText(url)
      else if (picked === 'external') void window.asit.resources.openExternal({ url })
      else if (picked === 'move') moveTab(slotIndex, tab.id)
      else if (picked === 'close') closeTab(slotIndex, tab.id)
      else if (picked === 'duplicate') {
        if (url) openUrl(url)
      } else if (picked === 'others') {
        for (const id of [...ids]) if (id !== tab.id) closeTab(slotIndex, id)
      } else if (picked === 'right') {
        for (const id of ids.slice(at + 1)) closeTab(slotIndex, id)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [validLayout, navStates, openUrl]
  )

  // Publish what the user is looking at, so shell chrome can react to the page
  // without reaching into this component (see store.setActivePage).
  useEffect(() => {
    const id = validLayout.active[focusSlot()]
    const url = id
      ? (navStates[id]?.url ?? validLayout.webTabs?.[id] ?? tabInfoFor(id, task, resources, validLayout.webTabs)?.resource?.url ?? null)
      : null
    useStore.getState().setActivePage(id ?? null, url && !isNewTabUrl(url) ? url : null)
  }, [validLayout, navStates, task, resources, focusSlot])
  useEffect(() => {
    return () => useStore.getState().setActivePage(null, null)
  }, [])

  // Claim the tab surface while this workspace is on screen, so the shared
  // shortcut dispatcher drives THESE tabs.
  const setTabSurface = useStore((st) => st.setTabSurface)
  useEffect(() => {
    // Live reads (layoutRef/navStatesRef), never the render closure — see the
    // note by navStatesRef.
    const activePaneId = (): string | null => {
      const live = layoutRef.current
      const id = live.active[focusSlot()]
      return id && tabInfoFor(id, task, resources, live.webTabs)?.viewBacked ? id : null
    }
    /** Where the active tab is, preferring the engine and falling back to the
     *  layout for a page too young to have reported in yet.
     *
     *  The engine pushes a nav state as soon as the pane exists, and that
     *  FIRST push carries an empty url — so `??` (which only falls through on
     *  null/undefined) kept the empty string and every caller concluded there
     *  was no page. That is why Ctrl+D and copy-address did nothing for the
     *  first moment of a tab's life. Fall back on any falsy value, not just
     *  null. */
    const activeUrl = (): string | null => {
      const id = activePaneId()
      if (!id) return null
      const url = navStatesRef.current[id]?.url || layoutRef.current.webTabs?.[id] || null
      return url && !isNewTabUrl(url) ? url : null
    }
    setTabSurface({
      newTab: () => openWebTabRef.current?.(NEW_TAB_URL),
      closeTab: () => closeActiveTabRef.current?.(),
      reopenTab: () => {
        const gone = closedTabs.pop()
        if (gone?.url) openWebTabRef.current?.(gone.url)
        else if (gone?.id) openResourceRef.current?.(gone.id)
      },
      nextTab: () => cycleTabRef.current?.(1),
      prevTab: () => cycleTabRef.current?.(-1),
      reload: () => {
        const id = activePaneId()
        if (id) window.asit.panes.navigate(id, { nav: 'reload' })
      },
      back: () => {
        const id = activePaneId()
        if (id) window.asit.panes.navigate(id, { nav: 'back' })
      },
      forward: () => {
        const id = activePaneId()
        if (id) window.asit.panes.navigate(id, { nav: 'forward' })
      },
      zoom: (delta) => {
        const id = activePaneId()
        if (id) void window.asit.panes.zoom(id, delta).then((z) => {
          setZoomLabel(Math.round(100 * Math.pow(1.2, z)))
          setTimeout(() => setZoomLabel(null), 1400)
        })
      },
      find: () => {
        const id = validLayout.active[focusSlot()]
        if (id) find.openFind(id)
      },
      // Everything below used to need a mouse.
      //
      // Both resolve the URL from the LAYOUT when the engine's nav-state has
      // not landed yet: a tab that was just opened (or converted from the
      // new-tab page) already knows where it is going, and Ctrl+D silently
      // doing nothing for the first second of a page's life is a bug.
      bookmarkPage: () => {
        const id = activePaneId()
        const url = activeUrl()
        const nav = id ? navStatesRef.current[id] : null
        if (url && /^https?:/i.test(url)) void toggleBookmark(url, nav?.title || url, nav?.favicon)
      },
      copyAddress: () => {
        const url = activeUrl()
        if (url) void navigator.clipboard.writeText(url)
      },
      addFile: () => {
        void window.asit.resources.addPdf(task.id).then(() => onResourcesChanged?.())
      },
      // One key both splits and unsplits: with one slot in use it moves the
      // active tab across, and with two it collapses back to one.
      toggleSplit: () => {
        setLayout((prev) => {
          const [a, b] = prev.slots
          if (b.length > 0) {
            // Fold the right side back into the left, keeping every tab.
            return {
              ...prev,
              slots: [[...a, ...b.filter((id) => !a.includes(id))], []],
              active: [prev.active[0] ?? prev.active[1], null],
              collapsed: [false, false]
            }
          }
          const moving = prev.active[0]
          if (!moving || a.length < 2) return prev // nothing to split with
          return {
            ...prev,
            slots: [a.filter((id) => id !== moving), [moving]],
            active: [a.find((id) => id !== moving) ?? null, moving],
            collapsed: [false, false]
          }
        })
      },
      toggleDirection
    })
    return () => setTabSurface(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTabSurface, validLayout, task, resources, navStates, onPin, onResourcesChanged])

  function selectTab(slotIndex: 0 | 1, id: string): void {
    focusedSlotRef.current = slotIndex
    setLayout((prev) => {
      const active: [string | null, string | null] = [...prev.active]
      active[slotIndex] = id
      return { ...prev, active }
    })
  }

  function closeTab(slotIndex: 0 | 1, id: string): void {
    // Only real tabs can be reopened; builtins are always one click away.
    if (id.startsWith(WEBTAB_PREFIX)) {
      // Only a real page is worth restoring — a tab that died on about:blank
      // or an error page reopens from the last good URL the layout recorded.
      const live = navStates[id]?.url
      const url = /^https?:/i.test(live ?? '') ? live : layoutRef.current.webTabs?.[id]
      if (url) closedTabs.push({ url })
    } else if (!id.startsWith('builtin-')) {
      closedTabs.push({ id }, (t) => t.id === id)
    }
    setLayout((prev) => {
      const slots: [string[], string[]] = [[...prev.slots[0]], [...prev.slots[1]]]
      slots[slotIndex] = slots[slotIndex].filter((t) => t !== id)
      const active: [string | null, string | null] = [...prev.active]
      if (active[slotIndex] === id) active[slotIndex] = slots[slotIndex][0] ?? null
      return { ...prev, slots, active }
    })
  }

  function moveTab(slotIndex: 0 | 1, id: string): void {
    const other = (1 - slotIndex) as 0 | 1
    setLayout((prev) => {
      const slots: [string[], string[]] = [[...prev.slots[0]], [...prev.slots[1]]]
      slots[slotIndex] = slots[slotIndex].filter((t) => t !== id)
      slots[other] = [...slots[other], id]
      const active: [string | null, string | null] = [...prev.active]
      if (active[slotIndex] === id) active[slotIndex] = slots[slotIndex][0] ?? null
      active[other] = id
      const collapsed: [boolean, boolean] = [...(prev.collapsed ?? [false, false])]
      collapsed[other] = false // moving a tab into a collapsed slot reopens it
      return { ...prev, slots, active, collapsed }
    })
  }

  function toggleDirection(): void {
    setLayout((prev) => ({ ...prev, direction: prev.direction === 'column' ? 'row' : 'column' }))
  }

  function toggleCollapse(slotIndex: 0 | 1): void {
    setLayout((prev) => {
      const collapsed: [boolean, boolean] = [...(prev.collapsed ?? [false, false])]
      collapsed[slotIndex] = !collapsed[slotIndex]
      return { ...prev, collapsed }
    })
  }

  // Split divider drag: hide views during drag (they'd swallow mouse events).
  function startDrag(e: React.PointerEvent): void {
    e.preventDefault()
    setDragging(true)
    window.asit.panes.setVisible(null, false)
    const grid = gridRef.current
    const vertical = validLayout.direction === 'column'
    const onMove = (ev: PointerEvent): void => {
      if (!grid) return
      const rect = grid.getBoundingClientRect()
      const fraction = vertical
        ? (ev.clientY - rect.y) / rect.height
        : (ev.clientX - rect.x) / rect.width
      setLayout((prev) => ({ ...prev, split: clampSplit(fraction) }))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDragging(false)
      window.asit.panes.setVisible(null, true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp) // a cancelled drag must still un-hide panes
  }

  const bothSlotsUsed = validLayout.slots[1].length > 0

  function renderSlot(slotIndex: 0 | 1): JSX.Element {
    const tabs = validLayout.slots[slotIndex]
      .map((id) => tabInfoFor(id, task, resources, validLayout.webTabs))
      .filter((t): t is TabInfo => !!t)
    const activeId = validLayout.active[slotIndex]
    const activeTab = tabs.find((t) => t.id === activeId) ?? null
    const nav = activeTab && activeTab.kind === 'url' ? navStates[activeTab.id] : null
    const isCollapsed = validLayout.collapsed?.[slotIndex] ?? false
    const slotFileDrop = slotIndex === 0 ? slot0Drop : slot1Drop

    if (isCollapsed) {
      return (
        <div
          className="slot slot-collapsed"
          title="Expand pane"
          onClick={() => toggleCollapse(slotIndex)}
        >
          <span className="slot-collapsed-label">
            {activeTab ? tabLabel(activeTab) : ''}
            {tabs.length > 1 ? ` +${tabs.length - 1}` : ''}
          </span>
        </div>
      )
    }

    const otherCollapsed = validLayout.collapsed?.[(1 - slotIndex) as 0 | 1] ?? false
    const flex = otherCollapsed ? 1 : slotIndex === 0 ? validLayout.split : 1 - validLayout.split

    return (
      <div
        className="slot"
        style={{ flex }}
        data-focus-zone={activeTab?.title}
        data-focus-pane={activeTab?.viewBacked ? activeTab.id : undefined}
      >
        {tabs.length > 0 && (
          <TabStrip
            tabs={tabs.map(
              (tab): TabDescriptor => ({
                id: tab.id,
                label: tabLabel(tab),
                loading: !!navStates[tab.id]?.loading && tab.viewBacked,
                favicon: tab.viewBacked ? navStates[tab.id]?.favicon : null,
                glyph:
                  tab.kind === 'ntp'
                    ? '＋'
                    : tab.kind === 'builtin-review'
                      ? '◎'
                      : tab.kind === 'builtin-terminal'
                        ? '▶_'
                        : tab.kind === 'builtin-app'
                          ? '▢'
                          : tab.kind === 'url'
                            ? '◍'
                            : tab.kind === 'pdf'
                              ? '▤'
                              : tab.kind === 'file'
                                ? '▥'
                                : '✎'
              })
            )}
            activeId={activeId}
            onSelect={(id) => selectTab(slotIndex, id)}
            onClose={(id) => closeTab(slotIndex, id)}
            onContextMenu={(id) => {
              const t = tabs.find((x) => x.id === id)
              if (t) void tabMenu(slotIndex, t)
            }}
            onNewTab={() => openWebTab(NEW_TAB_URL, slotIndex)}
            onMoveTab={(id) => moveTab(slotIndex, id)}
            leading={
              slotFileDrop.over ? <span className="tab-drop-hint">Drop to open here</span> : null
            }
            trailing={
              bothSlotsUsed ? (
                <span className="slot-strip-actions">
                  {slotIndex === 0 && (
                    <button
                      className="tab-btn"
                      title={
                        validLayout.direction === 'column'
                          ? 'Switch to side-by-side split'
                          : 'Switch to top/bottom split'
                      }
                      onClick={toggleDirection}
                    >
                      {validLayout.direction === 'column' ? '◫' : '⬒'}
                    </button>
                  )}
                  <button
                    className="tab-btn"
                    title="Collapse pane"
                    onClick={() => toggleCollapse(slotIndex)}
                  >
                    −
                  </button>
                </span>
              ) : null
            }
            stripProps={{
              ...slotFileDrop.handlers,
              className: slotFileDrop.over ? 'drop-target-over' : undefined
            }}
          />
        )}
        {nav && activeTab && (
          <BrowserToolbar
            paneId={activeTab.id}
            nav={nav}
            url={nav.url}
            addressClassName="pane-address"
          >
            {zoomLabel !== null && <span className="pane-zoom-label">{zoomLabel}%</span>}
            <BookmarkStar url={nav.url} title={nav.title || nav.url} favicon={nav.favicon} />
            <button
              className="nav-btn"
              title="Find in page (Ctrl+F)"
              onClick={() => find.openFind(activeTab.id)}
            >
              ⌕
            </button>
            {onPin && !hidePin && (
              <button
                className="nav-btn"
                title="Save this page as a task resource"
                onClick={() => onPin(nav.title || nav.url, nav.url)}
              >
                ⌾
              </button>
            )}
          </BrowserToolbar>
        )}
        {find.findFor === activeTab?.id && activeTab && <FindBar find={find} />}
        <div className="slot-content" ref={slotContentRefs[slotIndex]} data-focus-body>
          {activeTab?.kind === 'ntp' && (
            <NewTabPage
              key={activeTab.id}
              onNavigate={(value) => {
                // Converting the NTP is just storing a real URL — the
                // open-panes effect sees a view-backed tab and creates it.
                const url = toNavUrl(value)
                const id = activeTab.id
                setLayout((prev) => ({ ...prev, webTabs: { ...prev.webTabs, [id]: url } }))
              }}
            />
          )}
          {activeTab?.kind === 'builtin-review' && <ReviewPane key={task.id} task={task} />}
          {activeTab?.kind === 'builtin-terminal' && <TerminalPane key={task.id} task={task} />}
          {activeTab?.kind === 'builtin-app' && <AppWindowPane key={task.id} task={task} />}
          {activeTab &&
            !activeTab.viewBacked &&
            activeTab.kind !== 'ntp' &&
            activeTab.kind !== 'builtin-review' &&
            activeTab.kind !== 'builtin-terminal' &&
            activeTab.kind !== 'builtin-app' && (
            <NotesEditor
              key={activeTab.id}
              filePath={
                activeTab.id === BUILTIN_NOTES
                  ? childPath(task.folderPath, 'notes.md')
                  : (activeTab.resource?.filePath ?? '')
              }
              task={task}
              resources={resources}
            />
          )}
          {!activeTab && (
            <div className="slot-empty">
              <button
                className="btn"
                onClick={() => openWebTab(NEW_TAB_URL, slotIndex)}
              >
                + New tab
              </button>
              <p>…or open a resource from the left rail.</p>
            </div>
          )}
          {dragItem && (
            <div className="drop-zones">
              <div
                className={`drop-zone ${dropTarget === slotIndex ? 'drop-zone-on' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  setDropTarget(slotIndex)
                }}
                onDragLeave={() => setDropTarget((t) => (t === slotIndex ? null : t))}
                onDrop={(e) => {
                  e.preventDefault()
                  void handleDrop(slotIndex)
                }}
              >
                <span>Drop to open here</span>
              </div>
              {slotIndex === 0 && !bothSlotsUsed && (
                <div
                  className={`drop-zone drop-zone-split ${dropTarget === 1 ? 'drop-zone-on' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                    setDropTarget(1)
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === 1 ? null : t))}
                  onDrop={(e) => {
                    e.preventDefault()
                    void handleDrop(1)
                  }}
                >
                  <span>Drop to open in a split</span>
                </div>
              )}
            </div>
          )}
          {dragging && <div className="drag-cover" />}
        </div>
      </div>
    )
  }

  const anyCollapsed = (validLayout.collapsed?.[0] ?? false) || (validLayout.collapsed?.[1] ?? false)
  const vertical = validLayout.direction === 'column'

  return (
    <div className={`pane-grid ${vertical ? 'pane-grid-vertical' : ''}`} ref={gridRef}>
      {renderSlot(0)}
      {bothSlotsUsed && (
        <>
          {!anyCollapsed && (
            <div
              className={`divider ${vertical ? 'divider-horizontal' : ''}`}
              onPointerDown={startDrag}
              onDoubleClick={() => setLayout((prev) => ({ ...prev, split: 0.5 }))}
              title="Drag to resize · double-click to reset"
            />
          )}
          {renderSlot(1)}
        </>
      )}
    </div>
  )
}
