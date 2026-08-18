import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { SHORTCUTS } from '@shared/shortcuts'
import { useStore } from '../store/useStore'
import { useOverlay } from '../hooks/useOverlay'
import { hostOf } from './AddressBar'
import { runShortcut } from '../hooks/useFocusRing'

// Ctrl+Shift+P / Ctrl+P — one box that reaches everything.
//
// The app had grown a lot of doors: workspaces on Home, resources in the rail,
// pages in history, panels behind their own chords. Each is two or three steps
// from wherever you happen to be. This is the one step, and it is the same
// step everywhere.
//
// It scores rather than filters, so "cs" finds "CS 1331" without you knowing
// whether it lives in a workspace list or a rail — which is the whole point.

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  run: () => void
}

/**
 * Subsequence match, the way editor palettes work: "gsc" hits "GradeScope".
 * Returns a score (higher is better) or -1. Contiguous runs and word-start
 * hits rank above scattered letters, so exact-ish typing wins.
 */
function score(text: string, query: string): number {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  // Shorter labels win ties: "Gradescope" and "Grade something later" are both
  // prefix hits for "grade", and the one that is mostly your query is the one
  // you meant.
  const brevity = Math.min(40, t.length / 2)
  const direct = t.indexOf(q)
  if (direct === 0) return 1000 - brevity
  if (direct > 0) return 700 - direct - brevity

  let ti = 0
  let points = 0
  let streak = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at === -1) return -1
    const wordStart = at === 0 || /[\s\-_/.:]/.test(t[at - 1])
    streak = at === ti ? streak + 1 : 0
    points += 10 + streak * 4 + (wordStart ? 8 : 0)
    ti = at + 1
  }
  return points
}

export default function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.paletteOpen)
  const setOpen = useStore((s) => s.setPaletteOpen)
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  const activeResources = useStore((s) => s.activeResources)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [pages, setPages] = useState<HistoryEntry[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useOverlay(open)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
  }, [open])

  // History is the one source too big to hold in memory, so it is queried.
  useEffect(() => {
    if (!open) return
    let live = true
    const t = setTimeout(() => {
      void window.asit.history.search(query, 6).then((r) => live && setPages(r))
    }, 80)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [open, query])

  const items = useMemo((): Item[] => {
    const out: Item[] = []
    const store = useStore.getState()

    for (const t of tasks) {
      if (t.id === activeTask?.id) continue
      out.push({
        id: `task-${t.id}`,
        group: 'Workspace',
        label: t.title,
        hint: t.aiDisabled ? 'private' : undefined,
        run: () => void store.openTask(t.id)
      })
    }

    for (const r of activeResources) {
      out.push({
        id: `res-${r.id}`,
        group: 'In this workspace',
        label: r.title,
        hint: r.kind,
        run: () => void store.openTaskAndResource(activeTask!.id, r.id)
      })
    }

    for (const p of pages) {
      out.push({
        id: `page-${p.id}`,
        group: 'History',
        label: p.title || hostOf(p.url),
        hint: hostOf(p.url),
        run: () => store.openUrlInWorkspace(p.url)
      })
    }

    // Every labelled shortcut is a command. Deriving them from the same table
    // the keys come from means a new shortcut shows up here for free, and one
    // that gets renamed cannot go stale.
    const seen = new Set<string>()
    for (const s of SHORTCUTS) {
      // The palette listing itself is noise.
      if (!s.label || s.id === 'open-palette' || seen.has(s.id)) continue
      seen.add(s.id)
      out.push({
        id: `cmd-${s.id}`,
        group: 'Command',
        label: s.label,
        hint: s.accel.replace('CommandOrControl', 'Ctrl'),
        run: () => runShortcut(s.id)
      })
    }

    return out
  }, [tasks, activeTask, activeResources, pages])

  const results = useMemo(() => {
    if (!query.trim()) {
      // Empty box: the things you most likely wanted, not an alphabet soup.
      return items.filter((i) => i.group !== 'History').slice(0, 12)
    }
    return items
      .map((i) => ({ i, s: Math.max(score(i.label, query), score(i.hint ?? '', query) - 200) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((r) => r.i)
  }, [items, query])

  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, results.length - 1)))
  }, [results.length])

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-on="1"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  if (!open) return null

  const choose = (item: Item | undefined): void => {
    if (!item) return
    setOpen(false)
    // After the overlay closes, so a command that touches panes isn't fighting
    // the visibility restore.
    setTimeout(() => item.run(), 0)
  }

  let lastGroup = ''

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Go to a workspace, page, or command…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') return setOpen(false)
            if (e.key === 'Enter') return choose(results[highlight])
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHighlight((h) => (h + 1) % Math.max(1, results.length))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHighlight((h) => (h <= 0 ? results.length - 1 : h - 1))
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <p className="library-empty">Nothing matches.</p>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className="rail-header">{header}</div>}
                <div
                  className={`palette-row ${i === highlight ? 'palette-row-on' : ''}`}
                  data-on={i === highlight ? '1' : '0'}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(item)
                  }}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
