import { getDb, newId, nowIso } from '../db'
import { getTask } from './tasks'
import { bus } from './bus'

// Time-based automation: the app doing things WITHOUT being asked.
//
// Everything else in ASIT is reactive — it acts when you type. This is the
// piece that makes it an assistant rather than a tool: "every weekday at 8,
// summarise what's due", "in 30 minutes check if the build finished". A
// schedule is a prompt plus a firing rule; when it fires the prompt runs
// through the normal agent, so a schedule can do anything the agent can do.
//
// Deliberate constraints:
//   * Firing goes through the SAME guardrails as a typed message. Sends stay
//     deny-by-default: a schedule whose prompt says "email Bob" will DRAFT,
//     not send, because authorizeSendsFromUserMessage runs on that prompt just
//     as it would for a live turn. An unattended loop must not message people.
//   * One run at a time; if the agent is busy the tick is skipped rather than
//     piling turns up.
//   * Nothing fires while the app is closed, and missed runs roll FORWARD
//     instead of replaying — opening your laptop after a week must not dump
//     seven briefings on you at once.

export type RepeatKind = 'once' | 'hourly' | 'daily' | 'weekdays'

export interface Schedule {
  id: string
  prompt: string
  taskId: string | null
  repeat: RepeatKind
  nextAt: string
  enabled: boolean
  lastRunAt: string | null
  lastResult: string | null
  createdAt: string
}

function rowTo(row: Record<string, unknown>): Schedule {
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    taskId: (row.task_id as string) ?? null,
    repeat: row.repeat as RepeatKind,
    nextAt: row.next_at as string,
    enabled: (row.enabled as number) === 1,
    lastRunAt: (row.last_run_at as string) ?? null,
    lastResult: (row.last_result as string) ?? null,
    createdAt: row.created_at as string
  }
}

export function listSchedules(): Schedule[] {
  const rows = getDb()
    .prepare('SELECT * FROM schedules ORDER BY next_at ASC')
    .all() as Record<string, unknown>[]
  return rows.map(rowTo)
}

/**
 * Parse the kinds of time a person actually writes. Returns null when it can't
 * be understood — refusing beats silently scheduling the wrong moment.
 */
export function parseWhen(
  when: string,
  now = new Date()
): { at: Date; repeat: RepeatKind } | null {
  const w = when.trim().toLowerCase()

  const rel = w.match(/^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2][0]
    const ms = unit === 'm' ? n * 60000 : unit === 'h' ? n * 3600000 : n * 86400000
    return { at: new Date(now.getTime() + ms), repeat: 'once' }
  }

  if (w === 'hourly' || w === 'every hour') {
    return { at: new Date(now.getTime() + 3600000), repeat: 'hourly' }
  }

  const timed = w.match(
    /^(?:(daily|every day|weekdays|weekday|once|today|tomorrow)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/
  )
  if (timed) {
    const word = timed[1] ?? 'daily'
    let hour = Number(timed[2])
    const min = Number(timed[3] ?? 0)
    const ampm = timed[4]
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
    if (hour > 23 || min > 59) return null
    const at = new Date(now)
    at.setHours(hour, min, 0, 0)
    if (word === 'tomorrow') at.setDate(at.getDate() + 1)
    else if (at <= now) at.setDate(at.getDate() + 1) // that time already passed today
    const repeat: RepeatKind =
      word === 'weekdays' || word === 'weekday'
        ? 'weekdays'
        : word === 'once' || word === 'today' || word === 'tomorrow'
          ? 'once'
          : 'daily'
    return { at: advanceForWeekdays(at, repeat), repeat }
  }
  return null
}

