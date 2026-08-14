import { BrowserWindow } from 'electron'
import { getSettings } from './settings'

// Quick Fetch: agentless grep across your logged-in sites. A hidden window
// (shared login profile) loads the source, we extract its text, and either
// grep for keywords or auto-detect an OTP — instant, zero tokens, and it
// works no matter what tab you're on. Triggered with "?query" in the bar.

export interface QuickFetchResult {
  source: string
  otp: string | null
  lines: string[]
  error?: string
}

const OTP_INTENT = /\b(otp|2fa|code|verification|verify|passcode|pin)\b/i
const OTP_CONTEXT = /(code|otp|verification|verify|passcode|pin|sign.?in|login|one.?time)/i

function extractOtp(lines: string[]): string | null {
  // Scan top-down (most sites list newest first); a 4-8 digit number on or
  // right after a line with OTP-ish context wins.
  for (let i = 0; i < Math.min(lines.length, 400); i++) {
    if (!OTP_CONTEXT.test(lines[i])) continue
    for (const candidate of [lines[i], lines[i + 1] ?? '']) {
      const m = candidate.match(/(?<!\d)(\d{6})(?!\d)/) ?? candidate.match(/(?<!\d)(\d{4,8})(?!\d)/)
      if (m && !/^(19|20)\d{2}$/.test(m[1])) return m[1] // skip bare years
    }
  }
  return null
}

// One warm hidden window, reused across queries and destroyed after idling —
// a fresh Chromium renderer per "?query" cost ~100MB and a process start
// every time. destroyed-on-error so a wedged page can't poison later queries.
let fetchWin: BrowserWindow | null = null
let fetchIdleTimer: NodeJS.Timeout | null = null

function getFetchWindow(): BrowserWindow {
  if (fetchWin && !fetchWin.isDestroyed()) return fetchWin
  fetchWin = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      partition: 'persist:asit-browse',
      sandbox: true,
      contextIsolation: true
    }
  })
  return fetchWin
}

function releaseFetchWindow(broken: boolean): void {
  if (broken && fetchWin && !fetchWin.isDestroyed()) {
    fetchWin.destroy()
    fetchWin = null
    return
  }
  if (fetchIdleTimer) clearTimeout(fetchIdleTimer)
  fetchIdleTimer = setTimeout(() => {
    if (fetchWin && !fetchWin.isDestroyed()) fetchWin.destroy()
    fetchWin = null
  }, 60_000)
}

async function loadAndExtract(url: string, settleMs: number): Promise<string> {
  const win = getFetchWindow()
  let broken = false
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((r) => setTimeout(r, 12000)) // heavy apps may never "finish"
    ]).catch(() => undefined)
    await new Promise((r) => setTimeout(r, settleMs)) // let SPA content render
    // The exec itself needs a timeout: a page whose main thread is wedged
    // would otherwise hang the "?" bar forever and strand the renderer.
    const text = (await Promise.race([
      win.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('page hung')), 10000))
    ])) as string
    return text.slice(0, 120000)
  } catch (err) {
    broken = true
    throw err
  } finally {
    releaseFetchWindow(broken)
  }
}

// Agentless extractive answer: score every sentence from the results page by
// query-term overlap + intent bonuses (date questions boost date-bearing
// sentences, quantity questions boost numbers) and return the single best.
// Deliberately heuristic — the goal is a direct answer in ~2s, not perfection.
const STOPWORDS = new Set(
  'the a an of for to in on at is are was be what when whats how who where why which do does did with and or my your'.split(' ')
)
const DATE_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s*\d{4})?\b|\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i

function bestSentence(
  query: string,
  candidates: { text: string; host: string }[]
): { text: string; host: string } | null {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  const wantsDate = /\b(when|deadline|date|day|due|until|schedule|open|close)s?\b/i.test(query)
  const wantsNumber = /\b(how (much|many)|cost|price|fee|size|length|duration)\b/i.test(query)

  let best: { text: string; host: string } | null = null
  let bestScore = 0
  for (const c of candidates) {
    for (const raw of c.text.split(/(?<=[.!?])\s+|\n/)) {
      const s = raw.trim()
      if (s.length < 12 || s.length > 280) continue
      const lower = s.toLowerCase()
      let score = 0
      for (const t of terms) if (lower.includes(t)) score += 2
      if (wantsDate && DATE_RE.test(s)) score += 5
      if (wantsNumber && /\d/.test(s)) score += 3
      if (/\b20\d\d\b/.test(s)) score += 1
      if (score > bestScore) {
        bestScore = score
        best = { text: s, host: c.host }
      }
    }
  }
  return bestScore >= 4 ? best : null
}

