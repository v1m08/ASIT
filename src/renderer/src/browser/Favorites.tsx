import { useEffect, useState } from 'react'
import type { Bookmark } from '@shared/types'
import { useStore } from '../store/useStore'
import { hostOf } from '../components/AddressBar'
import { onBookmarksChanged } from './BookmarkStar'

// Arc's Favorites: the sites you live in, as a grid of big favicon tiles at
// the top of the sidebar — one click from every space. They are simply your
// first bookmarks (Ctrl+D / the ★ in the address bar), so there is nothing
// new to manage. Bookmarks stay agent-unreachable (invariant 21): this is
// renderer-only and opens through the same urlOpener a click on a link does.

const MAX = 8

export default function Favorites(): JSX.Element | null {
  const [items, setItems] = useState<Bookmark[]>([])
  const openUrl = useStore((s) => s.openUrlInWorkspace)

  useEffect(() => {
    const load = (): void => {
      void window.asit.bookmarks.list().then((all) => setItems(all.slice(0, MAX)))
    }
    load()
    return onBookmarksChanged(load)
  }, [])

  if (items.length === 0) return null
  return (
    <div className="sb-favorites" data-count={items.length}>
      {items.map((b) => (
        <button
          key={b.id}
          className="sb-fav"
          title={`${b.title || hostOf(b.url)}\n${b.url}`}
          onClick={() => openUrl(b.url)}
        >
          <FavIcon b={b} />
        </button>
      ))}
    </div>
  )
}

function FavIcon({ b }: { b: Bookmark }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (b.favicon && !failed) return <img src={b.favicon} alt="" onError={() => setFailed(true)} />
  return <span className="sb-fav-letter">{letter(b)}</span>
}

function letter(b: Bookmark): string {
  return (hostOf(b.url)[0] ?? '★').toUpperCase()
}