/** Weekday schedules skip Saturday and Sunday. */
function advanceForWeekdays(at: Date, repeat: RepeatKind): Date {
  if (repeat !== 'weekdays') return at
  const d = new Date(at)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

export function addSchedule(input: {
  prompt: string
  when: string
  taskId?: string | null
}): { ok: true; schedule: Schedule } | { ok: false; reason: string } {
  const parsed = parseWhen(input.when)
  if (!parsed) {
    return {
      ok: false,
      reason: `couldn't understand "${input.when}" — try "08:00", "weekdays 7:30", "in 30m", or "hourly"`
    }
  }
  const prompt = input.prompt.trim()
  if (!prompt) return { ok: false, reason: 'a schedule needs a prompt to run' }

  const s: Schedule = {
    id: newId(),
    prompt: prompt.slice(0, 2000),
    taskId: input.taskId ?? null,
    repeat: parsed.repeat,
    nextAt: parsed.at.toISOString(),
    enabled: true,
    lastRunAt: null,
    lastResult: null,
    createdAt: nowIso()
  }
  getDb()
    .prepare(
      'INSERT INTO schedules (id, prompt, task_id, repeat, next_at, enabled, last_run_at, last_result, created_at) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?)'
    )
    .run(s.id, s.prompt, s.taskId, s.repeat, s.nextAt, s.createdAt)
  bus.emit('changed', 'schedules')
  return { ok: true, schedule: s }
}

export function removeSchedule(id: string): void {
  getDb().prepare('DELETE FROM schedules WHERE id = ?').run(id)
  bus.emit('changed', 'schedules')
}

export function setScheduleEnabled(id: string, enabled: boolean): void {
  getDb().prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  bus.emit('changed', 'schedules')
}

/** Move to the next firing time. `once` schedules are deleted instead. */
function rollForward(s: Schedule): void {
  const db = getDb()
  if (s.repeat === 'once') {
    db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id)
    return
  }
  const next = new Date()
  if (s.repeat === 'hourly') {
    next.setTime(next.getTime() + 3600000)
  } else {
    // Keep the original clock time, move to the next day.
    const prev = new Date(s.nextAt)
    next.setHours(prev.getHours(), prev.getMinutes(), 0, 0)
    next.setDate(next.getDate() + 1)
  }
  const at = advanceForWeekdays(next, s.repeat)
  db.prepare('UPDATE schedules SET next_at = ? WHERE id = ?').run(at.toISOString(), s.id)
}

let timer: NodeJS.Timeout | null = null
let firing = false

/** Started once at launch. Schedules are minute-grained, so 30s is plenty. */
export function initScheduler(): void {
  if (timer) return
  timer = setInterval(() => {
    void tick()
  }, 30000)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export async function tick(now = new Date()): Promise<string[]> {
  if (firing) return []
  const due = listSchedules().filter((s) => s.enabled && new Date(s.nextAt) <= now)
  if (due.length === 0) return []

  firing = true
  const ran: string[] = []
  try {
    // Cap per tick: these start real agent turns.
    for (const s of due.slice(0, 3)) {
      // A schedule pointing at a deleted workspace is dead weight.
      if (s.taskId && !getTask(s.taskId)) {
        removeSchedule(s.id)
        continue
      }
      try {
        await runSchedule(s)
        ran.push(s.id)
      } catch (err) {
        getDb()
          .prepare('UPDATE schedules SET last_result = ? WHERE id = ?')
          .run(`failed: ${err instanceof Error ? err.message : String(err)}`, s.id)
      }
      rollForward(s)
    }
  } finally {
    firing = false
    bus.emit('changed', 'schedules')
  }
  return ran
}

async function runSchedule(s: Schedule): Promise<void> {
  getDb()
    .prepare('UPDATE schedules SET last_run_at = ?, last_result = ? WHERE id = ?')
    .run(nowIso(), 'running', s.id)

  // Dynamic import: chat/jarvis reach into panes and Electron, and this file
  // must stay loadable from a headless test.
  if (s.taskId) {
    const { startWorkspaceChat } = await import('./chat')
    const r = await startWorkspaceChat(s.taskId, s.prompt)
    getDb()
      .prepare('UPDATE schedules SET last_result = ? WHERE id = ?')
      .run(r.started ? 'started' : `skipped: ${r.reason ?? 'busy'}`, s.id)
    return
  }
  const { startJarvisTurn } = await import('./jarvis')
  const r = startJarvisTurn(s.prompt)
  getDb()
    .prepare('UPDATE schedules SET last_result = ? WHERE id = ?')
    .run(r.started ? (r.queued ? 'queued' : 'started') : `skipped: ${r.reason ?? 'busy'}`, s.id)
}
