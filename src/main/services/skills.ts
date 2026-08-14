import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { basename, join } from 'path'

// Skills: saved procedures ("how to get the X url: click …, then …") that the
// model records once via the save_skill action and the user replays with
// "./name" in chat — the skill text is inlined into the prompt so no tokens
// are wasted re-deriving the flow. Global across tasks.

export function skillsRoot(): string {
  return join(app.getPath('documents'), 'ASIT', 'skills')
}

export interface Skill {
  name: string
  content: string
}

export function listSkills(): Skill[] {
  const root = skillsRoot()
  mkdirSync(root, { recursive: true })
  return readdirSync(root)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({
      name: f.replace(/\.md$/, ''),
      content: readFileSync(join(root, f), 'utf-8').slice(0, 6000)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function saveSkill(name: string, content: string): string {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const body = String(content).trim().slice(0, 8000)
  if (!slug) return 'save_skill: invalid name'
  if (!body) return 'save_skill: empty content'
  mkdirSync(skillsRoot(), { recursive: true })
  const path = join(skillsRoot(), `${slug}.md`)
  // Overwrites are called out loudly: silently replacing a trusted skill with
  // a poisoned flow would be persistent injection the user replays themselves.
  const overwrote = existsSync(path)
  writeFileSync(path, body)
  return overwrote ? `skill saved: ./${slug} (REPLACED the existing skill)` : `skill saved: ./${slug}`
}

// Auto-flow: a skill whose content includes a ```asit-flow fenced block of
// one action-JSON per line replays deterministically (no model in the loop).
export function extractFlow(content: string): Record<string, unknown>[] | null {
  const m = content.match(/```asit-flow\s*\n([\s\S]*?)```/)
  if (!m) return null
  const steps: Record<string, unknown>[] = []
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed.action === 'string') steps.push(parsed)
    } catch {
      // skip malformed lines
    }
  }
  return steps.length > 0 ? steps : null
}

export function deleteSkill(name: string): void {
  const file = join(skillsRoot(), `${basename(name)}.md`)
  if (!existsSync(file)) return
  // Same never-hard-delete rule as everything else.
  const trash = join(app.getPath('documents'), 'ASIT', '.trash', 'skills')
  mkdirSync(trash, { recursive: true })
  renameSync(file, join(trash, `${Date.now()}-${basename(name)}.md`))
}
