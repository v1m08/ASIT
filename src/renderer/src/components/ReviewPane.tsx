import { useCallback, useEffect, useState } from 'react'
import type { Task } from '@shared/types'
import ReviewCards from './ReviewCards'

// The in-task Review tab: lock in and answer questions without leaving the
// workspace. "Due" follows the spaced-repetition schedule; "All" grinds
// through every question (grades still update scheduling).
export default function ReviewPane({ task }: { task: Task }): JSX.Element {
  const [mode, setMode] = useState<'due' | 'all' | 'terms'>('due')
  const [counts, setCounts] = useState({ due: 0, all: 0, terms: 0 })
  const [terms, setTerms] = useState<{ term: string; definition: string }[]>([])
  const [revealedTerms, setRevealedTerms] = useState<Set<string>>(new Set())
  const [runKey, setRunKey] = useState(0)
  const [finished, setFinished] = useState(false)

  const refreshCounts = useCallback(async (): Promise<void> => {
    const [due, all, termList] = await Promise.all([
      window.asit.questions.due(50, task.id),
      window.asit.questions.list(task.id),
      window.asit.terms.list(task.id)
    ])
    setCounts({ due: due.length, all: all.filter((q) => !q.suspended).length, terms: termList.length })
    setTerms(termList)
  }, [task.id])

  useEffect(() => {
    refreshCounts()
  }, [refreshCounts, runKey])

  function switchMode(m: 'due' | 'all' | 'terms'): void {
    setMode(m)
    setFinished(false)
    setRevealedTerms(new Set())
    setRunKey((k) => k + 1)
  }

  const empty = mode === 'due' ? counts.due === 0 : counts.all === 0

  return (
    <div className="review-pane">
      <div className="review-pane-head">
        <button
          className={`btn ${mode === 'due' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => switchMode('due')}
        > Due ({counts.due})
        </button>
        <button
          className={`btn ${mode === 'all' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => switchMode('all')}
        > All questions ({counts.all})
        </button>
        <button
          className={`btn ${mode === 'terms' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => switchMode('terms')}
        > Key terms ({counts.terms})
        </button>
      </div>

      <div className="review-pane-body">
        {mode === 'terms' ? (
          terms.length === 0 ? (
            <div className="review-pane-empty">
              <p>No key terms found.</p>
              <p className="review-pane-hint"> Write definitions in your notes as “Term: definition” — they appear here
                automatically.
              </p>
            </div>
          ) : (
            <div className="terms-list">
              <button
                className="btn terms-add-all"
                onClick={async () => {
                  const n = await window.asit.terms.addQuestions(task.id)
                  setRunKey((k) => k + 1)
                  alert(n > 0 ? `${n} terms added to the review queue.` : 'All terms are already in the queue.')
                }}
              >
                ＋ Add all to spaced-repetition queue
              </button>
              {terms.map((t) => (
                <button
                  key={t.term}
                  className="term-row"
                  onClick={() =>
                    setRevealedTerms((prev) => {
                      const next = new Set(prev)
                      if (next.has(t.term)) next.delete(t.term)
                      else next.add(t.term)
                      return next
                    })
                  }
                >
                  <span className="term-name">{t.term}</span>
                  <span className={`term-def ${revealedTerms.has(t.term) ? '' : 'term-def-hidden'}`}>
                    {t.definition}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : finished || empty ? (
          <div className="review-pane-empty">
            {counts.all === 0 ? (
              <>
                <p>No questions on this task yet.</p>
                <p className="review-pane-hint"> Hover a PDF in the left rail and use its ＋ menu to extract or generate questions
                  — or ask the chat to quiz you.
                </p>
              </>
            ) : finished ? (
              <>
                <p>🎉 Done — {mode === 'due' ? 'nothing more due right now' : 'you went through them all'}.</p>
                <button className="btn" onClick={() => switchMode(mode === 'due' ? 'all' : 'due')}>
                  {mode === 'due' ? 'Practice all questions' : 'Back to due'}
                </button>
              </>
            ) : (
              <p>Nothing due right now — switch to “All questions” to practice anyway.</p>
            )}
          </div>
        ) : (
          <ReviewCards
            key={`${mode}-${runKey}`}
            taskId={task.id}
            mode={mode}
            onDone={() => {
              setFinished(true)
              refreshCounts()
            }}
          />
        )}
      </div>
    </div>
  )
}
