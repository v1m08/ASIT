import { getDb, newId, nowIso } from '../db'
import type { Bookmark } from '@shared/types'

// Global bookmarks for the embedded browser.
//
// Two deliberate limits, same doctrine as history.ts:
//  * There is NO action verb and NO agent-facing IPC. Bookmarks are the
//    user's record across every workspace, so handing them to a workspace
//    agent would cross the isolation boundary panes are careful about
//    (invariant 6). Adding one is always an explicit user click.
//  * Nothing here records anything automatically — a private workspace's
//    pages only end up in this table if the user bookmarks them on purpose.

// One canonical form per page. Chromium reports "https://example.com/" for a
// tab opened as "https://example.com"; without normalizing, the star for a
// page you just bookmarked shows unfilled the moment navigation reports in.
function normalizeUrl(url: string): string {
  try {
    return new URL(url).toString().slice(0, 2000)
  } catch {
    return url.slice(0, 2000)
  }
}

function rowTo(row: Record<string, unknown>): Bookmark {
  return {
    id: row.id as string,
    url: row.url as string,
    title: (row.title as string) ?? '',
    favicon: (row.favicon as string) ?? null,
    folder: (row.folder as string) ?? null,
    position: (row.position as number) ?? 0,
    createdAt: row.created_at as string
  }
}

export function listBookmarks(): Bookmark[] {
  return (
    getDb()
      .prepare('SELECT * FROM bookmarks ORDER BY position ASC, created_at DESC')
      .all() as Record<string, unknown>[]
  ).map(rowTo)
}

/** Add (or refresh) a bookmark. Upserts on URL — starring twice is a no-op
 *  that updates the title/favicon rather than a duplicate row. */
export function addBookmark(url: string, title: string, favicon?: string | null): Bookmark {
  const db = getDb()
  const clean = normalizeUrl(url)
  const existing = db.prepare('SELECT id FROM bookmarks WHERE url = ?').get(clean) as
    | { id: string }
    | undefined
  if (existing) {
    db.prepare('UPDATE bookmarks SET title = ?, favicon = ? WHERE id = ?').run(
      title.slice(0, 300),
      favicon ?? null,
      existing.id
    )
  } else {
    db.prepare(
      'INSERT INTO bookmarks (id, url, title, favicon, position, created_at) VALUES (?, ?, ?, ?, 0, ?)'
    ).run(newId(), clean, title.slice(0, 300), favicon ?? null, nowIso())
  }
  return rowTo(
    db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(clean) as Record<string, unknown>
  )
}

export function removeBookmark(id: string): void {
  getDb().prepare('DELETE FROM bookmarks WHERE id = ?').run(id)
}

export function updateBookmark(
  id: string,
  patch: Partial<Pick<Bookmark, 'title' | 'folder' | 'position'>>
): void {
  const db = getDb()
  if (patch.title !== undefined)
    db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?').run(patch.title.slice(0, 300), id)
  if (patch.folder !== undefined)
    db.prepare('UPDATE bookmarks SET folder = ? WHERE id = ?').run(patch.folder, id)
  if (patch.position !== undefined)
    db.prepare('UPDATE bookmarks SET position = ? WHERE id = ?').run(patch.position, id)
}

/** The star state for the page currently shown. */
export function isBookmarked(url: string): Bookmark | null {
  const row = getDb().prepare('SELECT * FROM bookmarks WHERE url = ?').get(normalizeUrl(url)) as
    | Record<string, unknown>
    | undefined
  return row ? rowTo(row) : null
}
