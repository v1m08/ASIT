import type { BrowserWindow } from 'electron'
import { basename, join as joinPath } from 'path'
import { existsSync as existsSyncFs, readFileSync as readFileSyncFs } from 'fs'
import { getDb, newId, nowIso } from '../db'
import { IPC } from '@shared/ipc-contract'
import type { Question } from '@shared/types'
import { getTask } from './tasks'
import { runClaudeOnce } from './claude'
import { logUsage } from './usage'
import { clearActivity, reportActivity } from './activity'
import { bus } from './bus'

// ---------------------------------------------------------------------------
// SM-2, simplified to 4 grades: 0 Again, 1 Hard, 2 Good, 3 Easy.
// Pure function so it stays unit-testable.
// ---------------------------------------------------------------------------

export interface SrState {
  ease: number
  intervalDays: number
  reps: number
  lapses: number
}

export function scheduleNext(
  s: SrState,
  grade: 0 | 1 | 2 | 3,
  now: Date
): SrState & { dueAt: string } {
  let { ease, intervalDays, reps, lapses } = s

  if (grade === 0) {
    lapses++
    reps = 0
    intervalDays = 0
    ease = Math.max(1.3, ease - 0.2)
    // due again in 10 minutes — reappears this study session
    return { ease, intervalDays, reps, lapses, dueAt: new Date(now.getTime() + 10 * 60000).toISOString() }
  }

  if (grade === 1) {
    ease = Math.max(1.3, ease - 0.15)
    intervalDays = reps === 0 ? 1 : Math.max(1, intervalDays * 1.2)
  } else if (grade === 2) {
    intervalDays = reps === 0 ? 1 : reps === 1 ? 3 : intervalDays * ease
  } else {
    ease = Math.min(2.8, ease + 0.15)
    intervalDays = reps === 0 ? 2 : Math.max(3, intervalDays * ease * 1.3)
  }
  reps++
  const dueAt = new Date(now.getTime() + intervalDays * 86400000).toISOString()
  return { ease, intervalDays, reps, lapses, dueAt }
}

// ---------------------------------------------------------------------------

function rowToQuestion(row: Record<string, unknown>): Question {
  let choices: string[] | null = null
  if (typeof row.choices === 'string') {
    try {
      const parsed = JSON.parse(row.choices)
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) choices = parsed
    } catch {
      // malformed — treat as free response
    }
  }
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    resourceId: (row.resource_id as string) ?? null,
    question: row.question as string,
    answer: row.answer as string,
    choices,
    correctIndex: typeof row.correct_index === 'number' ? row.correct_index : null,
    sourceRef: (row.source_ref as string) ?? null,
    ease: row.ease as number,
    intervalDays: row.interval_days as number,
    reps: row.reps as number,
    lapses: row.lapses as number,
    dueAt: row.due_at as string,
    suspended: (row.suspended as number) === 1,
    origin: (row.origin as 'generated' | 'extracted') ?? 'generated',
    createdAt: row.created_at as string
  }
}

export interface DueQuestion extends Question {
  taskTitle: string
}

export function dueQuestions(limit = 20, taskId?: string): DueQuestion[] {
  const params: Record<string, unknown> = { now: nowIso(), limit }
  if (taskId) params.taskId = taskId
  const rows = getDb()
    .prepare(
      `SELECT q.*, t.title AS task_title FROM questions q
       JOIN tasks t ON t.id = q.task_id
       WHERE q.suspended = 0 AND q.due_at <= @now AND t.status = 'active' AND t.ai_disabled = 0
       ${taskId ? 'AND q.task_id = @taskId' : ''}
       ORDER BY q.due_at ASC LIMIT @limit`
    )
    .all(params) as Record<string, unknown>[]
  return rows.map((r) => ({ ...rowToQuestion(r), taskTitle: r.task_title as string }))
}

export function listQuestions(taskId: string): Question[] {
  const rows = getDb()
    .prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as Record<string, unknown>[]
  return rows.map(rowToQuestion)
}

