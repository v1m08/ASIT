import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { PaneNavState, Resource, Task, WorkspaceLayout } from '@shared/types'
import NotesEditor from './NotesEditor'
import TerminalPane from './TerminalPane'
import AppWindowPane from './AppWindowPane'
import ReviewPane from './ReviewPane'
import { useStore } from '../store/useStore'
import { useOverlay } from '../hooks/useOverlay'

export const BUILTIN_NOTES = 'builtin-notes'
export const BUILTIN_SEARCH = 'builtin-search'
export const BUILTIN_REVIEW = 'builtin-review'
export const BUILTIN_TERMINAL = 'builtin-terminal'
export const BUILTIN_APP = 'builtin-app'

const DEFAULT_LAYOUT: WorkspaceLayout = {
  slots: [[], []],
  active: [null, null],
  split: 0.55,
  collapsed: [false, false],
  direction: 'row'
}

interface TabInfo {
  id: string
  title: string
  kind:
    | 'url'
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

export function tabInfoFor(id: string, task: Task, resources: Resource[]): TabInfo | null {
  if (id === BUILTIN_NOTES) {
    return { id, title: 'Notes', kind: 'builtin-note', viewBacked: false, resource: null }
  }
  if (id === BUILTIN_SEARCH) {
    return { id, title: 'Search', kind: 'url', viewBacked: true, resource: null }
  }
  if (id === BUILTIN_REVIEW) {
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
  onAttachLibrary
}: {
  task: Task
  resources: Resource[]
  onApi?: (api: PaneGridApi) => void
  onPin?: (title: string, url: string) => void
  // Dropping a global library file attaches a copy to this workspace first.
  onAttachLibrary?: (name: string) => Promise<Resource | null>
}): JSX.Element {
  const [layout, setLayout] = useState<WorkspaceLayout>(() => {
    if (task.layoutJson) {
      try {
        const parsed = JSON.parse(task.layoutJson) as WorkspaceLayout
        return {
          slots: [parsed.slots?.[0] ?? [], parsed.slots?.[1] ?? []],
          active: [parsed.active?.[0] ?? null, parsed.active?.[1] ?? null],
          split: clampSplit(parsed.split ?? 0.55),
          collapsed: [parsed.collapsed?.[0] ?? false, parsed.collapsed?.[1] ?? false],
          direction: parsed.direction === 'column' ? 'column' : 'row'
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
  // Find-in-page + zoom: the browser basics panes were missing.
  const [findFor, setFindFor] = useState<string | null>(null)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState<{ activeMatch: number; matches: number } | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [zoomLabel, setZoomLabel] = useState<number | null>(null)
  // Ctrl+Shift+T: the tab ids most recently removed from the layout.
  const closedTabs = useRef<string[]>([])
  const hidePin = useStore((st) => st.settings?.hidePin ?? false)
  // A page painted over the slot would eat every drag event, so the views go
  // away for the duration of the drag — same rule as any overlay (invariant 2).
  useOverlay(dragItem !== null)
  const gridRef = useRef<HTMLDivElement>(null)
  const slotContentRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const openedPanes = useRef(new Set<string>())
  const searchUrlRef = useRef<string>('https://www.google.com')

  // Prune tabs whose resources were removed.
  const validLayout = useMemo((): WorkspaceLayout => {
    const valid = (id: string): boolean => !!tabInfoFor(id, task, resources)
    const slots: [string[], string[]] = [
      layout.slots[0].filter(valid),
      layout.slots[1].filter(valid)
    ]
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
    return { slots, active, split: layout.split, collapsed, direction: layout.direction ?? 'row' }
  }, [layout, task, resources])

  // Open view-backed panes that appear in the layout.
  useEffect(() => {
    for (const slot of validLayout.slots) {
      for (const id of slot) {
        const tab = tabInfoFor(id, task, resources)
        if (tab?.viewBacked && !openedPanes.current.has(id)) {
          openedPanes.current.add(id)
          const target =
            id === BUILTIN_SEARCH ? { url: searchUrlRef.current } : paneTargetFor(tab)
          window.asit.panes.open(id, target, task.id)
        }
      }
    }
  }, [validLayout, task, resources])

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
  const syncPanes = useCallback((): void => {
    validLayout.slots.forEach((slot, i) => {
      const activeId = validLayout.active[i]
      const slotCollapsed = validLayout.collapsed?.[i] ?? false
      for (const id of slot) {
        const tab = tabInfoFor(id, task, resources)
        if (!tab?.viewBacked) continue
        const isActive = id === activeId && !slotCollapsed
        window.asit.panes.setVisible(id, isActive)
        if (isActive) {
          const el = slotContentRefs[i].current
          if (el) {
            const rect = el.getBoundingClientRect()
            window.asit.panes.setBounds(id, {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            })
          }
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validLayout, task, resources])

  useEffect(() => {
    syncPanes()
  }, [syncPanes])

  // Track slot geometry changes (window resize, split drag, header changes).
  useEffect(() => {
    const observers = slotContentRefs.map((ref) => {
      const obs = new ResizeObserver(() => syncPanes())
      if (ref.current) obs.observe(ref.current)
      return obs
    })
    window.addEventListener('resize', syncPanes)
    return () => {
      observers.forEach((o) => o.disconnect())
      window.removeEventListener('resize', syncPanes)
    }
  }, [syncPanes])

  // Pane navigation state pushes (title, url, back/forward).
  useEffect(() => {
    return window.asit.on(IPC.PANES_DID_NAVIGATE, (...args: unknown[]) => {
      const state = args[0] as PaneNavState
      setNavStates((prev) => ({ ...prev, [state.paneId]: state }))
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

  useEffect(() => {
    const offFind = window.asit.on(IPC.PANES_FIND_RESULT, (...args: unknown[]) => {
      const r = args[0] as { paneId: string; activeMatch: number; matches: number }
      setFindResult({ activeMatch: r.activeMatch, matches: r.matches })
    })
    const offApp = window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const e = args[0] as { type: string; paneId?: string; zoom?: number; url?: string }
      if (e.type === 'find-in-page') {
        setFindFor(e.paneId ?? null)
        setTimeout(() => findInputRef.current?.select(), 40)
      } else if (e.type === 'pane-zoom' && typeof e.zoom === 'number') {
        setZoomLabel(Math.round(100 * Math.pow(1.2, e.zoom)))
        setTimeout(() => setZoomLabel(null), 1400)
      } else if (e.type === 'new-tab') {
        openSearchRef.current?.('')
      } else if (e.type === 'close-tab') {
        closeActiveTabRef.current?.()
      } else if (e.type === 'reopen-tab') {
        const id = closedTabs.current.pop()
        if (id) openResourceRef.current?.(id)
      } else if (e.type === 'next-tab' || e.type === 'prev-tab') {
        cycleTabRef.current?.(e.type === 'next-tab' ? 1 : -1)
      }
    })
    return () => {
      offFind()
      offApp()
    }
  }, [])

  const runFind = useCallback(
    (text: string, findNext: boolean, forward = true): void => {
      if (!findFor) return
      setFindText(text)
      if (!text) setFindResult(null)
      void window.asit.panes.find(findFor, text, forward, findNext)
    },
    [findFor]
  )

  const closeFind = useCallback((): void => {
    if (findFor) void window.asit.panes.findStop(findFor)
    setFindFor(null)
    setFindText('')
    setFindResult(null)
  }, [findFor])

  const openSearch = useCallback(
    (query: string): void => {
      const url = query.trim()
        ? `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`
        : 'https://www.google.com'
      searchUrlRef.current = url
      if (openedPanes.current.has(BUILTIN_SEARCH)) {
        window.asit.panes.navigate(BUILTIN_SEARCH, { url })
      }
      openResource(BUILTIN_SEARCH)
    },
    [openResource]
  )

  const openUrl = useCallback(
    (url: string): void => {
      searchUrlRef.current = url
      if (openedPanes.current.has(BUILTIN_SEARCH)) {
        window.asit.panes.navigate(BUILTIN_SEARCH, { url })
      }
      openResource(BUILTIN_SEARCH)
    },
    [openResource]
  )

  // Keyboard shortcuts fire from a listener registered once, so they reach the
  // CURRENT versions of these through refs rather than a stale closure.
  const openResourceRef = useRef(openResource)
  const openSearchRef = useRef(openSearch)
  const closeActiveTabRef = useRef<(() => void) | null>(null)
  const cycleTabRef = useRef<((dir: 1 | -1) => void) | null>(null)
  openResourceRef.current = openResource
  openSearchRef.current = openSearch
  closeActiveTabRef.current = () => {
    const slot = validLayout.active[0] ? 0 : 1
    const id = validLayout.active[slot]
    if (id) closeTab(slot as 0 | 1, id)
  }
  cycleTabRef.current = (dir) => {
    const slot: 0 | 1 = validLayout.active[0] ? 0 : 1
    const tabs = validLayout.slots[slot]
    if (tabs.length < 2) return
    const at = tabs.indexOf(validLayout.active[slot] ?? '')
    const next = tabs[(at + dir + tabs.length) % tabs.length]
    selectTab(slot, next)
  }

  useEffect(() => {
    onApi?.({ openResource, openSearch, openUrl })
  }, [onApi, openResource, openSearch, openUrl])

  function selectTab(slotIndex: 0 | 1, id: string): void {
    setLayout((prev) => {
      const active: [string | null, string | null] = [...prev.active]
      active[slotIndex] = id
      return { ...prev, active }
    })
  }

  function closeTab(slotIndex: 0 | 1, id: string): void {
    // Only real resources can be reopened; builtins are always one click away.
    if (!id.startsWith('builtin-')) {
      closedTabs.current = [...closedTabs.current.filter((t) => t !== id), id].slice(-10)
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
      .map((id) => tabInfoFor(id, task, resources))
      .filter((t): t is TabInfo => !!t)
    const activeId = validLayout.active[slotIndex]
    const activeTab = tabs.find((t) => t.id === activeId) ?? null
    const nav = activeTab && activeTab.kind === 'url' ? navStates[activeTab.id] : null
    const isCollapsed = validLayout.collapsed?.[slotIndex] ?? false

    if (isCollapsed) {
      return (
        <div
          className="slot slot-collapsed"
          title="Expand pane"
          onClick={() => toggleCollapse(slotIndex)}
        >
          <span className="slot-collapsed-label">
            {activeTab ? activeTab.title : ''}
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
          <div className="tab-strip">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeId ? 'tab-active' : ''}`}
                onClick={() => selectTab(slotIndex, tab.id)}
                title={tab.title}
              >
                <span className="tab-icon">
                  {navStates[tab.id]?.favicon && tab.viewBacked ? (
                    <img
                      className="tab-favicon"
                      src={navStates[tab.id]!.favicon!}
                      alt=""
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                    />
                  ) : tab.id === BUILTIN_SEARCH
                    ? '⌕'
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
                          : '✎'}
                </span>
                <span className="tab-title">{tab.title}</span>
                <button
                  className="tab-btn"
                  title="Move to other side"
                  onClick={(e) => {
                    e.stopPropagation()
                    moveTab(slotIndex, tab.id)
                  }}
                >
                  ⇄
                </button>
                <button
                  className="tab-btn"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(slotIndex, tab.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {bothSlotsUsed && (
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
            )}
          </div>
        )}
        {nav && activeTab && (
          <div className="pane-toolbar">
            <button
              className="nav-btn"
              disabled={!nav.canGoBack}
              onClick={() => window.asit.panes.navigate(activeTab.id, { nav: 'back' })}
            >
              ←
            </button>
            <button
              className="nav-btn"
              disabled={!nav.canGoForward}
              onClick={() => window.asit.panes.navigate(activeTab.id, { nav: 'forward' })}
            >
              →
            </button>
            <button
              className="nav-btn"
              onClick={() => window.asit.panes.navigate(activeTab.id, { nav: 'reload' })}
            >
              ⟳
            </button>
            <span className="pane-url" title={nav.url}>
              {nav.url}
            </span>
            {zoomLabel !== null && <span className="pane-zoom-label">{zoomLabel}%</span>}
            <button
              className="nav-btn"
              title="Find in page (Ctrl+F)"
              onClick={() => {
                setFindFor(activeTab.id)
                setTimeout(() => findInputRef.current?.select(), 40)
              }}
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
          </div>
        )}
        {findFor && findFor === activeTab?.id && (
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
            <button className="nav-btn" title="Previous (Shift+Enter)" onClick={() => runFind(findText, true, false)}>
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
        <div className="slot-content" ref={slotContentRefs[slotIndex]} data-focus-body>
          {activeTab?.kind === 'builtin-review' && <ReviewPane key={task.id} task={task} />}
          {activeTab?.kind === 'builtin-terminal' && <TerminalPane key={task.id} task={task} />}
          {activeTab?.kind === 'builtin-app' && <AppWindowPane key={task.id} task={task} />}
          {activeTab &&
            !activeTab.viewBacked &&
            activeTab.kind !== 'builtin-review' &&
            activeTab.kind !== 'builtin-terminal' &&
            activeTab.kind !== 'builtin-app' && (
            <NotesEditor
              key={activeTab.id}
              filePath={
                activeTab.id === BUILTIN_NOTES
                  ? `${task.folderPath}\\notes.md`
                  : (activeTab.resource?.filePath ?? '')
              }
              task={task}
              resources={resources}
            />
          )}
          {!activeTab && (
            <div className="slot-empty">
              <p>Open a resource from the left rail.</p>
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
