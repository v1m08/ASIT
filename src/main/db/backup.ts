import type { Database } from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { logError } from '../log'

// Keeping the database recoverable.
//
// Written after losing six days of work to a WAL. SQLite in WAL mode writes
// new data to a side file and only folds it into the main database at a
// checkpoint — which normally happens on clean shutdown. If the app is killed
// instead (a crash, or an installer replacing a running binary), the WAL
// survives and is replayed next open, so that alone is safe. But it means
// that until a checkpoint happens, ALL recent work lives in exactly one file,
// and if anything removes that file the database silently reverts to whatever
// it looked like at the last checkpoint. That is what happened: the main file
// was six days stale and perfectly intact, so nothing reported an error —
// the app just came up missing a week.
//
// Three defences, cheapest first:
//   1. checkpoint on a timer, so the WAL is never the only copy for long
//   2. a snapshot before every migration and once a day, kept for a while
//   3. an integrity check at open, with a fall back to the newest good
//      snapshot rather than presenting an empty app as if nothing is wrong

const KEEP = 10
const DAILY_MS = 24 * 60 * 60 * 1000
const CHECKPOINT_MS = 3 * 60 * 1000

export function backupDir(userDataDir: string): string {
  const dir = join(userDataDir, 'backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

function snapshots(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith('asit-') && f.endsWith('.db'))
      .sort()
      .reverse() // newest first (timestamped names sort lexically)
  } catch {
    return []
  }
}

/**
 * Point-in-time copy. Uses SQLite's own backup path (VACUUM INTO) rather than
 * copying the file, so it is consistent even with a live WAL and writers.
 */
export function snapshot(db: Database, userDataDir: string, tag: string): string | null {
  const dir = backupDir(userDataDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `asit-${stamp}-${tag}.db`)
  try {
    db.prepare(`VACUUM INTO ?`).run(dest)
  } catch (err) {
    logError('db backup', err)
    return null
  }
  for (const old of snapshots(dir).slice(KEEP)) {
    try {
      renameSync(join(dir, old), join(dir, old + '.old'))
    } catch {
      // best effort; never let pruning break startup
    }
  }
  return dest
}

/** Once a day is plenty for a local app; more just costs disk. */
export function snapshotIfDue(db: Database, userDataDir: string): void {
  const dir = backupDir(userDataDir)
  const newest = snapshots(dir)[0]
  if (newest) {
    try {
      if (Date.now() - statSync(join(dir, newest)).mtimeMs < DAILY_MS) return
    } catch {
      // unreadable — take one
    }
  }
  snapshot(db, userDataDir, 'daily')
}

/**
 * Fold the WAL into the main file periodically. PASSIVE never blocks a reader
 * or writer: if the database is busy it simply does nothing and tries again
 * later. This is what stops recent work from living in one file for days.
 */
export function startCheckpointing(db: Database): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      db.pragma('wal_checkpoint(PASSIVE)')
    } catch (err) {
      logError('db checkpoint', err)
    }
  }, CHECKPOINT_MS)
  timer.unref?.()
  return timer
}

/** `quick_check` — same detection as integrity_check, without reading it all. */
export function isHealthy(db: Database): boolean {
  try {
    const rows = db.pragma('quick_check') as { quick_check: string }[]
    return rows.length === 1 && rows[0].quick_check === 'ok'
  } catch {
    return false
  }
}

/**
 * The database could not be opened or failed its check. Move it aside (never
 * delete — a corrupt database is still the user's data and can often be
 * partially recovered) and put the newest good snapshot in its place.
 */
export function restoreFromSnapshot(dbPath: string, userDataDir: string): string | null {
  const dir = backupDir(userDataDir)
  for (const name of snapshots(dir)) {
    const candidate = join(dir, name)
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      if (existsSync(dbPath)) renameSync(dbPath, `${dbPath}.unreadable-${stamp}`)
      copyFileSync(candidate, dbPath)
      return name
    } catch (err) {
      logError('db restore', err)
    }
  }
  return null
}