export function suspendQuestion(id: string, suspended: boolean): void {
  getDb().prepare('UPDATE questions SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, id)
}

export function deleteQuestion(id: string): void {
  getDb().prepare('DELETE FROM questions WHERE id = ?').run(id) // review_log cascades
}

// ---------------------------------------------------------------------------
// Key terms: auto-extracted "Term: definition" lines from the task's notes.
// ---------------------------------------------------------------------------

export interface KeyTerm {
  term: string
  definition: string
}

const TERM_BLACKLIST =
  /^(to-?do|todo|note|warning|example|answer|question|q|a|http|https|see|source|src|from|by|date|due|link)$/i

export function keyTerms(taskId: string): KeyTerm[] {
  const task = getTask(taskId)
  if (!task) return []
  const files: string[] = []
  const notesPath = joinPath(task.folderPath, 'notes.md')
  if (existsSyncFs(notesPath)) files.push(notesPath)
  for (const r of getDb()
    .prepare("SELECT file_path FROM resources WHERE task_id = ? AND kind = 'note' AND file_path IS NOT NULL")
    .all(taskId) as { file_path: string }[]) {
    if (existsSyncFs(r.file_path)) files.push(r.file_path)
  }

  const seen = new Set<string>()
  const terms: KeyTerm[] = []
  for (const file of files) {
    let content = ''
    try {
      content = readFileSyncFs(file, 'utf-8')
    } catch {
      continue
    }
    for (const raw of content.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('#') || /https?:\/\//.test(line)) continue
      const m = line.match(/^[>*-\s]*(?:\*\*)?([A-Za-z][A-Za-z0-9 ()/'+-]{1,48}?)(?:\*\*)?:\s+(\S.{2,300})$/)
      if (!m) continue
      const term = m[1].trim()
      if (TERM_BLACKLIST.test(term) || term.split(/\s+/).length > 6) continue
      const key = term.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      terms.push({ term, definition: m[2].trim() })
      if (terms.length >= 200) return terms
    }
  }
  return terms
}

// Fold key terms into the spaced-repetition queue (dedupe by term).
export function termsToQuestions(taskId: string): number {
  const db = getDb()
  const terms = keyTerms(taskId)
  const insert = db.prepare(
    `INSERT INTO questions (id, task_id, resource_id, question, answer, due_at, created_at, origin)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'terms')`
  )
  let added = 0
  db.transaction(() => {
    for (const t of terms) {
      const exists = db
        .prepare("SELECT 1 FROM questions WHERE task_id = ? AND origin = 'terms' AND question = ?")
        .get(taskId, t.term)
      if (exists) continue
      insert.run(newId(), taskId, t.term, t.definition, nowIso(), nowIso())
      added++
    }
  })()
  return added
}

export interface AnswerResult {
  grade: number
  feedback: string | null
  nextDueAt: string
}

export async function answerQuestion(
  questionId: string,
  input: { selfGrade?: 0 | 1 | 2 | 3; typedAnswer?: string }
): Promise<AnswerResult> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error('Question not found')
  const q = rowToQuestion(row)

  let grade = input.selfGrade
  let feedback: string | null = null

  if (grade === undefined && input.typedAnswer !== undefined) {
    const task = getTask(q.taskId)
    if (!task) throw new Error('Task not found')
    if (task.aiDisabled)
      throw new Error('This task is private — AI grading is disabled. Use the self-grade buttons.')
    const graded = await gradeAnswer(
      task.folderPath,
      q.question,
      q.answer,
      input.typedAnswer,
      q.taskId
    )
    grade = graded.grade
    feedback = graded.feedback
  }
  if (grade === undefined) throw new Error('No grade provided')

  const next = scheduleNext(
    { ease: q.ease, intervalDays: q.intervalDays, reps: q.reps, lapses: q.lapses },
    grade,
    new Date()
  )

  db.prepare(
    'UPDATE questions SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due_at = ? WHERE id = ?'
  ).run(next.ease, next.intervalDays, next.reps, next.lapses, next.dueAt, questionId)

  db.prepare(
    'INSERT INTO review_log (id, question_id, reviewed_at, grade, answer_given, ai_feedback) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(newId(), questionId, nowIso(), grade, input.typedAnswer ?? null, feedback)

  return { grade, feedback, nextDueAt: next.dueAt }
}

async function gradeAnswer(
  cwd: string,
  question: string,
  reference: string,
  given: string,
  taskId?: string
): Promise<{ grade: 0 | 1 | 2 | 3; feedback: string }> {
  const prompt = [
    'You are grading a short study recall answer. Be encouraging but honest.',
    `Question: ${question}`,
    `Reference answer: ${reference}`,
    `Student's answer: ${given}`,
    '',
    'Grade scale: 0 = wrong or blank, 1 = partially right with real gaps, 2 = right with minor issues, 3 = fully right.',
    'Output ONLY a JSON object, no code fence: {"grade": <0-3>, "feedback": "<one or two sentences: what was right, what was missed>"}'
  ].join('\n')

  const { text, usage } = await runClaudeOnce({ cwd, prompt, maxTurns: 1, timeoutMs: 90_000 })
  logUsage(taskId ?? null, 'grade', usage)
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Grader returned no JSON')
  const parsed = JSON.parse(match[0]) as { grade: number; feedback?: string }
  const grade = Math.max(0, Math.min(3, Math.round(parsed.grade))) as 0 | 1 | 2 | 3
  return { grade, feedback: parsed.feedback ?? '' }
}

// ---------------------------------------------------------------------------
// Background generation job queue: single concurrency, survives restarts via
// the jobs table, idempotent per resource.
// ---------------------------------------------------------------------------

let getWindow: (() => BrowserWindow | null) | null = null
let pumping = false

export function initQuestions(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
  // Orphaned running jobs (app was killed mid-generation) → failed.
  getDb()
    .prepare(
      "UPDATE jobs SET status = 'failed', error = 'interrupted by app shutdown', finished_at = ? WHERE status = 'running'"
    )
    .run(nowIso())
  // Anything still queued from last run: resume it.
  setTimeout(() => void pump(), 3000)
}

function pushJobStatus(payload: Record<string, unknown>): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.JOBS_STATUS, payload)
  bus.emit('changed', 'jobs')
  // Question jobs run for minutes — worth a phone ping when they land.
  if (payload.status === 'done') {
    bus.emit('notify', {
      title: 'ASIT',
      body: `🧠 ${payload.count} questions ready`,
      tag: 'questions'
    })
  } else if (payload.status === 'failed') {
    bus.emit('notify', { title: 'ASIT', body: '🧠 Question job failed', tag: 'questions' })
  }
}

export type QuestionMode = 'generate' | 'extract'

const JOB_KIND: Record<QuestionMode, string> = {
  generate: 'generate_questions',
  extract: 'extract_questions'
}

// Cross-document pipeline: "questions from X, answers from Y". The chat model
// only DISPATCHES this (one action line); the reading, pairing, and JSON
// contract all run here in the background job system.
export interface CustomQuestionParams {
  sources: string[]
  answers_source?: string
  mode?: QuestionMode
  instructions?: string
  count?: number
}

export function enqueueCustomGeneration(taskId: string, params: CustomQuestionParams): string {
  const task = getTask(taskId)
  if (!task) return 'task not found'
  if (task.aiDisabled) return 'private task — AI disabled'
  if (!Array.isArray(params.sources) || params.sources.length === 0) return 'no sources given'

  const db = getDb()
  db.prepare(
    "INSERT INTO jobs (id, kind, task_id, resource_id, status, created_at, params) VALUES (?, 'custom_questions', ?, NULL, 'queued', ?, ?)"
  ).run(newId(), taskId, nowIso(), JSON.stringify(params))
  pushJobStatus({
    status: 'queued',
    taskId,
    mode: params.mode ?? 'generate',
    title: params.sources.join(' + ')
  })
  void pump()
  return `queued: questions from ${params.sources.join(', ')}${params.answers_source ? ` with answers from ${params.answers_source}` : ''}`
}

// User-initiated only — nothing enqueues automatically.
export function enqueueGeneration(taskId: string, resourceId: string, mode: QuestionMode): void {
  if (getTask(taskId)?.aiDisabled) return // private task: content never reaches AI
  const db = getDb()
  const kind = JOB_KIND[mode]
  const dupe = db
    .prepare(
      "SELECT id FROM jobs WHERE kind = ? AND resource_id = ? AND status IN ('queued','running')"
    )
    .get(kind, resourceId)
  if (dupe) return
  db.prepare(
    "INSERT INTO jobs (id, kind, task_id, resource_id, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)"
  ).run(newId(), kind, taskId, resourceId, nowIso())
  const res = db.prepare('SELECT title FROM resources WHERE id = ?').get(resourceId) as
    | { title: string }
    | undefined
  pushJobStatus({ status: 'queued', taskId, mode, title: res?.title ?? '' })
  void pump()
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    const db = getDb()
    for (;;) {
      const job = db
        .prepare(
          "SELECT * FROM jobs WHERE status = 'queued' AND kind IN ('generate_questions','extract_questions','custom_questions') ORDER BY created_at ASC LIMIT 1"
        )
        .get() as Record<string, unknown> | undefined
      if (!job) break

      const jobId = job.id as string
      const taskId = job.task_id as string
      const resourceId = job.resource_id as string
      const mode: QuestionMode = job.kind === 'extract_questions' ? 'extract' : 'generate'
      db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId)
      reportActivity(jobId, {
        kind: 'questions',
        taskId,
        label: mode === 'extract' ? 'Extracting questions' : 'Generating questions'
      })

      try {
        const count =
          job.kind === 'custom_questions'
            ? await generateCustom(taskId, JSON.parse(job.params as string) as CustomQuestionParams)
            : await generateForResource(taskId, resourceId, mode)
        db.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").run(
          nowIso(),
          jobId
        )
        pushJobStatus({ jobId, status: 'done', taskId, resourceId, count, mode })
        clearActivity(jobId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
          message,
          nowIso(),
          jobId
        )
        pushJobStatus({ jobId, status: 'failed', taskId, resourceId, error: message })
        clearActivity(jobId)
      }
    }
  } finally {
    pumping = false
  }
}

