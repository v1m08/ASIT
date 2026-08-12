import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-contract'

// Central registry of everything currently running in the background —
// chat/agent turns, question jobs, assistant runs. Work lives in the main
// process, so it survives leaving a workspace; this makes it VISIBLE.

export interface ActivityItem {
  id: string
  kind: 'chat' | 'assistant' | 'questions' | 'watch'
  taskId: string | null
  label: string
  detail: string | null // live status ("Running: python train.py…") for hover
  startedAt: number
}

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
}

export function listActivity(): ActivityItem[] {
  return [...items.values()].sort((a, b) => a.startedAt - b.startedAt)
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
    startedAt: existing?.startedAt ?? Date.now()
  })
  push()
}

export function clearActivity(id: string): void {
  if (items.delete(id)) push()
}
