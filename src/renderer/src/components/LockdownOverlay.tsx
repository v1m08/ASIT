import { useEffect, useRef, useState } from 'react'
import { useOverlay } from '../hooks/useOverlay'

// Escape-friction overlay. The renderer only *displays* progress — the main
// process owns the clock and validates the hold duration / phrase, so this
// can't be bypassed by fiddling with the UI.
export default function LockdownOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  useOverlay(true)

  const [holdSec, setHoldSec] = useState(0)
  const [holding, setHolding] = useState(false)
  const [requiredSec, setRequiredSec] = useState(30)
  const [phrase, setPhrase] = useState('')
  const [expectedPhrase, setExpectedPhrase] = useState('')
  const [phraseError, setPhraseError] = useState(false)
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    window.asit.settings.get().then((s) => {
      setRequiredSec(s.holdToQuitSeconds)
      setExpectedPhrase(s.escapePhrase)
    })
    return () => {
      if (holdTimer.current) clearInterval(holdTimer.current)
    }
  }, [])

  function startHold(): void {
    setHolding(true)
    setHoldSec(0)
    window.asit.lockdown.holdStart()
    const startedAt = Date.now()
    holdTimer.current = setInterval(() => {
      setHoldSec((Date.now() - startedAt) / 1000)
    }, 100)
  }

  async function endHold(): Promise<void> {
    if (!holding) return
    setHolding(false)
    if (holdTimer.current) clearInterval(holdTimer.current)
    const result = await window.asit.lockdown.releaseHold()
    if (result.ok) {
      onClose() // session ended in main; phase-changed push updates the UI
    } else {
      setHoldSec(0)
    }
  }

  async function submitPhrase(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const result = await window.asit.lockdown.releasePhrase(phrase)
    if (result.ok) onClose()
    else {
      setPhraseError(true)
      setTimeout(() => setPhraseError(false), 1500)
    }
  }

  const progress = Math.min(1, holdSec / requiredSec)

  return (
    <div className="lockdown-overlay">
      <div className="lockdown-box">
        <h2>Leaving your focus session?</h2>
        <p className="lockdown-sub"> The point of the lock is that quitting takes longer than getting back to work. If you
          still want out, hold the button for {requiredSec} seconds — or type the phrase exactly.
        </p>

        <button
          className="hold-btn"
          onPointerDown={startHold}
          onPointerUp={endHold}
          onPointerLeave={endHold}
        >
          <div className="hold-progress" style={{ width: `${progress * 100}%` }} />
          <span className="hold-label">
            {holding ? `Keep holding… ${Math.max(0, requiredSec - holdSec).toFixed(0)}s` : 'Hold to give up'}
          </span>
        </button>

        <form onSubmit={submitPhrase} className="phrase-form">
          <p className="phrase-prompt">Or type: “{expectedPhrase}”</p>
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="Type the phrase exactly"
            className={phraseError ? 'phrase-wrong' : ''}
          />
        </form>

        <button className="btn btn-primary lockdown-back" onClick={onClose}>
          ← Back to work
        </button>
      </div>
    </div>
  )
}
