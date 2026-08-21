import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, renameSync } from 'fs'
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
      // The commonest cause by far: a -wal/-shm left by a previous run that
      // belongs to a DIFFERENT database file. SQLite pairs them by checksum,
      // so a mismatch reads as "database disk image is malformed" even though
      // both files are individually perfect. They are regenerable, and at this
      // point unusable anyway, so move them aside and try again BEFORE
      // reaching for a backup.
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        if (!existsSync(sidecar)) continue
        try {
          renameSync(sidecar, `${sidecar}.mismatched-${Date.now()}`)
        } catch (err) {
          logError('db sidecar', err)
        }
      }
      opened = openAt(dbPath)
      if (opened && isHealthy(opened)) {
        logError('db open', new Error('recovered by clearing mismatched WAL/SHM sidecars'))
        db = opened
        finishOpen(db, userData)
        return db
      }
      try {
        opened?.close()
      } catch {
        // unusable
      }

      const restored = restoreFromSnapshot(dbPath, userData)
      opened = openAt(dbPath)
      if (restored) logError('db restore', new Error(`restored from backup ${restored}`))
      if (!opened) throw new Error('could not open the database, and no usable backup exists')
    }
    db = opened
    finishOpen(db, userData)
  }
  return db
}

/** Snapshot, migrate, and start the keep-it-recoverable machinery. */
function finishOpen(d: Database.Database, userData: string): void {
  // Snapshot BEFORE migrating: a migration is the one moment the schema is
  // rewritten, and the copy has to predate it to be worth anything.
  const from = d.pragma('user_version', { simple: true }) as number
  if (from < MIGRATION_COUNT) snapshot(d, userData, `pre-v${from}`)
  migrate(d)
  snapshotIfDue(d, userData)
  startCheckpointing(d)
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
