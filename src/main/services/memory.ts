import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'

// Shared, cross-workspace memory.
//
// Workspace agents are sandboxed to their own folder, which is what keeps
// them contained — but it also meant a fact you told one agent ("I'm taking
// CS 1331 this term") was invisible to every other workspace forever. This is
// the one deliberately SHARED channel: a small user-level file that is
// injected into every workspace's CLAUDE.md and the Jarvis briefing.
//
// Deliberate constraints:
//   * It is written by main, never by an agent's file tools — agents ask for
//     a fact to be remembered through the action protocol, and main appends.
//     So a workspace still cannot write into another workspace's folder.
//   * It holds short standing FACTS, not transcripts. Capped hard, because it
//     is prepended to every single agent turn.
//   * Private workspaces never contribute to it and never receive it.
//   * The user can read and edit it — it's plain markdown on disk, and it is
//     surfaced in Settings.

const MAX_FACTS = 40
const MAX_FACT_LEN = 240

export interface MemoryFact {
  text: string
  source: string // workspace title that taught it
  at: string
}

/** Exported so a backup can carry the shared facts to another machine. */
export function memoryPath(): string {
  return join(app.getPath('documents'), 'ASIT', 'memory.md')
}

function parse(content: string): MemoryFact[] {
  const facts: MemoryFact[] = []
  for (const line of content.split('\n')) {
    const m = line.match(/^-\s+(.*?)\s*(?:<!--\s*(.*?)\s*\|\s*(.*?)\s*-->)?\s*$/)
    if (m && m[1].trim()) {
      facts.push({ text: m[1].trim(), source: m[2] ?? 'unknown', at: m[3] ?? '' })
    }
  }
  return facts
}

export function listFacts(): MemoryFact[] {
  try {
    if (!existsSync(memoryPath())) return []
    return parse(readFileSync(memoryPath(), 'utf-8'))
  } catch {
    return []
  }
}

function write(facts: MemoryFact[]): void {
  const path = memoryPath()
  mkdirSync(dirname(path), { recursive: true })
  const body = [
    '# What ASIT remembers about you',
    '',
    'Standing facts shared by every workspace assistant. Edit or delete freely —',
    'this file is the memory. One fact per line.',
    '',
    ...facts.map((f) => `- ${f.text} <!-- ${f.source} | ${f.at} -->`),
    ''
  ].join('\n')
  writeFileSync(path, body, 'utf-8')
}

/** Returns false when the fact was a duplicate (or empty). */
export function rememberFact(text: string, source: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LEN)
  if (clean.length < 3) return false
  const facts = listFacts()
  const key = clean.toLowerCase()
  if (facts.some((f) => f.text.toLowerCase() === key)) return false
  facts.push({ text: clean, source, at: new Date().toISOString().slice(0, 10) })
  write(facts.slice(-MAX_FACTS))
  return true
}

export function forgetFact(text: string): boolean {
  const facts = listFacts()
  const key = text.replace(/\s+/g, ' ').trim().toLowerCase()
  const kept = facts.filter((f) => f.text.toLowerCase() !== key)
  if (kept.length === facts.length) return false
  write(kept)
  return true
}

/**
 * The block injected into every agent's instructions. Empty string when there
 * is nothing to say, so briefings stay clean on a fresh install.
 */
export function memorySection(): string {
  const facts = listFacts()
  if (facts.length === 0) {
    return [
      '',
      '## Shared memory',
      '',
      'Nothing remembered yet. When the user tells you a standing fact about themselves —',
      'a course they are taking, their major, a recurring deadline, how they like work presented —',
      'record it with `{"action":"remember","value":"<the fact>"}` so assistants in OTHER',
      'workspaces know it too. Only durable facts; never one-off task details, and never secrets.'
    ].join('\n')
  }
  return [
    '',
    '## Shared memory — what you already know about the user',
    '',
    'These facts came from the user across all their workspaces. Treat them as true and',
    'do not ask about them again:',
    '',
    ...facts.map((f) => `- ${f.text}`),
    '',
    'Add a new standing fact with `{"action":"remember","value":"<the fact>"}` (durable facts',
    'only — a course, a deadline pattern, a preference; never one-off details, never secrets).',
    'Remove a wrong one with `{"action":"forget","value":"<the exact fact>"}`.'
  ].join('\n')
}
