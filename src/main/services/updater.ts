import { app, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { logError } from '../log'
import type { UpdateStatus } from '@shared/types'

// Automatic updates.
//
// Installing this app has meant: build it, find the installer, close the app,
// run the installer, reopen. Every single time. That is a chore nobody keeps
// doing, which is how you end up running a build from six days ago and
// reporting bugs that were fixed on day two — which is exactly what happened.
//
// So: check quietly in the background, download in the background, and say one
// sentence when it is ready. Nothing is ever installed under the user mid-task
// — a restart is the trigger, because replacing a running app's files while it
// holds a database open is how the database got corrupted in the first place.


const state: UpdateStatus = {
  supported: false,
  checking: false,
  available: null,
  downloaded: null,
  error: null,
  lastCheckedAt: null
}

let getWindow: (() => BrowserWindow | null) | null = null
let timer: NodeJS.Timeout | null = null

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 30 * 1000 // let the app finish starting first

function push(): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.UPDATE_STATUS, state)
}

/** Loaded lazily: electron-updater pulls in a lot, and dev never needs it. */
async function autoUpdater(): Promise<typeof import('electron-updater').autoUpdater> {
  const mod = await import('electron-updater')
  // CJS interop — rollup wraps it, so the real export can sit on .default.
  const updater = (mod.autoUpdater ??
    (mod as unknown as { default: typeof mod }).default.autoUpdater) as typeof mod.autoUpdater
  updater.autoDownload = true
  // NEVER install behind the user's back. Swapping files under a running app
  // that holds the database open is precisely how data got lost here.
  updater.autoInstallOnAppQuit = true
  return updater
}

export function initUpdater(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
  // Unpackaged builds have no update feed, and a smoke run must never phone
  // home or mutate an install.
  state.supported = app.isPackaged && !process.env.ASIT_NO_UPDATE
  if (!state.supported) return

  void (async () => {
    try {
      const updater = await autoUpdater()
      updater.on('checking-for-update', () => {
        state.checking = true
        state.error = null
        push()
      })
      updater.on('update-available', (info) => {
        state.checking = false
        state.available = info.version
        push()
      })
      updater.on('update-not-available', () => {
        state.checking = false
        state.available = null
        state.lastCheckedAt = Date.now()
        push()
      })
      updater.on('update-downloaded', (info) => {
        state.downloaded = info.version
        state.checking = false
        push()
      })
      updater.on('error', (err) => {
        // Being offline is the common case, not a fault worth shouting about.
        state.checking = false
        state.error = err instanceof Error ? err.message : String(err)
        push()
      })

      timer = setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)
      timer.unref?.()
      setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS).unref?.()
    } catch (err) {
      logError('updater init', err)
      state.supported = false
    }
  })()
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!state.supported) return state
  try {
    const updater = await autoUpdater()
    await updater.checkForUpdates()
    state.lastCheckedAt = Date.now()
  } catch (err) {
    state.checking = false
    state.error = err instanceof Error ? err.message : String(err)
    logError('updater check', err)
  }
  push()
  return state
}

/** Quit and install the downloaded update. Only ever called by the user. */
export async function installUpdate(): Promise<void> {
  if (!state.downloaded) return
  const updater = await autoUpdater()
  // Close the database cleanly first; the installer replaces files underneath.
  const { closeDb } = await import('../db')
  try {
    closeDb()
  } catch (err) {
    logError('updater closeDb', err)
  }
  updater.quitAndInstall(false, true)
}

export function updateStatus(): UpdateStatus {
  return state
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
