import type { BrowserWindow } from 'electron'
import { getDb, newId, nowIso } from '../db'
import { IPC } from '@shared/ipc-contract'
import type { ClaudeUsage } from './claude'

// Tracks tokens + notional API cost of every Claude call. The user is on a
// subscription, so cost_usd is "what this would have cost via the API" — a
// worth-of-work signal, not a bill.

let getWindow: (() => BrowserWindow | null) | null = null

export function initUsage(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
}

export type UsageKind = 'chat' | 'generate' | 'extract' | 'grade' | 'assistant'

export function logUsage(taskId: string | null, kind: UsageKind, usage: ClaudeUsage): void {
  getDb()
    .prepare(
      `INSERT INTO usage_log (id, task_id, kind, model, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId(),
      taskId,
      kind,
      usage.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.costUsd,
      nowIso()
    )
  const win = getWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.USAGE_UPDATED, { taskId, kind, costUsd: usage.costUsd })
  }
}

export interface UsageTotals {
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  calls: number
}

const TOTALS_SQL = `COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(SUM(input_tokens),0) AS inputTokens,
  COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
  COUNT(*) AS calls`

export function taskUsage(taskId: string): UsageTotals {
  return getDb()
    .prepare(`SELECT ${TOTALS_SQL} FROM usage_log WHERE task_id = ?`)
    .get(taskId) as UsageTotals
}

export interface UsageSummary {
  today: UsageTotals
  week: UsageTotals
  all: UsageTotals
  costByTask: Record<string, number>
}

export interface ActivityDay {
  date: string // YYYY-MM-DD local
  focusSec: number
  costUsd: number
  chats: number
}

// Daily aggregates for the last `days` days (GitHub-graph style history).
export function activityStats(days = 140): ActivityDay[] {
  const db = getDb()
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  const sinceIso = since.toISOString()

  // started_at/created_at are UTC ISO; date() with 'localtime' buckets by local day.
  const focusRows = db
    .prepare(
      `SELECT date(started_at, 'localtime') AS d, SUM(work_seconds_done) AS s
       FROM sessions WHERE started_at >= ? GROUP BY d`
    )
    .all(sinceIso) as { d: string; s: number }[]
  const costRows = db
    .prepare(
      `SELECT date(created_at, 'localtime') AS d, SUM(cost_usd) AS c,
       SUM(CASE WHEN kind = 'chat' THEN 1 ELSE 0 END) AS n
       FROM usage_log WHERE created_at >= ? GROUP BY d`
    )
    .all(sinceIso) as { d: string; c: number; n: number }[]

  const focusMap = new Map(focusRows.map((r) => [r.d, r.s]))
  const costMap = new Map(costRows.map((r) => [r.d, r]))

  const result: ActivityDay[] = []
  const cursor = new Date(since)
  const today = new Date()
  while (cursor <= today) {
    const y = cursor.getFullYear()
    const m = String(cursor.getMonth() + 1).padStart(2, '0')
    const dd = String(cursor.getDate()).padStart(2, '0')
    const key = `${y}-${m}-${dd}`
    const cost = costMap.get(key)
    result.push({
      date: key,
      focusSec: focusMap.get(key) ?? 0,
      costUsd: cost?.c ?? 0,
      chats: cost?.n ?? 0
    })
    cursor.setDate(cursor.getDate() + 1)
  }
  return result
}

export function usageSummary(): UsageSummary {
  const db = getDb()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date(todayStart)
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7))

  const since = (iso: string): UsageTotals =>
    db.prepare(`SELECT ${TOTALS_SQL} FROM usage_log WHERE created_at >= ?`).get(iso) as UsageTotals

  const byTask = db
    .prepare(
      'SELECT task_id, COALESCE(SUM(cost_usd),0) AS c FROM usage_log WHERE task_id IS NOT NULL GROUP BY task_id'
    )
    .all() as { task_id: string; c: number }[]

  return {
    today: since(todayStart.toISOString()),
    week: since(weekStart.toISOString()),
    all: db.prepare(`SELECT ${TOTALS_SQL} FROM usage_log`).get() as UsageTotals,
    costByTask: Object.fromEntries(byTask.map((r) => [r.task_id, r.c]))
  }
}
