import type { BrowserWindow } from 'electron'
import { getDb, newId, nowIso } from '../db'
import { IPC } from '@shared/ipc-contract'
import { lockdown } from './lockdown'
import { getSettings } from './settings'

import type { TimerMode, TimerState } from '@shared/types'

// Authoritative pomodoro state machine. Lives in main so a renderer reload
// can't kill a session, and so lockdown/escape validation can't be spoofed
// from devtools.
class TimerService {
  private getWindow: (() => BrowserWindow | null) | null = null
  private interval: NodeJS.Timeout | null = null
  private holdStartedAt: number | null = null

  private state: TimerState = {
    sessionId: null,
    taskId: null,
    mode: 'stopwatch',
    phase: 'idle',
    pausedFrom: null,
    elapsedSec: 0,
    remainingSec: 0,
    workMin: 25,
    breakMin: 5,
    phasesCompleted: 0,
    workSecondsDone: 0,
    lockdownEngaged: false
  }

  init(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
    // Crash sweep: close out sessions that never ended (app was killed).
    getDb()
      .prepare(
        "UPDATE sessions SET ended_at = started_at, ended_via = 'crash' WHERE ended_at IS NULL"
      )
      .run()
  }

  getState(): TimerState {
    return { ...this.state, lockdownEngaged: lockdown.isEngaged() }
  }

  private push(channel: string): void {
    const win = this.getWindow?.()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, this.getState())
    }
  }

  // Default is a STOPWATCH: lockdown engages and time counts up until the
  // user ends the session (with friction). Pomodoro (timed work/break cycles)
  // is the opt-in variant.
  start(taskId: string, mode: TimerMode = 'stopwatch', workMin?: number, breakMin?: number): TimerState {
    if (this.state.phase !== 'idle') return this.getState()
    const settings = getSettings()
    const w = Math.max(1, workMin ?? settings.workMin)
    const b = Math.max(1, breakMin ?? settings.breakMin)

    const sessionId = newId()
    getDb()
      .prepare(
        'INSERT INTO sessions (id, task_id, started_at, work_min, break_min) VALUES (?, ?, ?, ?, ?)'
      )
      .run(sessionId, taskId, nowIso(), mode === 'pomodoro' ? w : 0, mode === 'pomodoro' ? b : 0)

    this.state = {
      sessionId,
      taskId,
      mode,
      phase: 'work',
      pausedFrom: null,
      elapsedSec: 0,
      remainingSec: mode === 'pomodoro' ? w * 60 : 0,
      workMin: w,
      breakMin: b,
      phasesCompleted: 0,
      workSecondsDone: 0,
      lockdownEngaged: true
    }

    lockdown.engage()
    this.interval = setInterval(() => this.tick(), 1000)
    this.push(IPC.SESSION_PHASE_CHANGED)
    return this.getState()
  }

  private tick(): void {
    if (this.state.phase === 'paused') return
    this.state.elapsedSec++
    if (this.state.phase === 'work') this.state.workSecondsDone++
    if (this.state.workSecondsDone > 0 && this.state.workSecondsDone % 60 === 0) {
      this.persistProgress() // once a minute, so a crash loses <1min of stopwatch time
    }

    if (this.state.mode === 'stopwatch') {
      this.push(IPC.SESSION_TICK)
      return
    }

    this.state.remainingSec--
    if (this.state.remainingSec <= 0) {
      if (this.state.phase === 'work') {
        this.state.phasesCompleted++
        this.state.phase = 'break'
        this.state.remainingSec = this.state.breakMin * 60
        lockdown.relax()
        this.persistProgress()
        this.push(IPC.SESSION_PHASE_CHANGED)
      } else {
        this.state.phase = 'work'
        this.state.remainingSec = this.state.workMin * 60
        lockdown.tighten()
        this.push(IPC.SESSION_PHASE_CHANGED)
      }
      return
    }
    this.push(IPC.SESSION_TICK)
  }

  pause(): TimerState {
    if (this.state.phase === 'work' || this.state.phase === 'break') {
      this.state.pausedFrom = this.state.phase
      this.state.phase = 'paused'
      this.push(IPC.SESSION_PHASE_CHANGED)
    }
    return this.getState()
  }

  resume(): TimerState {
    if (this.state.phase === 'paused' && this.state.pausedFrom) {
      this.state.phase = this.state.pausedFrom
      this.state.pausedFrom = null
      this.push(IPC.SESSION_PHASE_CHANGED)
    }
    return this.getState()
  }

  private persistProgress(): void {
    if (!this.state.sessionId) return
    getDb()
      .prepare('UPDATE sessions SET work_seconds_done = ?, phases_completed = ? WHERE id = ?')
      .run(this.state.workSecondsDone, this.state.phasesCompleted, this.state.sessionId)
  }

  // Free end — only when NOT in a locked work phase. Work-phase exits must go
  // through the friction paths below.
  end(): { ok: boolean; reason?: string } {
    if (this.state.phase === 'idle') return { ok: true }
    const inLockedWork =
      this.state.phase === 'work' || (this.state.phase === 'paused' && this.state.pausedFrom === 'work')
    if (inLockedWork) {
      return { ok: false, reason: 'locked' }
    }
    this.finish('completed')
    return { ok: true }
  }

  // --- Escape friction (main owns the clock; renderer UI is display-only) ---

  holdStart(): void {
    this.holdStartedAt = Date.now()
  }

  holdCancel(): void {
    this.holdStartedAt = null
  }

  holdRelease(): { ok: boolean; heldSec: number; requiredSec: number } {
    const requiredSec = getSettings().holdToQuitSeconds
    if (this.holdStartedAt === null) return { ok: false, heldSec: 0, requiredSec }
    const heldSec = (Date.now() - this.holdStartedAt) / 1000
    this.holdStartedAt = null
    if (heldSec >= requiredSec) {
      this.finish('hold_quit')
      return { ok: true, heldSec, requiredSec }
    }
    return { ok: false, heldSec, requiredSec }
  }

  phraseRelease(phrase: string): { ok: boolean } {
    if (phrase.trim() === getSettings().escapePhrase.trim()) {
      this.finish('phrase')
      return { ok: true }
    }
    return { ok: false }
  }

  private finish(via: 'completed' | 'hold_quit' | 'phrase'): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (this.state.sessionId) {
      getDb()
        .prepare(
          'UPDATE sessions SET ended_at = ?, ended_via = ?, work_seconds_done = ?, phases_completed = ? WHERE id = ?'
        )
        .run(
          nowIso(),
          via,
          this.state.workSecondsDone,
          this.state.phasesCompleted,
          this.state.sessionId
        )
    }
    lockdown.disengage()
    this.state = {
      sessionId: null,
      taskId: null,
      mode: 'stopwatch',
      phase: 'idle',
      pausedFrom: null,
      elapsedSec: 0,
      remainingSec: 0,
      workMin: this.state.workMin,
      breakMin: this.state.breakMin,
      phasesCompleted: 0,
      workSecondsDone: 0,
      lockdownEngaged: false
    }
    this.holdStartedAt = null
    this.push(IPC.SESSION_PHASE_CHANGED)
  }
}

export const timer = new TimerService()
