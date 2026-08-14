import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { migrate } from './migrations'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = join(app.getPath('userData'), 'asit.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
  }
  return db
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
