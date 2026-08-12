import { app, BrowserWindow, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { basename, join } from 'path'
import { getDb, newId, nowIso } from './../db'
import type { Resource } from '@shared/types'
import { getTask, refreshClaudeMd } from './tasks'

// Global file library: Documents\ASIT\library. Files here (resume.pdf,
// transcript, ...) are attachable to any task in two clicks. Attaching COPIES
// the file into the task folder so each task stays self-contained for the AI.

export function libraryRoot(): string {
  return join(app.getPath('documents'), 'ASIT', 'library')
}

export interface LibraryFile {
  name: string
  sizeBytes: number
  modifiedAt: string
}

export function listLibrary(): LibraryFile[] {
  const root = libraryRoot()
  mkdirSync(root, { recursive: true })
  return readdirSync(root)
    .filter((f) => !f.startsWith('.'))
    .map((name) => {
      const s = statSync(join(root, name))
      return { name, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() }
    })
    .filter((f) => f.sizeBytes > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function addToLibrary(win: BrowserWindow | null): Promise<LibraryFile[] | null> {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Add files to your ASIT library',
    properties: ['openFile', 'multiSelections']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const root = libraryRoot()
  mkdirSync(root, { recursive: true })
  for (const p of result.filePaths) {
    copyFileSync(p, join(root, basename(p)))
  }
  return listLibrary()
}

export function removeFromLibrary(name: string): LibraryFile[] {
  const target = join(libraryRoot(), basename(name)) // basename() blocks path escapes
  if (existsSync(target)) {
    // Never hard-delete user files — same .trash rule as tasks.
    const trash = join(app.getPath('documents'), 'ASIT', '.trash', 'library')
    mkdirSync(trash, { recursive: true })
    try {
      renameSync(target, join(trash, `${Date.now()}-${basename(name)}`))
    } catch (err) {
      console.error('library trash move failed:', err)
    }
  }
  return listLibrary()
}

export function attachToTask(taskId: string, name: string): Resource | null {
  const task = getTask(taskId)
  if (!task) return null
  const source = join(libraryRoot(), basename(name))
  if (!existsSync(source)) return null

  const isPdf = /\.pdf$/i.test(name)
  const destDir = isPdf ? join(task.folderPath, 'pdfs') : join(task.folderPath, 'files')
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, basename(name))
  copyFileSync(source, dest)

  const resource: Resource = {
    id: newId(),
    taskId,
    kind: isPdf ? 'pdf' : 'file',
    title: basename(name).replace(/\.[^.]+$/, ''),
    url: null,
    filePath: dest,
    position: 999,
    createdAt: nowIso()
  }
  getDb()
    .prepare(
      `INSERT INTO resources (id, task_id, kind, title, url, file_path, position, created_at)
       VALUES (@id, @taskId, @kind, @title, @url, @filePath, @position, @createdAt)`
    )
    .run(resource as unknown as Record<string, unknown>)
  refreshClaudeMd(taskId)
  return resource
}
