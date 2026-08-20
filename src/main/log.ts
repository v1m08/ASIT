import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

// Errors, written somewhere you can actually read them.
//
// In a packaged build console.error goes to a console nobody sees, so the only
// evidence of a failure was whatever string reached the UI — usually something
// like "Error invoking remote method 'usage:summary'" with the cause stripped.
// That is not enough to diagnose anything, and it is why bugs here have felt
// unfinished: the app knew exactly what went wrong and had no way to say so.
//
// Deliberately small: one file, capped, no levels, no dependencies. It records
// what broke, not what happened.

const MAX_BYTES = 512 * 1024

function logPath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'asit-errors.log')
}

/** Keep one previous file so a crash loop can't erase the first failure. */
function rotateIfBig(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, file + '.1')
    }
  } catch {
    // rotation is best-effort
  }
}

export function logError(where: string, err: unknown): void {
  const detail =
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  // Console too — dev runs read it there.
  console.error(`[${where}]`, err)
  try {
    const file = logPath()
    rotateIfBig(file)
    appendFileSync(file, `${new Date().toISOString()} [${where}] ${detail}\n`, 'utf-8')
  } catch {
    // If we cannot log the failure we are not going to make things worse by
    // throwing from the logger.
  }
}

/**
 * Anything that escapes to the top. Without this an unhandled rejection in
 * main is completely silent, and the symptom shows up somewhere unrelated —
 * a boot-time throw before IPC registration, for instance, leaves every
 * channel unhandled and the UI just says a remote method failed.
 */
export function installCrashLogging(): void {
  process.on('uncaughtException', (err) => logError('uncaughtException', err))
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason))
}

export function errorLogPath(): string {
  return join(app.getPath('userData'), 'asit-errors.log')
}
