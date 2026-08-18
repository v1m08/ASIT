import { useEffect, useMemo, useState } from 'react'
import { SHORTCUTS, SHORTCUT_GROUPS, type ShortcutDef } from '@shared/shortcuts'
import { useStore } from '../store/useStore'
import { useOverlay } from '../hooks/useOverlay'

// Ctrl+/ — the whole keyboard, on one page.
//
// A shortcut you cannot find is a shortcut you do not have. The palette
// teaches them one at a time (you search by name and see the key next to it);
// this is the other half — the sheet you skim once and half-remember, which is
// how anyone actually learns a keyboard.
//
// Built from the shortcut table, so it can never list a key that no longer
// works or miss one that was just added.

/** Human-readable, in the order your fingers press them. */
function prettyAccel(accel: string): string {
  return accel
    .replace('CommandOrControl', 'Ctrl')
    .replace('Control', 'Ctrl')
    .replace('Plus', '+')
    .split('+')
    .filter((p, i, all) => !(p === '' && i < all.length - 1))
    .join(' + ')
}

export default function ShortcutsModal(): JSX.Element | null {
  const open = useStore((s) => s.shortcutsOpen)
  const setOpen = useStore((s) => s.setShortcutsOpen)
  const [query, setQuery] = useState('')

  useOverlay(open)

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const groups = useMemo(() => {
    // One row per action, listing every key bound to it (Ctrl+R and F5 both
    // reload, and hiding one of them helps nobody).
    const byId = new Map<string, { def: ShortcutDef; accels: string[] }>()
    for (const s of SHORTCUTS) {
      const existing = byId.get(s.id)
      if (existing) {
        if (!existing.accels.includes(s.accel)) existing.accels.push(s.accel)
        if (!existing.def.label && s.label) existing.def = s
      } else {
        byId.set(s.id, { def: s, accels: [s.accel] })
      }
    }
    // Ctrl+1…9 is generated, not in the table.
    byId.set('focus-zone', {
      def: { id: 'focus-zone', accel: 'CommandOrControl+1', key: '1', label: 'Jump to a panel' },
      accels: ['Ctrl + 1 … 9']
    })

    const q = query.trim().toLowerCase()
    return SHORTCUT_GROUPS.map((g) => ({
      title: g.title,
      rows: g.ids
        .map((id) => byId.get(id))
        .filter((r): r is { def: ShortcutDef; accels: string[] } => !!r?.def.label)
        .filter(
          (r) =>
            !q ||
            r.def.label.toLowerCase().includes(q) ||
            r.accels.join(' ').toLowerCase().includes(q)
        )
    })).filter((g) => g.rows.length > 0)
  }, [query])

  if (!open) return null

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="modal shortcuts-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Keyboard</h2>
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <input
          autoFocus
          className="history-search"
          placeholder="Search shortcuts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="shortcuts-grid">
          {groups.map((g) => (
            <section key={g.title} className="shortcuts-group">
              <div className="rail-header">{g.title}</div>
              {g.rows.map((r) => (
                <div key={r.def.id} className="shortcut-row">
                  <span className="shortcut-label">{r.def.label}</span>
                  <span className="shortcut-keys">
                    {r.accels.map((a) => (
                      <kbd key={a}>{a.includes('…') ? a : prettyAccel(a)}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && <p className="library-empty">No shortcut matches that.</p>}
        </div>
      </div>
    </div>
  )
}
