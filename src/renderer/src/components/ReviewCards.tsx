import { useCallback, useEffect, useState } from 'react'
import type { Question } from '@shared/types'

type DueQuestion = Question & { taskTitle?: string }

const GRADE_BUTTONS: { grade: 0 | 1 | 2 | 3; label: string; className: string }[] = [
  { grade: 0, label: 'Again', className: 'grade-again' },
  { grade: 1, label: 'Hard', className: 'grade-hard' },
  { grade: 2, label: 'Good', className: 'grade-good' },
  { grade: 3, label: 'Easy', className: 'grade-easy' }
]

// Quick recall review — deliberately NOT a flashcard deck screen.
// mode 'due' = spaced-repetition queue; mode 'all' = practice every question
// in the task regardless of due date (grades still update scheduling).
export default function ReviewCards({
  taskId,
  mode = 'due',
  onDone
}: {
  taskId?: string
  mode?: 'due' | 'all'
  onDone?: () => void
}): JSX.Element | null {
  const [queue, setQueue] = useState<DueQuestion[]>([])
  const [revealed, setRevealed] = useState(false)
  const [typed, setTyped] = useState('')
  const [checking, setChecking] = useState(false)
  const [feedback, setFeedback] = useState<{ grade: number; text: string | null } | null>(null)
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null)
  const [reviewedCount, setReviewedCount] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    if (mode === 'all' && taskId) {
      const all = await window.asit.questions.list(taskId)
      setQueue(all.filter((q) => !q.suspended))
    } else {
      setQueue(await window.asit.questions.due(20, taskId))
    }
  }, [taskId, mode])

  useEffect(() => {
    load()
  }, [load])

  const current = queue[0] ?? null
  const finished = !current && reviewedCount > 0

  useEffect(() => {
    if (finished) onDone?.()
  }, [finished, onDone])

  if (!current) return null

  const isMC = !!current.choices && current.choices.length >= 2

  function advance(): void {
    setQueue((prev) => prev.slice(1))
    setRevealed(false)
    setTyped('')
    setFeedback(null)
    setSelectedChoice(null)
    setReviewedCount((c) => c + 1)
  }

  async function selfGrade(grade: 0 | 1 | 2 | 3): Promise<void> {
    if (checking) return
    setChecking(true)
    try {
      await window.asit.questions.answer(current!.id, { selfGrade: grade })
      advance()
    } finally {
      setChecking(false)
    }
  }

  // Multiple choice: picking an option auto-grades (right → Good, wrong → Again).
  async function pickChoice(index: number): Promise<void> {
    if (revealed || checking) return
    setSelectedChoice(index)
    setRevealed(true)
    const correct = index === current!.correctIndex
    setFeedback({ grade: correct ? 2 : 0, text: correct ? 'Correct!' : null })
    await window.asit.questions.answer(current!.id, { selfGrade: correct ? 2 : 0 })
  }

  async function checkTyped(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!typed.trim() || checking) return
    setChecking(true)
    try {
      const result = await window.asit.questions.answer(current!.id, { typedAnswer: typed.trim() })
      setFeedback({ grade: result.grade, text: result.feedback })
      setRevealed(true)
    } catch (err) {
      setFeedback({ grade: -1, text: err instanceof Error ? err.message : 'Grading failed' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="review card">
      <div className="review-head">
        <span className="review-count">
          {queue.length} {mode === 'all' ? 'left' : 'due'}
          {!taskId && current.taskTitle && ` · ${current.taskTitle}`}
        </span>
        <span className="review-head-right">
          {current.sourceRef && <span className="review-src">{current.sourceRef}</span>}
          <button
            className="rail-btn rail-toggle"
            title="Delete this question permanently"
            onClick={async () => {
              await window.asit.questions.delete(current!.id)
              advance()
            }}
          >
            🗑
          </button>
        </span>
      </div>

      <p className="review-question">{current.question}</p>

      {isMC ? (
        <>
          <div className="review-choices">
            {current.choices!.map((choice, i) => {
              let cls = 'review-choice'
              if (revealed) {
                if (i === current.correctIndex) cls += ' choice-correct'
                else if (i === selectedChoice) cls += ' choice-wrong'
                else cls += ' choice-dim'
              }
              return (
                <button key={i} className={cls} onClick={() => pickChoice(i)} disabled={revealed}>
                  <span className="choice-letter">{String.fromCharCode(65 + i)}</span>
                  {choice}
                </button>
              )
            })}
          </div>
          {revealed && (
            <>
              {current.answer && (
                <p className="review-answer">{current.answer}</p>
              )}
              <button className="btn btn-primary" onClick={advance}>
                Next
              </button>
            </>
          )}
        </>
      ) : !revealed ? (
        <>
          <form onSubmit={checkTyped} className="review-typed">
            <input
              placeholder="Type your answer (AI-checked) — or just reveal"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={checking}
            />
            <button className="btn" type="submit" disabled={!typed.trim() || checking}>
              {checking ? 'Checking…' : 'Check'}
            </button>
          </form>
          <button className="btn btn-ghost review-reveal" onClick={() => setRevealed(true)}>
            Show answer
          </button>
        </>
      ) : (
        <>
          <p className="review-answer">{current.answer}</p>
          {feedback && (
            <div className={`review-feedback ${feedback.grade >= 2 ? 'fb-good' : 'fb-bad'}`}>
              {feedback.grade >= 0 && (
                <strong>{['Again', 'Hard', 'Good', 'Easy'][feedback.grade] ?? ''} · </strong>
              )}
              {feedback.text}
            </div>
          )}
          {feedback && feedback.grade >= 0 ? (
            <button className="btn btn-primary" onClick={advance}>
              Next
            </button>
          ) : (
            <div className="review-grades">
              {GRADE_BUTTONS.map((b) => (
                <button
                  key={b.grade}
                  className={`btn ${b.className}`}
                  disabled={checking}
                  onClick={() => selfGrade(b.grade)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
