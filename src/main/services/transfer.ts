import AdmZip from 'adm-zip'
import { basename, dirname, join, resolve, sep } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { getDb, newId, nowIso } from '../db'
import type { Settings, Task, WorkspaceLayout } from '@shared/types'
import { createTask, listTasks, refreshClaudeMd, updateTask } from './tasks'
import { listResources } from './resources'
import { getSettings, setSettings } from './settings'

// ---------------------------------------------------------------------------
// Backup / sharing export. DELIBERATELY EXCLUDED (sensitive or machine-bound):
//   - browser profile / cookies (logins)       - chat sessions & messages
//   - AI usage / cost log                      - escape phrase
//   - claude CLI path (machine-specific)       - review history (your answers)
// Included: tasks, resources, task files (notes + PDFs), questions with
// spaced-repetition state, and the harmless settings subset below.
// ---------------------------------------------------------------------------

const SAFE_SETTINGS: (keyof Settings)[] = ['workMin', 'breakMin', 'holdToQuitSeconds', 'chatModel']

interface ExportQuestion {
  question: string
  answer: string
  choices?: string[] | null
  correctIndex?: number | null
  sourceRef: string | null
  origin: string
  ease: number
  intervalDays: number
  reps: number
  lapses: number
  dueAt: string
  suspended: boolean
  resourceKey: string | null // maps to ExportResource.key
}

interface ExportResource {
  key: string // original id, used only for remapping
  kind: string
  title: string
  url: string | null
  fileName: string | null // entry name under files/<taskKey>/
  position: number
}

interface ExportTask {
  key: string // original id, used only for layout remapping
  title: string
  description: string
  status: string
  priority: number
  dueDate: string | null
  layoutJson: string | null
  resources: ExportResource[]
  questions: ExportQuestion[]
  noteFiles: string[] // md files at task root (notes.md + extra notes)
}

interface ExportBundle {
  format: 'asit-backup'
  version: 1
  exportedAt: string
  settings: Partial<Settings>
  tasks: ExportTask[]
}

export function exportToZip(zipPath: string): { tasks: number; questions: number } {
  const db = getDb()
  const zip = new AdmZip()
  const allSettings = getSettings()
  const settings: Partial<Settings> = {}
  for (const k of SAFE_SETTINGS) {
    ;(settings as Record<string, unknown>)[k] = allSettings[k]
  }

  // Private (no-AI) tasks are excluded from exports — a backup zip is made to
  // be shared, and their whole point is that the content stays put.
  const tasks = listTasks().filter((t) => !t.aiDisabled)
  let questionCount = 0
  const bundleTasks: ExportTask[] = []

  for (const task of tasks) {
    const resources = listResources(task.id)
    const filesDir = `files/${task.id}`

    const exportResources: ExportResource[] = resources.map((r) => {
      let fileName: string | null = null
      if (r.filePath && existsSync(r.filePath)) {
        fileName = basename(r.filePath)
        zip.addLocalFile(r.filePath, r.kind === 'pdf' ? `${filesDir}/pdfs` : filesDir)
      }
      return { key: r.id, kind: r.kind, title: r.title, url: r.url, fileName, position: r.position }
    })

    // notes.md always; extra note-resource files were added above.
    const noteFiles: string[] = []
    const notesPath = join(task.folderPath, 'notes.md')
    if (existsSync(notesPath)) {
      zip.addLocalFile(notesPath, filesDir)
      noteFiles.push('notes.md')
    }

    const qRows = db
      .prepare('SELECT * FROM questions WHERE task_id = ?')
      .all(task.id) as Record<string, unknown>[]
    questionCount += qRows.length

    bundleTasks.push({
      key: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      layoutJson: task.layoutJson,
      resources: exportResources,
      noteFiles,
      questions: qRows.map((r) => ({
        question: r.question as string,
        answer: r.answer as string,
        choices: typeof r.choices === 'string' ? (JSON.parse(r.choices) as string[]) : null,
        correctIndex: typeof r.correct_index === 'number' ? r.correct_index : null,
        sourceRef: (r.source_ref as string) ?? null,
        origin: (r.origin as string) ?? 'generated',
        ease: r.ease as number,
        intervalDays: r.interval_days as number,
        reps: r.reps as number,
        lapses: r.lapses as number,
        dueAt: r.due_at as string,
        suspended: (r.suspended as number) === 1,
        resourceKey: (r.resource_id as string) ?? null
      }))
    })
  }

  const bundle: ExportBundle = {
    format: 'asit-backup',
    version: 1,
    exportedAt: nowIso(),
    settings,
    tasks: bundleTasks
  }
  zip.addFile('data.json', Buffer.from(JSON.stringify(bundle, null, 2), 'utf-8'))
  zip.writeZip(zipPath)
  return { tasks: bundleTasks.length, questions: questionCount }
}

