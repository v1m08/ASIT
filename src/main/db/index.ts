import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { MIGRATION_COUNT, migrate } from './migrations'
import {
  isHealthy,
  restoreFromSnapshot,
  snapshot,
  snapshotIfDue,
  startCheckpointing
} from './backup'
import { logError } from '../log'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    const userData = app.getPath('userData')
    const dbPath = join(userData, 'asit.db')

    let opened = openAt(dbPath)
    if (!opened || !isHealthy(opened)) {
      // Do NOT carry on with a broken database: the app would come up looking
      // empty, which reads as "my data is gone" and invites the user to start
      // over on top of it. Move it aside and fall back to a snapshot.
      logError('db open', new Error(`asit.db is unreadable or failed its integrity check`))
      try {
        opened?.close()
      } catch {
        // already unusable
      }
      const restored = restoreFromSnapshot(dbPath, userData)
      opened = openAt(dbPath)
      if (restored) logError('db restore', new Error(`restored from backup ${restored}`))
      if (!opened) throw new Error('could not open the database, and no usable backup exists')
    }
    db = opened

    // Snapshot BEFORE migrating: a migration is the one moment the schema is
    // rewritten, and the copy has to predate it to be worth anything.
    const from = db.pragma('user_version', { simple: true }) as number
    if (from < MIGRATION_COUNT) snapshot(db, userData, `pre-v${from}`)
    migrate(db)

    snapshotIfDue(db, userData)
    startCheckpointing(db)
  }
  return db
}

/** Open + pragmas, or null if the file cannot be opened at all. */
function openAt(dbPath: string): Database.Database | null {
  try {
    const d = new Database(dbPath)
    d.pragma('journal_mode = WAL')
    d.pragma('foreign_keys = ON')
    return d
  } catch (err) {
    logError('db open', err)
    return null
  }
}

export function closeDb(): void {
  if (db) {
    try {
      // SQLite's recommended shutdown hygiene: refresh planner stats and fold
      // the WAL back into the main file so the db starts compact next launch.
      db.pragma('optimize')
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // never let cleanup block shutdown
    }
    db.close()
    db = null
  }
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

export function nowIso(): string {
  return new Date().toISOString()
}
