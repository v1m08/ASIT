import { getDb, newId, nowIso } from '../db'
import { getTask } from './tasks'
import type { HistoryEntry } from '@shared/types'

// Browsing history for the embedded panes.
//
// Without this the app has no memory of where you have been: no address-bar
// autocomplete, no "what was that page", no way back to something you closed
// yesterday. That absence is most of what makes the workspace feel unlike a
// browser even though it renders the same pages.
//
// Two deliberate limits:
//  * PRIVATE workspaces are never recorded. A workspace marked private is one
//    the user wants left alone, and quietly indexing its URLs into a global
//    searchable list is exactly the surprise that promise rules out.
//  * There is no action verb and no agent-facing IPC. History is a record of
//    the USER's browsing across every workspace, so handing it to a workspace
//    agent would cross the isolation boundary panes are so careful about.

function rowTo(row: Record<string, unknown>): HistoryEntry {
  return {
    id: row.id as string,
    url: row.url as string,
    title: (row.title as string) ?? '',
    taskId: (row.task_id as string) ?? null,
    visitCount: (row.visit_count as number) ?? 1,
    lastVisitedAt: row.last_visited_at as string
  }
}

/** Pages that are noise in a history list. */
function skip(url: string): boolean {
  if (!/^https?:/i.test(url)) return true
  if (/^https?:\/\/(127\.0\.0\.1|localhost)\b/i.test(url)) return true
  return false
}

export function recordVisit(url: string, title: string, taskId: string | null): void {
  if (skip(url)) return
  if (taskId) {
    const task = getTask(taskId)
    if (!task || task.aiDisabled) return // private workspaces leave no trace
  }
  const db = getDb()
  const clean = url.slice(0, 2000)
  const existing = db.prepare('SELECT id FROM history WHERE url = ?').get(clean) as
    | { id: string }
    | undefined
  if (existing) {
    db.prepare(
      'UPDATE history SET title = ?, task_id = ?, visit_count = visit_count + 1, last_visited_at = ? WHERE id = ?'
    ).run(title.slice(0, 300), taskId, nowIso(), existing.id)
    return
  }
  db.prepare(
    'INSERT INTO history (id, url, title, task_id, visit_count, last_visited_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(newId(), clean, title.slice(0, 300), taskId, nowIso())
}

/**
 * Address-bar autocomplete. Ranked the way a browser ranks: things you go to
 * often and recently beat a closer string match you visited once.
 */
export function searchHistory(query: string, limit = 8): HistoryEntry[] {
  const q = query.trim().toLowerCase()
  const db = getDb()
  if (!q) {
    return (
      db
        .prepare('SELECT * FROM history ORDER BY visit_count DESC, last_visited_at DESC LIMIT ?')
        .all(limit) as Record<string, unknown>[]
    ).map(rowTo)
  }
  const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`
  const rows = db
    .prepare(
      `SELECT * FROM history
       WHERE lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\'
       ORDER BY
         -- a prefix hit on the host is what you almost always meant
         CASE WHEN lower(url) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
         visit_count DESC,
         last_visited_at DESC
       LIMIT ?`
    )
    .all(like, like, `https://${q}%`, limit) as Record<string, unknown>[]
  return rows.map(rowTo)
}

export function recentHistory(limit = 200): HistoryEntry[] {
  return (
    getDb()
      .prepare('SELECT * FROM history ORDER BY last_visited_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
  ).map(rowTo)
}

export function removeHistory(id: string): void {
  getDb().prepare('DELETE FROM history WHERE id = ?').run(id)
}

export function clearHistory(): void {
  getDb().prepare('DELETE FROM history').run()
}
