import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { getDb, newId, nowIso } from '../db'
import type { Resource, ResourceKind } from '@shared/types'
import { syncTodosFromNotes } from './todos'

function rowToResource(row: Record<string, unknown>): Resource {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    kind: row.kind as ResourceKind,
    title: row.title as string,
    url: (row.url as string) ?? null,
    filePath: (row.file_path as string) ?? null,
    position: row.position as number,
    createdAt: row.created_at as string
  }
}

export function listResources(taskId: string): Resource[] {
  const rows = getDb()
    .prepare('SELECT * FROM resources WHERE task_id = ? ORDER BY position ASC, created_at ASC')
    .all(taskId) as Record<string, unknown>[]
  return rows.map(rowToResource)
}

function nextPosition(taskId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM resources WHERE task_id = ?')
    .get(taskId) as { p: number }
  return row.p
}

function insertResource(r: Resource): Resource {
  getDb()
    .prepare(
      `INSERT INTO resources (id, task_id, kind, title, url, file_path, position, created_at)
       VALUES (@id, @taskId, @kind, @title, @url, @filePath, @position, @createdAt)`
    )
    .run(r as unknown as Record<string, unknown>)
  return r
}

export function addUrlResource(taskId: string, title: string, url: string): Resource {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
  return insertResource({
    id: newId(),
    taskId,
    kind: 'url',
    title: title || new URL(normalized).hostname,
    url: normalized,
    filePath: null,
    position: nextPosition(taskId),
    createdAt: nowIso()
  })
}

export function addPdfResource(taskId: string, sourcePath: string, taskFolder: string): Resource {
  const pdfDir = join(taskFolder, 'pdfs')
  mkdirSync(pdfDir, { recursive: true })

  let name = basename(sourcePath)
  let dest = join(pdfDir, name)
  let counter = 1
  while (existsSync(dest)) {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    dest = join(pdfDir, `${stem}-${counter}${ext}`)
    counter++
  }
  copyFileSync(sourcePath, dest)

  return insertResource({
    id: newId(),
    taskId,
    kind: 'pdf',
    title: basename(dest).replace(/\.pdf$/i, ''),
    url: null,
    filePath: dest,
    position: nextPosition(taskId),
    createdAt: nowIso()
  })
}

export function addNoteResource(taskId: string, taskFolder: string, title: string): Resource {
  // Extra note files beyond the default notes.md
  const safe = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note'
  const filePath = join(taskFolder, `${safe}.md`)
  if (!existsSync(filePath)) writeFileSync(filePath, `# ${title}\n\n`)
  return insertResource({
    id: newId(),
    taskId,
    kind: 'note',
    title,
    url: null,
    filePath,
    position: nextPosition(taskId),
    createdAt: nowIso()
  })
}

// Extract a PDF's text to a sibling .txt so the Claude CLI can always read
// the content with its plain Read tool — PDF rendering support varies by
// environment (poppler etc.), plain text never fails.
export async function ensurePdfText(pdfPath: string): Promise<string | null> {
  if (!existsSync(pdfPath)) return null
  const txtPath = pdfPath.replace(/\.pdf$/i, '.txt')
  if (txtPath === pdfPath) return null // not a .pdf
  if (existsSync(txtPath)) return txtPath
  try {
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default
    const data = await pdfParse(readFileSync(pdfPath))
    const text = (data.text ?? '').trim()
    if (!text) return null // scanned/image-only PDF
    writeFileSync(
      txtPath,
      `[Extracted text of ${basename(pdfPath)}, ${data.numpages} pages]\n\n${text}`
    )
    return txtPath
  } catch (err) {
    console.error('PDF text extraction failed:', pdfPath, err)
    return null
  }
}

export function renameResource(id: string, title: string): void {
  const clean = title.trim().slice(0, 120)
  if (!clean) return
  getDb().prepare('UPDATE resources SET title = ? WHERE id = ?').run(clean, id)
}

export function removeResource(id: string): void {
  // DB row only; files stay in the task folder (user data is never deleted here).
  getDb().prepare('DELETE FROM resources WHERE id = ?').run(id)
}

export function reorderResources(taskId: string, orderedIds: string[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE resources SET position = ? WHERE id = ? AND task_id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id, taskId))
  })()
}

export function readNote(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
}

export function writeNote(filePath: string, content: string): void {
  writeFileSync(filePath, content)
  // Auto-capture "to-do:" lines into the global to-do list.
  try {
    syncTodosFromNotes(filePath, content)
  } catch (err) {
    console.error('todo sync failed:', err)
  }
}

// URL resources that point at a PDF (course slides etc.): download once and
// extract text like local PDFs — DOM snapshots of the PDF viewer are useless.
export async function ensureWebPdfText(taskFolder: string, url: string): Promise<string | null> {
  try {
    const clean = url.split(/[?#]/)[0]
    if (!/\.pdf$/i.test(clean)) return null
    const name = ('web-' + (basename(clean) || 'document.pdf')).replace(/[^\w.-]/g, '_')
    const pdfDir = join(taskFolder, 'pdfs')
    mkdirSync(pdfDir, { recursive: true })
    const pdfPath = join(pdfDir, name)
    const txtPath = pdfPath.replace(/\.pdf$/i, '.txt')
    if (existsSync(txtPath)) return txtPath
    if (!existsSync(pdfPath)) {
      const res = await fetch(url)
      if (!res.ok) return null
      writeFileSync(pdfPath, Buffer.from(await res.arrayBuffer()))
    }
    return ensurePdfText(pdfPath)
  } catch (err) {
    console.error('web pdf extraction failed:', url, err)
    return null
  }
}
