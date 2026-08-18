import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { bus } from './bus'

// Central registry of everything currently running in the background —
// chat/agent turns, question jobs, assistant runs. Work lives in the main
// process, so it survives leaving a workspace; this makes it VISIBLE.

export interface ActivityItem {
  id: string
  kind: 'chat' | 'assistant' | 'questions' | 'watch' | 'jarvis'
  taskId: string | null
  label: string
  detail: string | null // live status ("Running: python train.py…") for hover
  startedAt: number
  // Finished work is KEPT (dimmed) rather than vanishing, so the header
  // doubles as a workspace monitor: click a finished item to jump to the
  // workspace it ran in.
  done?: boolean
  finishedAt?: number
}

// A finished entry is a NOTIFICATION with a shortcut attached, not a log. It
// stays long enough to notice and click, then goes on its own — otherwise the
// header silently fills with checkmarks for work you already dealt with, and
// clearing them becomes a chore you have to remember to do.
const KEEP_FINISHED = 3
const FINISHED_TTL_MS = 60_000

let getWindow: (() => BrowserWindow | null) | null = null
const items = new Map<string, ActivityItem>()

export function initActivity(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
}

function push(): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.ACTIVITY_UPDATED, listActivity())
  }
  bus.emit('changed', 'activity')
}

/** Drop finished entries that have outlived their welcome. */
function sweepFinished(now = Date.now()): boolean {
  let changed = false
  for (const [id, item] of items) {
    if (item.done && now - (item.finishedAt ?? 0) > FINISHED_TTL_MS) {
      items.delete(id)
      changed = true
    }
  }
  return changed
}

export function listActivity(): ActivityItem[] {
  sweepFinished()
  const all = [...items.values()]
  const running = all.filter((i) => !i.done).sort((a, b) => a.startedAt - b.startedAt)
  const finished = all
    .filter((i) => i.done)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  return [...running, ...finished]
}

export function reportActivity(
  id: string,
  info: { kind: ActivityItem['kind']; taskId?: string | null; label: string; detail?: string }
): void {
  const existing = items.get(id)
  // Streaming calls this per-delta — skip no-op updates to avoid IPC spam.
  if (existing && existing.label === info.label.slice(0, 80) && existing.detail === (info.detail?.slice(0, 160) ?? existing.detail)) {
    return
  }
  items.set(id, {
    id,
    kind: info.kind,
    taskId: info.taskId ?? existing?.taskId ?? null,
    label: info.label.slice(0, 80),
    detail: info.detail?.slice(0, 160) ?? existing?.detail ?? null,
    // Re-running the same id revives the entry as live work.
    startedAt: existing?.done ? Date.now() : (existing?.startedAt ?? Date.now()),
    done: false,
    finishedAt: undefined
  })
  push()
}

/**
 * Work finished. The entry stays as a dimmed, clickable record of where it
 * ran — it used to just disappear, which made background work impossible to
 * follow once it ended.
 */
export function clearActivity(id: string): void {
  const item = items.get(id)
  if (!item) return
  if (item.taskId) {
    items.set(id, { ...item, done: true, finishedAt: Date.now(), detail: item.detail })
    // Keep only the most recent few finished entries.
    const finished = [...items.values()]
      .filter((i) => i.done)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    for (const old of finished.slice(KEEP_FINISHED)) items.delete(old.id)
    // Nothing else is on a clock, so the entry would sit there until something
    // else finished. Wake up once to retire it.
    setTimeout(() => {
      if (sweepFinished()) push()
    }, FINISHED_TTL_MS + 500).unref?.()
  } else {
    items.delete(id) // nothing to jump to
  }
  push()
}

/** User cleared everything finished at once. */
export function dismissFinished(): void {
  let changed = false
  for (const [id, item] of items) {
    if (item.done) {
      items.delete(id)
      changed = true
    }
  }
  if (changed) push()
}

/** User dismissed a finished entry. */
export function dismissActivity(id: string): void {
  if (items.delete(id)) push()
}
