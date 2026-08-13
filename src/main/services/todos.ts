import type { BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { IPC } from '@shared/ipc-contract'
import { getDb, newId, nowIso } from '../db'
import { bus } from './bus'

// Global to-do list. Two sources:
//  - manual entries from the sidebar
//  - auto-captured "to-do: …" lines in any notes file. Completing one strikes
//    the line through in the notes (~~…~~); unchecking un-strikes it.

export interface Todo {
  id: string
  text: string
  done: boolean
  priority: number
  dueDate: string | null
  taskId: string | null
  sourceFile: string | null
  link: string | null
  createdAt: string
  completedAt: string | null
}

let getWindow: (() => BrowserWindow | null) | null = null

export function initTodos(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
}

function pushChanged(): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.TODOS_CHANGED)
  bus.emit('changed', 'todos')
}

function rowToTodo(r: Record<string, unknown>): Todo {
  return {
    id: r.id as string,
    text: r.text as string,
    done: (r.done as number) === 1,
    priority: r.priority as number,
    dueDate: (r.due_date as string) ?? null,
    taskId: (r.task_id as string) ?? null,
    sourceFile: (r.source_file as string) ?? null,
    link: (r.link as string) ?? null,
    createdAt: r.created_at as string,
    completedAt: (r.completed_at as string) ?? null
  }
}

export function listTodos(includeDone = false): Todo[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM todos ${includeDone ? '' : 'WHERE done = 0'}
       ORDER BY done ASC, due_date IS NULL, due_date ASC, priority ASC, created_at ASC`
    )
    .all() as Record<string, unknown>[]
  return rows.map(rowToTodo)
}

export function addTodo(input: {
  text: string
  dueDate?: string | null
  priority?: number
  taskId?: string | null
}): Todo | null {
  const text = input.text.trim().slice(0, 300)
  if (!text) return null
  const todo: Todo = {
    id: newId(),
    text,
    done: false,
    priority: input.priority ?? 2,
    dueDate: input.dueDate ?? null,
    taskId: input.taskId ?? null,
    sourceFile: null,
    link: extractLink(text),
    createdAt: nowIso(),
    completedAt: null
  }
  getDb()
    .prepare(
      `INSERT INTO todos (id, text, done, priority, due_date, task_id, source_file, link, created_at)
       VALUES (?, ?, 0, ?, ?, ?, NULL, ?, ?)`
    )
    .run(todo.id, todo.text, todo.priority, todo.dueDate, todo.taskId, todo.link, todo.createdAt)
  pushChanged()
  return todo
}

export function deleteTodo(id: string): void {
  getDb().prepare('DELETE FROM todos WHERE id = ?').run(id)
  pushChanged()
}

export function setTodoDone(id: string, done: boolean): void {
  const db = getDb()
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) return
  db.prepare('UPDATE todos SET done = ?, completed_at = ? WHERE id = ?').run(
    done ? 1 : 0,
    done ? nowIso() : null,
    id
  )
  // Auto strike-through the source line in the notes file.
  const todo = rowToTodo(row)
  if (todo.sourceFile && existsSync(todo.sourceFile)) {
    try {
      const content = readFileSync(todo.sourceFile, 'utf-8')
      const updated = content
        .split('\n')
        .map((line) => {
          const struck = /~~.*to-?do:/i.test(line)
          const matches = line.toLowerCase().includes(todo.text.toLowerCase().slice(0, 80)) && /to-?do:/i.test(line)
          if (!matches) return line
          if (done && !struck) return line.replace(/(to-?do:.*)$/i, '~~$1~~')
          if (!done && struck) return line.replace(/~~(to-?do:.*)~~\s*$/i, '$1')
          return line
        })
        .join('\n')
      if (updated !== content) writeFileSync(todo.sourceFile, updated)
    } catch {
      // best-effort
    }
  }
  pushChanged()
}

function extractLink(text: string): string | null {
  const m = text.match(/\((asit:\/\/open\/[^)]+)\)/)
  return m ? m[1] : null
}

// Called after every notes save: capture new "to-do:" lines, drop removed
// ones (that were never completed).
export function syncTodosFromNotes(filePath: string, content: string): void {
  const db = getDb()
  const task = db
    .prepare("SELECT id FROM tasks WHERE ? LIKE folder_path || '%'")
    .get(filePath) as { id: string } | undefined

  const found: string[] = []
  for (const line of content.split('\n')) {
    if (/~~.*to-?do:/i.test(line)) continue // struck-through = completed
    // Allow bullets, quotes, headings and checkboxes ahead of the keyword:
    // "- to-do: x", "## TODO: x", "- [ ] todo: x" all capture.
    const m = line.match(/^[\s>*+\-#]*(?:\[[ xX]?\]\s*)?to-?do:\s*(.+?)\s*$/i)
    if (m && m[1].length >= 2) found.push(m[1].slice(0, 300))
  }

  const existing = db
    .prepare('SELECT id, text, done FROM todos WHERE source_file = ?')
    .all(filePath) as { id: string; text: string; done: number }[]
  const existingTexts = new Set(existing.map((e) => e.text))
  let changed = false

  for (const text of found) {
    if (!existingTexts.has(text)) {
      db.prepare(
        `INSERT INTO todos (id, text, done, priority, due_date, task_id, source_file, link, created_at)
         VALUES (?, ?, 0, 2, NULL, ?, ?, ?, ?)`
      ).run(newId(), text, task?.id ?? null, filePath, extractLink(text), nowIso())
      changed = true
    }
  }
  const foundSet = new Set(found)
  for (const e of existing) {
    if (!e.done && !foundSet.has(e.text)) {
      db.prepare('DELETE FROM todos WHERE id = ?').run(e.id) // line was removed from notes
      changed = true
    }
  }
  if (changed) pushChanged()
}