// Import always CREATES new tasks — it never overwrites or merges, so a bad
// import can't destroy anything. Settings are whitelisted again on the way in
// (a hand-crafted zip can't smuggle an escape phrase or CLI path in).
export function importFromZip(zipPath: string): { tasks: number; questions: number } {
  const zip = new AdmZip(zipPath)
  const entry = zip.getEntry('data.json')
  if (!entry) throw new Error('Not an ASIT backup (data.json missing).')
  const bundle = JSON.parse(zip.readAsText(entry)) as ExportBundle
  if (bundle.format !== 'asit-backup') throw new Error('Not an ASIT backup file.')
  if (bundle.version !== 1) throw new Error(`Unsupported backup version ${bundle.version}.`)

  const db = getDb()

  const safeSettings: Partial<Settings> = {}
  for (const k of SAFE_SETTINGS) {
    const v = (bundle.settings as Record<string, unknown>)[k]
    if (v !== undefined) (safeSettings as Record<string, unknown>)[k] = v
  }
  if (Object.keys(safeSettings).length > 0) setSettings(safeSettings)

  let taskCount = 0
  let questionCount = 0

  const insertResourceStmt = db.prepare(
    `INSERT INTO resources (id, task_id, kind, title, url, file_path, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertQuestionStmt = db.prepare(
    `INSERT INTO questions (id, task_id, resource_id, question, answer, source_ref, ease,
     interval_days, reps, lapses, due_at, suspended, created_at, origin, choices, correct_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  for (const et of bundle.tasks) {
    const task: Task = createTask({
      title: et.title,
      description: et.description,
      priority: et.priority,
      dueDate: et.dueDate
    })
    taskCount++

    // Restore task files from the archive. Zip entry names are UNTRUSTED
    // (backups can be shared/hand-crafted): resolve every target and refuse
    // anything that escapes the task folder (zip-slip).
    const filesPrefix = `files/${et.key}/`
    const taskRootAbs = resolve(task.folderPath)
    for (const zipEntry of zip.getEntries()) {
      if (!zipEntry.entryName.startsWith(filesPrefix) || zipEntry.isDirectory) continue
      const relative = zipEntry.entryName.slice(filesPrefix.length)
      const dest = resolve(task.folderPath, relative)
      if (dest !== taskRootAbs && !dest.startsWith(taskRootAbs + sep)) continue // path escape
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, zipEntry.getData())
    }

    // Recreate resources with fresh ids; remember old→new for remapping.
    const idMap = new Map<string, string>()
    for (const er of et.resources) {
      const rid = newId()
      idMap.set(er.key, rid)
      let filePath: string | null = null
      if (er.fileName) {
        filePath =
          er.kind === 'pdf'
            ? join(task.folderPath, 'pdfs', er.fileName)
            : join(task.folderPath, er.fileName)
      }
      insertResourceStmt.run(
        rid,
        task.id,
        er.kind,
        er.title,
        er.url,
        filePath,
        er.position,
        nowIso()
      )
    }

    // Numeric/date fields are untrusted: coerce to sane values so a crafted
    // backup can't plant NaN intervals that crash the scheduler later.
    const num = (v: unknown, fallback: number, min: number, max: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
    for (const eq of et.questions) {
      if (typeof eq.question !== 'string' || typeof eq.answer !== 'string') continue
      const dueAt = Number.isFinite(new Date(eq.dueAt).getTime()) ? eq.dueAt : nowIso()
      insertQuestionStmt.run(
        newId(),
        task.id,
        eq.resourceKey ? (idMap.get(eq.resourceKey) ?? null) : null,
        eq.question,
        eq.answer,
        typeof eq.sourceRef === 'string' ? eq.sourceRef : null,
        num(eq.ease, 2.5, 1.3, 2.8),
        num(eq.intervalDays, 0, 0, 3650),
        num(eq.reps, 0, 0, 10000),
        num(eq.lapses, 0, 0, 10000),
        dueAt,
        eq.suspended ? 1 : 0,
        nowIso(),
        eq.origin === 'extracted' ? 'extracted' : 'generated',
        Array.isArray(eq.choices) && eq.choices.every((c) => typeof c === 'string')
          ? JSON.stringify(eq.choices)
          : null,
        typeof eq.correctIndex === 'number' && Number.isInteger(eq.correctIndex)
          ? eq.correctIndex
          : null
      )
      questionCount++
    }

    // Remap the saved workspace layout onto the new resource ids.
    if (et.layoutJson) {
      try {
        const layout = JSON.parse(et.layoutJson) as WorkspaceLayout
        const remap = (id: string): string | null =>
          id === 'builtin-notes' ? id : (idMap.get(id) ?? null)
        const slots = layout.slots.map((slot) =>
          slot.map(remap).filter((x): x is string => x !== null)
        ) as [string[], string[]]
        const active = layout.active.map((a) => (a ? remap(a) : null)) as [
          string | null,
          string | null
        ]
        updateTask(task.id, {
          layoutJson: JSON.stringify({ ...layout, slots, active })
        })
      } catch {
        // Layout is cosmetic — skip on any parse trouble.
      }
    }

    if (et.status === 'done') updateTask(task.id, { status: 'done' })
    refreshClaudeMd(task.id)
  }

  return { tasks: taskCount, questions: questionCount }
}