interface GeneratedQuestion {
  q: string
  a: string
  source_ref?: string
  choices?: string[]
  correct_index?: number
}

function extractJsonArray(text: string): GeneratedQuestion[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const arrMatch = candidate.match(/\[[\s\S]*\]/)
  if (!arrMatch) throw new Error('no JSON array in output')
  const parsed = JSON.parse(arrMatch[0]) as GeneratedQuestion[]
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty question array')
  return parsed
    .filter((x) => typeof x.q === 'string' && typeof x.a === 'string')
    .map((x) => {
      // MC fields are optional; strip them unless fully coherent.
      const validChoices =
        Array.isArray(x.choices) &&
        x.choices.length >= 2 &&
        x.choices.length <= 6 &&
        x.choices.every((c) => typeof c === 'string') &&
        typeof x.correct_index === 'number' &&
        Number.isInteger(x.correct_index) &&
        x.correct_index >= 0 &&
        x.correct_index < x.choices.length
      return validChoices ? x : { q: x.q, a: x.a, source_ref: x.source_ref }
    })
}

// Fuzzy file resolution: match a user/model-supplied name against resource
// titles and files in the task folder; prefer extracted .txt over raw .pdf.
async function resolveTaskFile(taskFolder: string, taskId: string, name: string): Promise<string | null> {
  const { existsSync, readdirSync } = await import('fs')
  const { join } = await import('path')
  const norm = name.toLowerCase().replace(/\.(pdf|txt|md)$/i, '')

  const candidates: { label: string; path: string }[] = []
  const db = getDb()
  const resources = db
    .prepare("SELECT title, file_path FROM resources WHERE task_id = ? AND file_path IS NOT NULL")
    .all(taskId) as { title: string; file_path: string }[]
  for (const r of resources) {
    candidates.push({ label: r.title.toLowerCase(), path: r.file_path })
  }
  for (const dir of ['pdfs', 'files', '']) {
    const abs = join(taskFolder, dir)
    if (!existsSync(abs)) continue
    try {
      for (const f of readdirSync(abs)) {
        if (/\.(pdf|txt|md)$/i.test(f)) candidates.push({ label: f.toLowerCase(), path: join(abs, f) })
      }
    } catch {
      // unreadable dir
    }
  }

  const match =
    candidates.find((c) => c.label.replace(/\.(pdf|txt|md)$/i, '') === norm) ??
    candidates.find((c) => c.label.includes(norm)) ??
    candidates.find((c) => norm.includes(c.label.replace(/\.(pdf|txt|md)$/i, '')))
  if (!match) return null

  // Prefer plain text for PDFs (CLI reads it reliably and cheaply).
  if (/\.pdf$/i.test(match.path)) {
    const { ensurePdfText } = await import('./resources')
    const txt = await ensurePdfText(match.path)
    if (txt) return txt
  }
  return match.path
}