// "?g <query>": instant Google — hidden window loads the results page and we
// distill a DIRECT answer locally (answer box, else best-sentence heuristic),
// with a compact "More" line of links. No tabs, no model.
async function googleSearch(q: string): Promise<QuickFetchResult> {
  const win = getFetchWindow()
  let broken = false
  try {
    await Promise.race([
      win.loadURL(`https://www.google.com/search?q=${encodeURIComponent(q)}`),
      new Promise((r) => setTimeout(r, 8000))
    ]).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 900)) // results render almost immediately

    const extracted = (await Promise.race([
      new Promise((_r, reject) => setTimeout(() => reject(new Error('page hung')), 10000)),
      win.webContents.executeJavaScript(
      `(() => {
        const answer = document.querySelector('[data-attrid="wa:/description"], .hgKElc, .IZ6rdc, .Z0LcW')
        const results = Array.from(document.querySelectorAll('#search h3')).slice(0, 6).map(h => {
          const a = h.closest('a')
          const block = h.closest('[data-hveid]') || h.parentElement
          const text = block ? block.innerText.replace(/\\s+/g, ' ').trim() : ''
          return {
            title: h.innerText.trim(),
            url: a ? a.href : '',
            snippet: text.slice(h.innerText.length).trim().slice(0, 220)
          }
        }).filter(r => r.title)
        return { answer: answer ? answer.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400) : null, results }
      })()`,
        true
      )
    ])) as { answer: string | null; results: { title: string; url: string; snippet: string }[] }

    const hostOf = (u: string): string => {
      try {
        return new URL(u).hostname.replace(/^www\./, '')
      } catch {
        return ''
      }
    }

    const lines: string[] = []
    if (extracted.answer) {
      // Google's own answer box wins when present.
      lines.push(`**${extracted.answer}**`)
    } else {
      const candidates = extracted.results.map((r) => ({
        text: `${r.title}. ${r.snippet}`,
        host: hostOf(r.url) || 'google'
      }))
      const answer = bestSentence(q, candidates)
      if (answer) {
        lines.push(`**${answer.text}**`)
        lines.push(`— ${answer.host}`)
      }
    }

    // Compact source row — links, not a wall of snippets.
    const more = extracted.results
      .filter((r) => r.url)
      .slice(0, 3)
      .map((r) => `[${(r.title || hostOf(r.url)).slice(0, 40)}](${r.url})`)
    if (more.length > 0) lines.push(`More: ${more.join(' · ')}`)

    if (lines.length === 0) return { source: 'Google', otp: null, lines: [], error: 'no results extracted' }
    return { source: 'Google', otp: null, lines }
  } catch (err) {
    broken = true
    throw err
  } finally {
    releaseFetchWindow(broken)
  }
}

export async function quickFetch(query: string): Promise<QuickFetchResult> {
  let trimmed = query.trim()
  if (!trimmed) return { source: '', otp: null, lines: [], error: 'empty query' }

  // "?g deadline hack harvard" → instant Google result.
  const gMatch = trimmed.match(/^(g|google)\s+(.+)$/i)
  if (gMatch) return googleSearch(gMatch[2])

  let sources = getSettings().fetchSources
  if (!sources || sources.length === 0) {
    return { source: '', otp: null, lines: [], error: 'no fetch sources configured (Settings)' }
  }

  // Source targeting: "?outlook otp" / "?gmail john email" — if the first
  // word names a source, search only there. Default: all sources in order.
  const firstWord = trimmed.split(/\s+/)[0].replace(/:$/, '').toLowerCase()
  const targeted = sources.find((s) => s.name.toLowerCase() === firstWord)
  if (targeted) {
    sources = [targeted]
    trimmed = trimmed.split(/\s+/).slice(1).join(' ').trim()
    if (!trimmed) {
      return {
        source: targeted.name,
        otp: null,
        lines: [],
        error: `what should I look for in ${targeted.name}? e.g. "?${firstWord} otp"`
      }
    }
  } else {
    // Untargeted "?" queries hit ONLY the default (first) source — Gmail —
    // never the whole list. Other sources are opt-in by name.
    sources = [sources[0]]
  }

  const wantOtp = OTP_INTENT.test(trimmed) && trimmed.split(/\s+/).length <= 3
  const keywords = trimmed
    .split(/\s+/)
    .map((k) => k.toLowerCase())
    .filter(Boolean)

  const allMatches: string[] = []
  for (const source of sources) {
    // OTP: hit the inbox itself (search indexes lag behind brand-new mail).
    const url = wantOtp
      ? source.url.replace(/#?search\/\{q\}.*$/, '').replace('{q}', '')
      : source.url.replace('{q}', encodeURIComponent(trimmed))
    let text: string
    try {
      text = await loadAndExtract(url, wantOtp ? 3500 : 3000)
    } catch (err) {
      continue
    }
    const lines = text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length > 0)

    if (wantOtp) {
      const otp = extractOtp(lines)
      if (otp) return { source: source.name, otp, lines: [] }
    } else {
      const strict = lines.filter((l) => keywords.every((k) => l.toLowerCase().includes(k)))
      const loose =
        strict.length > 0
          ? []
          : lines.filter((l) => keywords.some((k) => l.toLowerCase().includes(k)))
      for (const l of [...strict, ...loose].slice(0, 12 - allMatches.length)) {
        allMatches.push(`[${source.name}] ${l.slice(0, 200)}`)
      }
      if (allMatches.length >= 12) break
    }
  }

  if (wantOtp) return { source: sources[0].name, otp: null, lines: [], error: 'no recent code found' }
  return { source: sources.map((s) => s.name).join(', '), otp: null, lines: allMatches }
}
