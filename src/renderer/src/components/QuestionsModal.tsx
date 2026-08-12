import { useCallback, useEffect, useState } from 'react'
import type { Question, Task } from '@shared/types'
import { useOverlay } from '../hooks/useOverlay'

export default function QuestionsModal({
  task,
  onClose
}: {
  task: Task
  onClose: () => void
}): JSX.Element {
  useOverlay(true)
  const [questions, setQuestions] = useState<Question[]>([])

  const load = useCallback(async (): Promise<void> => {
    setQuestions(await window.asit.questions.list(task.id))
  }, [task.id])

  useEffect(() => {
    load()
  }, [load])

  async function handleDelete(id: string): Promise<void> {
    await window.asit.questions.delete(id)
    await load()
  }

  async function handleSuspend(q: Question): Promise<void> {
    await window.asit.questions.suspend(q.id, !q.suspended)
    await load()
  }

  function dueLabel(q: Question): string {
    const days = Math.ceil((new Date(q.dueAt).getTime() - Date.now()) / 86400000)
    if (q.suspended) return 'paused'
    if (days <= 0) return 'due now'
    return `due in ${days}d`
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card questions-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Questions — {task.title}</h2>
        {questions.length === 0 && <p className="empty">No questions for this task yet. Use the ✨ menu on a PDF.</p>}
        <div className="questions-list">
          {questions.map((q) => (
            <div key={q.id} className={`question-row ${q.suspended ? 'question-suspended' : ''}`}>
              <div className="question-main">
                <span className="question-text">{q.question}</span>
                <span className="question-meta">
                  <span className="badge">{q.origin ?? 'generated'}</span>
                  <span>{dueLabel(q)}</span>
                  {q.sourceRef && <span>{q.sourceRef}</span>}
                </span>
              </div>
              <button
                className="btn btn-ghost"
                title={q.suspended ? 'Resume reviews' : 'Pause reviews'}
                onClick={() => handleSuspend(q)}
              >
                {q.suspended ? '▶' : '⏸'}
              </button>
              <button className="btn btn-ghost btn-danger" title="Delete question" onClick={() => handleDelete(q.id)}>
                🗑
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
