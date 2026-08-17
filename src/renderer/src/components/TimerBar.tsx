import { useEffect, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { Task, TimerState } from '@shared/types'
import LockdownOverlay from './LockdownOverlay'

function fmt(sec: number): string {
  const total = Math.max(0, sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function useTimerState(): TimerState | null {
  const [state, setState] = useState<TimerState | null>(null)

  useEffect(() => {
    window.asit.session.state().then(setState)
    const offTick = window.asit.on(IPC.SESSION_TICK, (...args: unknown[]) =>
      setState(args[0] as TimerState)
    )
    const offPhase = window.asit.on(IPC.SESSION_PHASE_CHANGED, (...args: unknown[]) =>
      setState(args[0] as TimerState)
    )
    return () => {
      offTick()
      offPhase()
    }
  }, [])

  return state
}

export default function TimerBar({ task }: { task: Task }): JSX.Element {
  const state = useTimerState()
  const [showEscape, setShowEscape] = useState(false)

  if (!state) return <div className="timer-bar" />

  const idle = state.phase === 'idle'
  const inWork = state.phase === 'work' || (state.phase === 'paused' && state.pausedFrom === 'work')

  async function handleEnd(): Promise<void> {
    const result = await window.asit.session.end()
    if (!result.ok && result.reason === 'locked') setShowEscape(true)
  }

  return (
    <div className="timer-bar">
      {idle ? (
        <>
          <button
            className="btn btn-primary"
            onClick={() => window.asit.session.start(task.id, 'stopwatch')}
            title="Start focus: locks the screen and tracks your time (stopwatch)"
          >
            ▶ Focus
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => window.asit.session.start(task.id, 'pomodoro')}
            title="Focus with a pomodoro timer (work/break cycles from Settings)"
          >
            ⏱
          </button>
        </>
      ) : (
        <>
          <span className={`timer-phase timer-${state.phase}`}>
            {state.phase === 'work' ? '⚿ Focus' : state.phase === 'break' ? '☕ Break' : '⏸ Paused'}
          </span>
          <span className="timer-clock">
            {state.mode === 'stopwatch' ? fmt(state.elapsedSec) : fmt(state.remainingSec)}
          </span>
          {state.mode === 'pomodoro' && (
            <span className="timer-meta">{state.phasesCompleted} done</span>
          )}
          {state.phase === 'paused' ? (
            <button className="btn btn-ghost" onClick={() => window.asit.session.resume()}> Resume
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => window.asit.session.pause()}> Pause
            </button>
          )}
          <button className="btn btn-ghost" onClick={handleEnd}>
            {inWork ? 'Give up…' : 'End'}
          </button>
        </>
      )}
      {showEscape && <LockdownOverlay onClose={() => setShowEscape(false)} />}
    </div>
  )
}
