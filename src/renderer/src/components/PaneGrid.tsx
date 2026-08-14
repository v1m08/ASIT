import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { PaneNavState, Resource, Task, WorkspaceLayout } from '@shared/types'
import NotesEditor from './NotesEditor'
import ReviewPane from './ReviewPane'

export const BUILTIN_NOTES = 'builtin-notes'
export const BUILTIN_SEARCH = 'builtin-search'
export const BUILTIN_REVIEW = 'builtin-review'

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
  kind: 'url' | 'pdf' | 'note' | 'file' | 'builtin-note' | 'builtin-review'
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
}

export default function PaneGrid({
  task,
  resources,
  onApi,
  onPin
}: {
  task: Task
  resources: Resource[]
  onApi?: (api: PaneGridApi) => void
  onPin?: (title: string, url: string) => void
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

  useEffect(() => {
    onApi?.({ openResource, openSearch })
  }, [onApi, openResource, openSearch])

  function selectTab(slotIndex: 0 | 1, id: string): void {
    setLayout((prev) => {
      const active: [string | null, string | null] = [...prev.active]
      active[slotIndex] = id
      return { ...prev, active }
    })
  }

  function closeTab(slotIndex: 0 | 1, id: string): void {
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
                  {tab.id === BUILTIN_SEARCH
                    ? '🔍'
                    : tab.kind === 'builtin-review'
                      ? '🧠'
                      : tab.kind === 'url'
                      ? '🌐'
                      : tab.kind === 'pdf'
                        ? '📄'
                        : tab.kind === 'file'
                          ? '📎'
                          : '📝'}
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
            {onPin && (
              <button
                className="nav-btn"
                title="Save this page as a task resource"
                onClick={() => onPin(nav.title || nav.url, nav.url)}
              >
                📌
              </button>
            )}
          </div>
        )}
        <div className="slot-content" ref={slotContentRefs[slotIndex]} data-focus-body>
          {activeTab?.kind === 'builtin-review' && <ReviewPane key={task.id} task={task} />}
          {activeTab && !activeTab.viewBacked && activeTab.kind !== 'builtin-review' && (
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
