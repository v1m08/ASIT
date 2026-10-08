import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'

// Where ASIT keeps the user's files (task folders, private, library, skills,
// memory, trash). ONE definition — every service asks here.
//
// Windows: Documents\ASIT, as always.
// macOS: ~/ASIT. ~/Documents is privacy-gated (TCC): a process without the
// Documents grant gets EPERM on every write and fs.watch — and so does every
// `claude` CLI agent spawned with cwd inside it. That silently killed task
// folders, CLAUDE.md, notes and the action channel whenever ASIT ran without
// the grant (any dev run launched from another app, or a user who clicked
// "Don't Allow"). The home folder itself is not gated, needs no prompt, and is
// one click away in Finder.
//
// Smoke runs redirect 'documents' to a temp dir; they set ASIT_ROOT so the
// macOS path follows them there too (invariant 9).

let resolved: string | null = null

function legacyRoot(): string {
  return join(app.getPath('documents'), 'ASIT')
}

export function asitRoot(): string {
  if (process.env.ASIT_ROOT) return process.env.ASIT_ROOT
  if (resolved) return resolved
  resolved = process.platform === 'darwin' ? join(app.getPath('home'), 'ASIT') : legacyRoot()
  return resolved
}

/**
 * macOS move from ~/Documents/ASIT to ~/ASIT. Call after the DB is open,
 * before any service touches the tree. The DB stores absolute folder and file
 * paths, so those are rewritten too.
 *
 * Without the Documents grant the old tree can't be moved OR used, so ASIT
 * switches to ~/ASIT anyway (folders are recreated on demand) and leaves the
 * old files where they are. A later launch that CAN read them merges anything
 * missing into ~/ASIT, never overwriting, and renames the old folder so the
 * merge runs once. Nothing is deleted at any point (invariant 5).
 */
export function migrateRootIfNeeded(): void {
  if (process.platform !== 'darwin' || process.env.ASIT_ROOT) return
  const from = legacyRoot()
  const to = asitRoot()
  if (!existsSync(from)) return
  if (!existsSync(to)) {
    try {
      renameSync(from, to)
      console.log(`[paths] moved ASIT data ${from} -> ${to}`)
    } catch (err) {
      console.warn(
        `[paths] no access to ${from} (${(err as NodeJS.ErrnoException).code ?? err}); ` +
          `using ${to} — old files merge in on a launch with Documents access`
      )
      mkdirSync(to, { recursive: true })
    }
    rewriteDbPaths(from, to)
    return
  }
  // Both exist: finish an earlier migration that couldn't read the old tree.
  try {
    mergeMissing(from, to)
    renameSync(from, `${from} (moved to ~-ASIT)`)
    rewriteDbPaths(from, to)
    console.log(`[paths] merged leftover ${from} into ${to}`)
  } catch {
    /* still no access — try again next launch */
  }
}

/** Move entries of `from` that `to` lacks; recurse into dirs both have. */
function mergeMissing(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name)
    const dst = join(to, name)
    if (!existsSync(dst)) renameSync(src, dst)
    else if (statSync(src).isDirectory() && statSync(dst).isDirectory()) mergeMissing(src, dst)
  }
}

/** Replace an absolute path prefix in every TEXT column of every table. */
function rewriteDbPaths(from: string, to: string): void {
  const db = getDb()
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]
  db.transaction(() => {
    for (const { name } of tables) {
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]
      for (const c of cols) {
        if (!/TEXT/i.test(c.type)) continue
        db.prepare(
          `UPDATE "${name}" SET "${c.name}" = replace("${c.name}", ?, ?) WHERE instr("${c.name}", ?) > 0`
        ).run(from, to, from)
      }
    }
  })()
}
