import { useEffect, useMemo, useState } from 'react'
import type { Bookmark, HistoryEntry } from '@shared/types'
import { useStore } from '../store/useStore'
import { useOverlay } from '../hooks/useOverlay'
import { hostOf } from './AddressBar'

// Ctrl+H. The list the address bar completes against, made visible — so you
// can get back to a page you closed, and delete things you'd rather not keep.
// A Bookmarks tab lives here too: it's the same "my pages" surface, already
// mounted app-wide and already overlay-safe.
//
// Private workspaces never appear here because they are never recorded at all
// (services/history.ts), not because this view filters them out.

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

export default function HistoryModal(): JSX.Element | null {
  const open = useStore((s) => s.historyOpen)
  const setOpen = useStore((s) => s.setHistoryOpen)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [tab, setTab] = useState<'history' | 'bookmarks'>('history')
  const [query, setQuery] = useState('')

  // Panes paint over all app DOM, so a modal MUST hide them first.
  useOverlay(open)

  useEffect(() => {
    if (!open) return
    setQuery('')
    void window.asit.history.recent(400).then(setEntries)
    void window.asit.bookmarks.list().then(setBookmarks)
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
    const q = query.trim().toLowerCase()
    const shown = q
      ? entries.filter(
          (e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)
        )
      : entries
    const out: { label: string; rows: HistoryEntry[] }[] = []
    for (const e of shown) {
      const label = dayLabel(e.lastVisitedAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.rows.push(e)
      else out.push({ label, rows: [e] })
    }
    return out
  }, [entries, query])

  const shownBookmarks = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return bookmarks
    return bookmarks.filter(
      (b) => b.url.toLowerCase().includes(q) || b.title.toLowerCase().includes(q)
    )
  }, [bookmarks, query])

  if (!open) return null

  const openEntry = (url: string): void => {
    setOpen(false)
    useStore.getState().openUrlInWorkspace(url)
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <button
              className={`history-tab ${tab === 'history' ? 'history-tab-on' : ''}`}
              onClick={() => setTab('history')}
            >
              History
            </button>
            <button
              className={`history-tab ${tab === 'bookmarks' ? 'history-tab-on' : ''}`}
              onClick={() => setTab('bookmarks')}
            >
              Bookmarks
            </button>
          </h2>
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <input
          autoFocus
          className="history-search"
          placeholder={tab === 'history' ? 'Search history' : 'Search bookmarks'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tab === 'history' && (
          <div className="history-list">
            {groups.length === 0 && (
              <p className="library-empty">
                {entries.length === 0
                  ? 'Nothing here yet. Pages you open in a workspace show up as you browse.'
                  : 'No matches.'}
              </p>
            )}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="rail-header">{g.label}</div>
                {g.rows.map((e) => (
                  <div key={e.id} className="history-row" onClick={() => openEntry(e.url)}>
                    <span className="history-time">
                      {new Date(e.lastVisitedAt).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </span>
                    <span className="history-title">{e.title || hostOf(e.url)}</span>
                    <span className="history-host">{hostOf(e.url)}</span>
                    {e.visitCount > 1 && <span className="history-count">{e.visitCount}×</span>}
                    <button
                      className="rail-btn"
                      title="Forget this page"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void window.asit.history.remove(e.id)
                        setEntries((prev) => prev.filter((x) => x.id !== e.id))
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {tab === 'bookmarks' && (
          <div className="history-list">
            {shownBookmarks.length === 0 && (
              <p className="library-empty">
                {bookmarks.length === 0
                  ? 'No bookmarks yet — press Ctrl+D on a page, or click its ★.'
                  : 'No matches.'}
              </p>
            )}
            {shownBookmarks.map((b) => (
              <div key={b.id} className="history-row" onClick={() => openEntry(b.url)}>
                <span className="history-time">★</span>
                <span className="history-title">{b.title || hostOf(b.url)}</span>
                <span className="history-host">{hostOf(b.url)}</span>
                <button
                  className="rail-btn"
                  title="Remove bookmark"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void window.asit.bookmarks.remove(b.id)
                    setBookmarks((prev) => prev.filter((x) => x.id !== b.id))
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          {tab === 'history' && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                if (!confirm('Clear your entire browsing history?')) return
                void window.asit.history.clear()
                setEntries([])
              }}
            >
              Clear all history
            </button>
          )}
          <button className="btn" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
