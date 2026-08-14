import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from '../store/useStore'
import { reliably } from '../lib/reliably'

interface Todo {
  id: string
  text: string
  done: boolean
  priority: number
  dueDate: string | null
  taskId: string | null
  sourceFile: string | null
  link: string | null
}

function dueBadge(dueDate: string | null): { text: string; overdue: boolean } | null {
  if (!dueDate) return null
  const days = Math.ceil((new Date(dueDate + 'T23:59:59').getTime() - Date.now()) / 86400000)
  if (days < 0) return { text: `${-days}d late`, overdue: true }
  if (days === 0) return { text: 'today', overdue: true }
  if (days === 1) return { text: 'tmrw', overdue: false }
  return { text: `${days}d`, overdue: false }
}

// Strip markdown link syntax for display; keep the label.
function displayText(t: Todo): string {
  return t.text.replace(/\[([^\]]+)\]\(asit:\/\/[^)]+\)/g, '$1').trim()
}

export default function TodoList(): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([])
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [adding, setAdding] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const openTaskAndResource = useStore((s) => s.openTaskAndResource)

  const load = useCallback(async (): Promise<void> => {
    const list = await reliably('to-dos', () => window.asit.todos.list(false))
    if (list) setTodos(list)
  }, [])

  useEffect(() => {
    load()
    return window.asit.on(IPC.TODOS_CHANGED, () => load())
  }, [load])

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!text.trim()) return
    await window.asit.todos.add({ text: text.trim(), dueDate: due || null })
    setText('')
    setDue('')
    await load()
    inputRef.current?.focus()
  }

  function closeAdd(): void {
    setAdding(false)
    setText('')
    setDue('')
  }

  function openLink(link: string): void {
    const m = link.match(/^asit:\/\/open\/([^/]+)\/(.+)$/)
    if (m) openTaskAndResource(m[1], m[2])
  }

  return (
    <div className="todo-list">
      {adding ? (
        <form className="todo-add" onSubmit={add}>
          <input
            ref={inputRef}
            autoFocus
            placeholder="Add a to-do…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && closeAdd()}
            onBlur={() => !text.trim() && !due && closeAdd()}
          />
          <input
            type="date"
            className="todo-date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            title="Due date (optional)"
          />
        </form>
      ) : (
        <button className="todo-add-btn" onClick={() => setAdding(true)} title="Add a to-do">
          + Add
        </button>
      )}
      {todos.map((t) => {
        const badge = dueBadge(t.dueDate)
        return (
          <div key={t.id} className="todo-row">
            <input
              type="checkbox"
              checked={t.done}
              onChange={(e) => window.asit.todos.setDone(t.id, e.target.checked)}
            />
            <span className="todo-text" title={t.sourceFile ? 'Captured from notes' : undefined}>
              {displayText(t)}
            </span>
            {t.link && (
              <button className="rail-btn rail-toggle todo-link" title="Open linked file" onClick={() => openLink(t.link!)}>
                ↗
              </button>
            )}
            {badge && (
              <span className={`badge ${badge.overdue ? 'badge-danger' : ''}`}>{badge.text}</span>
            )}
            <button
              className="rail-btn rail-toggle"
              title="Delete"
              onClick={() => window.asit.todos.delete(t.id)}
            >
              ×
            </button>
          </div>
        )
      })}
      {todos.length === 0 && (
        <p className="quick-chats-empty">Nothing yet — hit + Add, or write “to-do: …” in any notes.</p>
      )}
    </div>
  )
}
