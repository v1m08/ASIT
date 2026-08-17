import { useEffect, useState } from 'react'
import { useOverlay } from '../hooks/useOverlay'
import ReviewCards from './ReviewCards'

// When a break starts, surface due recall questions for the active task —
// the ideal moment for retrieval practice. Skips itself if nothing is due.
export default function BreakReview({
  taskId,
  remainingSec,
  onClose
}: {
  taskId: string
  remainingSec: number
  onClose: () => void
}): JSX.Element | null {
  const [hasDue, setHasDue] = useState<boolean | null>(null)
  useOverlay(hasDue === true)

  useEffect(() => {
    window.asit.questions.due(1, taskId).then((due) => {
      if (due.length === 0) onClose()
      else setHasDue(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  if (!hasDue) return null

  const m = Math.floor(remainingSec / 60)
  const s = remainingSec % 60

  return (
    <div className="lockdown-overlay">
      <div className="break-review">
        <div className="break-review-head">
          <h2>☕ Break — quick recall</h2>
          <span className="timer-clock">
            {m}:{String(s).padStart(2, '0')}
          </span>
        </div>
        <ReviewCards taskId={taskId} onDone={onClose} />
        <button className="btn btn-ghost" onClick={onClose}> Skip review
        </button>
      </div>
    </div>
  )
}
