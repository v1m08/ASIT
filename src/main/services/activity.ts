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

const KEEP_FINISHED = 6

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

export function listActivity(): ActivityItem[] {
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
  } else {
    items.delete(id) // nothing to jump to
  }
  push()
}

/** User dismissed a finished entry. */
export function dismissActivity(id: string): void {
  if (items.delete(id)) push()
}
