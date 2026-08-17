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

// A to-do line is text with links in it. Three shapes occur in practice:
// markdown links to a file inside ASIT, markdown links to the web, and bare
// URLs someone typed. All three are rendered as real clickable links —
// previously the markdown was flattened to its label and a pasted URL was
// inert text, so the only way to follow one was to retype it.
type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }

const MD_LINK = /\[([^\]]+)\]\((asit:\/\/[^)\s]+|https?:\/\/[^)\s]+)\)/g
const BARE_URL = /(https?:\/\/[^\s<>"')\]]+)/g

function parseTodoText(raw: string): Piece[] {
  const pieces: Piece[] = []
  let last = 0
  // Markdown links first so a URL inside one isn't matched twice.
  for (const m of raw.matchAll(MD_LINK)) {
    if (m.index! > last) pieces.push({ kind: 'text', text: raw.slice(last, m.index) })
    pieces.push({ kind: 'link', text: m[1], href: m[2] })
    last = m.index! + m[0].length
  }
  if (last < raw.length) pieces.push({ kind: 'text', text: raw.slice(last) })

  // Then bare URLs, but only inside the plain-text runs.
  return pieces.flatMap<Piece>((p) => {
    if (p.kind !== 'text') return [p]
    const out: Piece[] = []
    let cursor = 0
    for (const m of p.text.matchAll(BARE_URL)) {
      if (m.index! > cursor) out.push({ kind: 'text', text: p.text.slice(cursor, m.index) })
      out.push({ kind: 'link', text: m[1], href: m[1] })
      cursor = m.index! + m[0].length
    }
    if (cursor < p.text.length) out.push({ kind: 'text', text: p.text.slice(cursor) })
    return out
  })
}

export default function TodoList({
  onOpenUrl
}: {
  // Home passes the scratchpad browser so a web link opens inside ASIT.
  onOpenUrl?: (url: string) => void
} = {}): JSX.Element {
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

  // asit:// goes to the file inside the app; the web opens in ASIT's own
  // browser (the scratchpad), falling back to the system browser if the
  // scratchpad isn't mounted.
  function followLink(href: string): void {
    if (href.startsWith('asit://')) {
      openLink(href)
      return
    }
    if (!/^https?:\/\//i.test(href)) return // never hand the OS an odd scheme
    if (onOpenUrl) onOpenUrl(href)
    else void window.asit.resources.openExternal({ url: href })
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
              {parseTodoText(t.text).map((piece, i) =>
                piece.kind === 'text' ? (
                  <span key={i}>{piece.text}</span>
                ) : (
                  <a
                    key={i}
                    className="todo-inline-link"
                    href={piece.href}
                    title={piece.href}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation() // don't also toggle/open the row
                      followLink(piece.href)
                    }}
                  >
                    {piece.text}
                  </a>
                )
              )}
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
