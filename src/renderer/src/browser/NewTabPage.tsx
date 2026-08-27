import { useEffect, useState } from 'react'
import type { Bookmark, HistoryEntry } from '@shared/types'
import AddressBar, { hostOf } from '../components/AddressBar'
import { onBookmarksChanged } from './BookmarkStar'

// The new-tab page. Plain DOM: an NTP tab has no pane, so nothing paints over
// this (invariant 2 by construction — the builtin-notes pattern). Renders
// inside its own slot's content area; in a split the other slot's page stays.

export default function NewTabPage({
  onNavigate
}: {
  /** Typing or clicking a site converts this tab into a real page. */
  onNavigate: (value: string) => void
}): JSX.Element {
  const [topSites, setTopSites] = useState<HistoryEntry[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])

  useEffect(() => {
    // An empty query is the visit-count ranking — the browser's "top sites".
    void window.asit.history.search('', 8).then(setTopSites)
    const load = (): void => {
      void window.asit.bookmarks.list().then(setBookmarks)
    }
    load()
    return onBookmarksChanged(load)
  }, [])

  return (
    <div className="ntp">
      <div className="ntp-inner">
        <AddressBar url="" onNavigate={onNavigate} className="ntp-address" autoFocus />
        {bookmarks.length > 0 && (
          <div className="ntp-section">
            <div className="ntp-label">Bookmarks</div>
            <div className="ntp-sites">
              {bookmarks.slice(0, 12).map((b) => (
                <button
                  key={b.id}
                  className="ntp-site"
                  title={b.url}
                  onClick={() => onNavigate(b.url)}
                >
                  <span className="ntp-site-host">
                    {b.favicon ? <img className="ntp-favicon" src={b.favicon} alt="" /> : '★'}{' '}
                    {hostOf(b.url)}
                  </span>
                  <span className="ntp-site-title">{b.title || hostOf(b.url)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {topSites.length > 0 && (
          <div className="ntp-section">
            <div className="ntp-label">Often visited</div>
            <div className="ntp-sites">
              {topSites.map((s) => (
                <button
                  key={s.id}
                  className="ntp-site"
                  title={s.url}
                  onClick={() => onNavigate(s.url)}
                >
                  <span className="ntp-site-host">{hostOf(s.url)}</span>
                  <span className="ntp-site-title">{s.title || hostOf(s.url)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {topSites.length === 0 && bookmarks.length === 0 && (
          <p className="ntp-empty">
            Type an address or search — sites you visit often will show up here.
          </p>
        )}
      </div>
    </div>
  )
}