const OUTPUT_CONTRACT = [
  'Output ONLY a fenced ```json code block containing an array of objects:',
  '[{"q": "...", "a": "...", "source_ref": "...", "choices": ["...", "..."], "correct_index": 0}]',
  '"choices" (2-6 options) + "correct_index" (0-based) are ONLY for multiple-choice questions — omit both for free-response. For MC, "a" holds the correct answer text plus a one-line explanation.'
].join('\n')

async function generateCustom(taskId: string, params: CustomQuestionParams): Promise<number> {
  const db = getDb()
  const task = getTask(taskId)
  if (!task) throw new Error('task gone')

  const { relative } = await import('path')
  const resolved: string[] = []
  for (const name of params.sources.slice(0, 5)) {
    const p = await resolveTaskFile(task.folderPath, taskId, String(name))
    if (!p) throw new Error(`could not find a file matching "${name}" in this task`)
    resolved.push(relative(task.folderPath, p).replace(/\\/g, '/'))
  }
  let answersRef: string | null = null
  if (params.answers_source) {
    const p = await resolveTaskFile(task.folderPath, taskId, String(params.answers_source))
    if (!p) throw new Error(`could not find answers file matching "${params.answers_source}"`)
    answersRef = relative(task.folderPath, p).replace(/\\/g, '/')
  }

  const mode: QuestionMode = params.mode === 'extract' ? 'extract' : 'generate'
  const count = Math.min(40, Math.max(1, Math.round(params.count ?? 15)))
  const label = params.sources.join(' + ')
  pushJobStatus({ status: 'started', taskId, title: label, mode })

  const promptLines = [
    `Read these files in this folder: ${resolved.map((r) => `"${r}"`).join(', ')}.`
  ]
  if (answersRef) {
    promptLines.push(
      `Then read "${answersRef}" — it contains the ANSWERS/solutions. Pair each question with its correct answer from there; if an answer is missing, work it out yourself and note that in the answer.`
    )
  }
  promptLines.push(
    mode === 'extract'
      ? 'EXTRACT the questions as they appear in the source material — original wording, lightly cleaned. Preserve multiple-choice format with its options; never flatten MC into free-response.'
      : 'Create review questions that test understanding of the material — definitions, mechanisms, relationships, results. Use multiple choice with plausible distractors where the material suits it.'
  )
  if (params.instructions) promptLines.push(`Additional instructions: ${String(params.instructions).slice(0, 500)}`)
  promptLines.push(`Produce up to ${count} questions.`, OUTPUT_CONTRACT)

  const attempt = async (p: string): Promise<GeneratedQuestion[]> => {
    const { text, usage } = await runClaudeOnce({
      cwd: task.folderPath,
      prompt: p,
      allowedTools: 'Read(**)',
      maxTurns: 10,
      timeoutMs: 10 * 60 * 1000
    })
    logUsage(taskId, mode, usage)
    return extractJsonArray(text)
  }

  let questions: GeneratedQuestion[]
  const prompt = promptLines.join('\n')
  try {
    questions = await attempt(prompt)
  } catch {
    questions = await attempt(
      prompt + '\n\nIMPORTANT: your previous output was not valid JSON. Output ONLY the fenced json array.'
    )
  }

  // Ad-hoc sets are additive — they never replace an existing per-resource set.
  const insert = db.prepare(
    `INSERT INTO questions (id, task_id, resource_id, question, answer, source_ref, due_at, created_at, origin, choices, correct_index)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (const q of questions.slice(0, count)) {
      insert.run(
        newId(),
        taskId,
        q.q,
        q.a,
        q.source_ref ?? null,
        nowIso(),
        nowIso(),
        mode === 'extract' ? 'extracted' : 'generated',
        q.choices ? JSON.stringify(q.choices) : null,
        q.choices ? (q.correct_index ?? null) : null
      )
    }
  })()
  return Math.min(questions.length, count)
}

async function generateForResource(
  taskId: string,
  resourceId: string,
  mode: QuestionMode
): Promise<number> {
  const db = getDb()
  const task = getTask(taskId)
  if (!task) throw new Error('task gone')
  const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as
    | { file_path: string | null; title: string }
    | undefined
  if (!resource?.file_path) throw new Error('resource gone')

  // Prefer the extracted plain text — the CLI's PDF rendering depends on
  // external tools (poppler) that may not be installed; text always works.
  const { ensurePdfText } = await import('./resources')
  const txtPath = await ensurePdfText(resource.file_path)
  const fileName = basename(txtPath ?? resource.file_path)
  pushJobStatus({ status: 'started', taskId, resourceId, title: resource.title, mode })

  const outputContract = [
    'Output ONLY a fenced ```json code block containing an array of objects:',
    '[{"q": "...", "a": "...", "source_ref": "...", "choices": ["...", "..."], "correct_index": 0}]',
    '"choices" (2-6 options) + "correct_index" (0-based) are ONLY for multiple-choice questions — omit both for free-response. For MC, "a" holds the correct answer text plus a one-line explanation.'
  ].join('\n')

  const prompt =
    mode === 'generate'
      ? [
          `Read the file "pdfs/${fileName}" in this folder.`,
          'Create 8-12 short recall questions that test understanding of its key ideas — definitions, mechanisms, relationships, results. Not trivia, not surface details.',
          'Prefer short-answer recall; use multiple choice (with plausible distractors) when the material tests discrimination between similar options.',
          'Answers must be brief (1-3 sentences) and self-contained.',
          'Where identifiable, set source_ref to the page or section (e.g. "p.4" or "§2.1").',
          outputContract
        ].join('\n')
      : [
          `Read the file "pdfs/${fileName}" in this folder.`,
          'This document contains existing questions/problems (e.g. a problem set, past exam, worksheet, or textbook exercises).',
          'EXTRACT the questions as they appear — keep the original wording, lightly cleaned up. Do not invent new questions.',
          'PRESERVE THE ORIGINAL FORMAT: if a question is multiple-choice in the document, extract its options into "choices" (original wording) with the right "correct_index" — never flatten MC into free-response.',
          'For each: if the document provides an answer or solution, use it (condensed to its essence); otherwise determine the correct answer yourself.',
          'Set source_ref to the question number and/or page (e.g. "Q3" or "Q3, p.2").',
          'Extract up to 40 questions. Skip cover pages, instructions, and non-question prose.',
          outputContract
        ].join('\n')

  const attempt = async (p: string): Promise<GeneratedQuestion[]> => {
    const { text, usage } = await runClaudeOnce({
      cwd: task.folderPath,
      prompt: p,
      allowedTools: 'Read(**)',
      maxTurns: 10,
      timeoutMs: 10 * 60 * 1000
    })
    logUsage(taskId, mode, usage)
    return extractJsonArray(text)
  }

  let questions: GeneratedQuestion[]
  try {
    questions = await attempt(prompt)
  } catch {
    // One retry with a corrective nudge.
    questions = await attempt(
      prompt + '\n\nIMPORTANT: your previous output was not valid JSON. Output ONLY the fenced json array.'
    )
  }

  // Idempotent per mode: re-running replaces this resource's previous
  // questions of the SAME origin (extracted and generated sets coexist).
  const origin = mode === 'generate' ? 'generated' : 'extracted'
  const insert = db.prepare(
    `INSERT INTO questions (id, task_id, resource_id, question, answer, source_ref, due_at, created_at, origin, choices, correct_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  db.transaction(() => {
    db.prepare('DELETE FROM questions WHERE resource_id = ? AND origin = ?').run(resourceId, origin)
    for (const q of questions) {
      insert.run(
        newId(),
        taskId,
        resourceId,
        q.q,
        q.a,
        q.source_ref ?? null,
        nowIso(),
        nowIso(),
        origin,
        q.choices ? JSON.stringify(q.choices) : null,
        q.choices ? (q.correct_index ?? null) : null
      )
    }
  })()

  return questions.length
}
