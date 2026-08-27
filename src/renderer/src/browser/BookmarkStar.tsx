import { useEffect, useState } from 'react'
import type { Bookmark } from '@shared/types'

// The toolbar star + the one place bookmark toggling goes through, so every
// star (and the NTP grid) hears about changes via one window event.

const CHANGED = 'asit-bookmarks-changed'

export async function toggleBookmark(
  url: string,
  title: string,
  favicon?: string | null
): Promise<boolean> {
  const existing = await window.asit.bookmarks.status(url)
  if (existing) await window.asit.bookmarks.remove(existing.id)
  else await window.asit.bookmarks.add(url, title, favicon)
  window.dispatchEvent(new CustomEvent(CHANGED))
  return !existing
}

export function onBookmarksChanged(fn: () => void): () => void {
  window.addEventListener(CHANGED, fn)
  return () => window.removeEventListener(CHANGED, fn)
}

export default function BookmarkStar({
  url,
  title,
  favicon
}: {
  url: string
  title: string
  favicon?: string | null
}): JSX.Element | null {
  const [marked, setMarked] = useState<Bookmark | null>(null)
  const bookmarkable = /^https?:/i.test(url)

  useEffect(() => {
    if (!bookmarkable) {
      setMarked(null)
      return
    }
    let live = true
    const check = (): void => {
      void window.asit.bookmarks.status(url).then((b) => {
        if (live) setMarked(b)
      })
    }
    check()
    const off = onBookmarksChanged(check)
    return () => {
      live = false
      off()
    }
  }, [url, bookmarkable])

  if (!bookmarkable) return null
  return (
    <button
      className={`nav-btn bookmark-star ${marked ? 'bookmark-star-on' : ''}`}
      title={marked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)'}
      onClick={() => void toggleBookmark(url, title, favicon)}
    >
      {marked ? '★' : '☆'}
    </button>
  )
}
