import { useEffect, useMemo, useRef, useState } from 'react'
import type { Bookmark, HistoryEntry, Workflow } from '@shared/types'
import { SHORTCUTS } from '@shared/shortcuts'
import { engineName } from '@shared/search'
import { useStore } from '../store/useStore'
import { fuzzyScore } from '../lib/fuzzy'
import { bareUrl, hostOf, looksLikeUrl, toNavUrl } from '../lib/url'
import { browseForMePrompt } from '../lib/agentPrompts'
import { runShortcut } from '../hooks/useFocusRing'
import { onBookmarksChanged } from './BookmarkStar'
import { BROWSE_COLOR, groupColor } from './GroupBar'

// The omnibox: ONE ranking of "what did you mean" for every box that takes an
// address — the command bar (Ctrl+T / Ctrl+L), the sidebar pill, the new-tab
// page and the compact toolbar. Arc's command bar is the model: the top row
// is always what Enter does (open the URL / search the engine), then open
// tabs ("Switch to Tab"), engine suggestions, your bookmarks and history,
// and — in the command bar — spaces, workflows and commands.
//
// Everything here is user-driven UI. Suggestions go to the engine the user
// chose (Settings → search suggestions); history and bookmarks stay local.

export type OmniKind =
  | 'go'
  | 'search'
  | 'suggest'
  | 'tab'
  | 'bookmark'
  | 'history'
  | 'space'
  | 'resource'
  | 'workflow'
  | 'command'
  | 'ask'
  | 'newtab'

export interface OmniRow {
  id: string
  kind: OmniKind
  title: string
  subtitle?: string
  icon?: string | null
  glyph?: string
  color?: string
  /** Right-hand label on the highlighted row ("Switch to Tab", "Search"…). */
  action: string
  url?: string
  run: (opts: { newTab: boolean }) => void
}

export interface OmniboxOptions {
  /** An editing session is live (focused box / open bar). */
  open: boolean
  /** Spaces, resources, workflows and commands — the command bar only. */
  includeApp: boolean
  /** Rows for an empty query (open tabs, top sites). */
  emptyRows: boolean
  /** Offer "New tab page" first on an empty query (Ctrl+T). */
  offerNewTabPage?: boolean
  /** Inline completion is allowed for this keystroke (not after a delete). */
  allowComplete: boolean
  /** How a URL row opens. */
  go: (url: string, newTab: boolean) => void
}

export interface Completion {
  /** The suffix shown selected after what was typed. */
  text: string
  url: string
}

// Bookmarks are small and change rarely — one shared cache, refreshed on change.
let bookmarkCache: Bookmark[] | null = null
let bookmarkLoad: Promise<Bookmark[]> | null = null
function loadBookmarks(): Promise<Bookmark[]> {
  bookmarkLoad ??= window.asit.bookmarks.list().then((b) => {
    bookmarkCache = b
    bookmarkLoad = null
    return b
  })
  return bookmarkLoad
}
if (typeof window !== 'undefined') {
  onBookmarksChanged(() => {
    bookmarkCache = null
    void loadBookmarks()
  })
}

/** Every whitespace-separated term appears somewhere in the haystack. */
function matchesTerms(hay: string, terms: string[]): boolean {
  const h = hay.toLowerCase()
  return terms.every((t) => h.includes(t))
}

/** Prefix of title or host beats a mere contains. */
function textRank(title: string, url: string, q: string): number {
  const t = title.toLowerCase()
  const b = bareUrl(url).toLowerCase()
  if (b.startsWith(q)) return 3
  if (t.startsWith(q)) return 2
  if (new RegExp(`(^|[\\s\\-_/.:])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 1
  return 0
}

export function useOmnibox(
  query: string,
  opts: OmniboxOptions
): { rows: OmniRow[]; completion: Completion | null } {
  const q = query.trim()
  const ql = q.toLowerCase()
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyFor, setHistoryFor] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestFor, setSuggestFor] = useState('')
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(bookmarkCache ?? [])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const settings = useStore((s) => s.settings)
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  const scratch = useStore((s) => s.scratchTask)
  const activeResources = useStore((s) => s.activeResources)
  const optsRef = useRef(opts)
  optsRef.current = opts

  // Per-session loads.
  useEffect(() => {
    if (!opts.open) return
    let live = true
    void loadBookmarks().then((b) => live && setBookmarks(b))
    if (opts.includeApp) void window.asit.workflows.list().then((w) => live && setWorkflows(w))
    return () => {
      live = false
    }
  }, [opts.open, opts.includeApp])

  // History: fast (local sqlite), lightly debounced, stale replies dropped.
  useEffect(() => {
    if (!opts.open) return
    if (!q && !opts.emptyRows) {
      setHistory([])
      setHistoryFor('')
      return
    }
    let live = true
    const t = setTimeout(() => {
      void window.asit.history.search(q, q ? 10 : 6).then((rows) => {
        if (!live) return
        setHistory(rows)
        setHistoryFor(q)
      })
    }, q ? 40 : 0)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, opts.open, opts.emptyRows])

  // Engine suggestions: network, so a little more debounce. Never for
  // something that is plainly an address.
  useEffect(() => {
    if (!opts.open || !q || looksLikeUrl(q) || settings?.searchSuggestions === false) {
      setSuggestions([])
      setSuggestFor('')
      return
    }
    let live = true
    const t = setTimeout(() => {
      void window.asit.browser.suggest(q).then((list) => {
        if (!live) return
        setSuggestions(list)
        setSuggestFor(q)
      })
    }, 110)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, opts.open, settings?.searchSuggestions])

  const tabs = useMemo(
    () => (opts.open ? (useStore.getState().tabSurface?.listTabs() ?? []) : []),
    // Re-read per keystroke: tabs change under an open bar rarely, but cheaply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.open, q]
  )

  // Inline completion (Chrome/Arc): typing "gith" fills in "ub.com" selected,
  // from the places you actually go. Visit-ranked history first (it is the
  // signal for "you meant this"), then bookmarks, then open tabs.
  const completion = useMemo((): Completion | null => {
    if (!opts.allowComplete || !ql || /\s/.test(ql) || ql.length < 1) return null
    const urls: string[] = []
    if (historyFor === q) urls.push(...history.map((h) => h.url))
    urls.push(...bookmarks.map((b) => b.url), ...tabs.flatMap((t) => (t.url ? [t.url] : [])))
    const wantsPath = ql.includes('/')
    for (const url of urls) {
      if (!/^https?:/i.test(url)) continue
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        continue
      }
      const host = parsed.hostname.replace(/^www\./, '')
      const candidate = wantsPath ? bareUrl(url).replace(/\/$/, '') : host
      if (candidate.toLowerCase().startsWith(ql) && candidate.length > ql.length) {
        return {
          text: candidate.slice(ql.length),
          url: wantsPath ? url : `${parsed.protocol}//${parsed.host}/`
        }
      }
    }
    return null
  }, [opts.allowComplete, ql, q, history, historyFor, bookmarks, tabs])

  const rows = useMemo((): OmniRow[] => {
    const o = optsRef.current
    const out: OmniRow[] = []
    const seenUrls = new Set<string>()
    const store = useStore.getState()
    const surface = store.tabSurface
    const aiOff = !!activeTask?.aiDisabled
    const engine = engineName(settings ?? { searchEngine: 'google', searchUrlCustom: '' })
    const searchRow = (text: string, kind: 'search' | 'suggest'): OmniRow => {
      const url = toNavUrl(text)
      return {
        id: `${kind}:${text}`,
        kind,
        title: text,
        subtitle: kind === 'search' ? `Search ${engine}` : undefined,
        glyph: '⌕',
        action: 'Search',
        url,
        run: ({ newTab }) => o.go(url, newTab)
      }
    }
    const urlRow = (
      kind: 'go' | 'bookmark' | 'history',
      url: string,
      title: string,
      icon: string | null | undefined
    ): OmniRow => ({
      id: `${kind}:${url}`,
      kind,
      title: title || hostOf(url),
      subtitle: bareUrl(url).replace(/\/$/, ''),
      icon: icon ?? null,
      glyph: (hostOf(url)[0] ?? '·').toUpperCase(),
      action: 'Open',
      url,
      run: ({ newTab }) => o.go(url, newTab)
    })
    const tabRow = (t: (typeof tabs)[number]): OmniRow => ({
      id: `tab:${t.id}`,
      kind: 'tab',
      title: t.title || (t.url ? hostOf(t.url) : 'Tab'),
      subtitle: t.url ? bareUrl(t.url).replace(/\/$/, '') : t.kind,
      icon: t.favicon,
      glyph: t.url ? (hostOf(t.url)[0] ?? '·').toUpperCase() : '▤',
      action: 'Switch to Tab',
      url: t.url ?? undefined,
      run: () => surface?.selectTab(t.id)
    })

    // ---- empty box ---------------------------------------------------------
    if (!q) {
      if (!o.emptyRows) return []
      if (o.offerNewTabPage)
        out.push({
          id: 'newtab',
          kind: 'newtab',
          title: 'New tab page',
          subtitle: 'Your dashboard — spaces, to-dos, automations',
          glyph: '＋',
          action: 'Open',
          run: () => surface?.newTab()
        })
      for (const t of tabs.filter((t) => !t.active).slice(0, 7)) {
        out.push(tabRow(t))
        if (t.url) seenUrls.add(t.url)
      }
      if (historyFor === '')
        for (const h of history) {
          if (seenUrls.has(h.url) || out.length >= 12) continue
          seenUrls.add(h.url)
          out.push(urlRow('history', h.url, h.title, h.favicon))
        }
      return out
    }

    const terms = ql.split(/\s+/).filter(Boolean)

    // ---- the top row: exactly what Enter does -------------------------------
    if (completion) {
      const hit = [...history, ...bookmarks].find((x) => x.url === completion.url)
      const fav =
        history.find((h) => hostOf(h.url) === hostOf(completion.url))?.favicon ??
        bookmarks.find((b) => hostOf(b.url) === hostOf(completion.url))?.favicon
      out.push(urlRow('go', completion.url, hit?.title ?? hostOf(completion.url), fav))
      seenUrls.add(completion.url)
      if (!looksLikeUrl(q)) out.push(searchRow(q, 'search'))
    } else if (looksLikeUrl(q)) {
      const url = toNavUrl(q)
      out.push({ ...urlRow('go', url, q, null), subtitle: 'Open address', glyph: '↗' })
      seenUrls.add(url)
    } else {
      out.push(searchRow(q, 'search'))
    }

    // ---- open tabs ----------------------------------------------------------
    const tabHits = tabs
      .filter((t) => !t.active && matchesTerms(`${t.title} ${t.url ?? ''}`, terms))
      .sort((a, b) => textRank(b.title, b.url ?? '', ql) - textRank(a.title, a.url ?? '', ql))
      .slice(0, 3)
    for (const t of tabHits) {
      out.push(tabRow(t))
      if (t.url) seenUrls.add(t.url)
    }

    // ---- engine suggestions -------------------------------------------------
    if (suggestFor === q)
      for (const s of suggestions.slice(0, completion ? 3 : 4)) out.push(searchRow(s, 'suggest'))

    // ---- bookmarks + history ------------------------------------------------
    const pages: { row: OmniRow; rank: number }[] = []
    for (const b of bookmarks) {
      if (seenUrls.has(b.url) || !matchesTerms(`${b.title} ${b.url}`, terms)) continue
      seenUrls.add(b.url)
      pages.push({ row: { ...urlRow('bookmark', b.url, b.title, b.favicon), glyph: '★' }, rank: 10 + textRank(b.title, b.url, ql) * 10 })
    }
    if (historyFor === q)
      for (const h of history) {
        if (seenUrls.has(h.url)) continue
        seenUrls.add(h.url)
        pages.push({
          row: urlRow('history', h.url, h.title, h.favicon),
          rank: textRank(h.title, h.url, ql) * 10 + Math.min(9, h.visitCount)
        })
      }
    pages.sort((a, b) => b.rank - a.rank)
    for (const p of pages.slice(0, 5)) out.push(p.row)

    // ---- the app: spaces, things in this space, workflows, commands ---------
    if (o.includeApp) {
      const app: { row: OmniRow; score: number }[] = []
      const wordStart = new RegExp(`(^|[\\s\\-_/.:])${ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      const consider = (label: string, row: OmniRow, extra = ''): void => {
        // Two or three letters scatter into almost any label ("fi" → "Add a
        // PDF or file"); until the query is longer, only a word start counts.
        if (ql.length < 4 && !wordStart.test(label.toLowerCase())) return
        const s = Math.max(fuzzyScore(label, q), extra ? fuzzyScore(extra, q) - 200 : -1)
        // Scattered subsequence hits are noise in a list this mixed.
        if (s >= Math.max(60, q.length * 18)) app.push({ row, score: s })
      }
      const spaces = [
        ...(scratch && scratch.id !== activeTask?.id ? [scratch] : []),
        ...tasks.filter((t) => t.status === 'active' && t.id !== activeTask?.id && t.id !== scratch?.id)
      ]
      for (const t of spaces) {
        const isBrowse = t.id === scratch?.id
        const label = isBrowse ? 'Browse' : t.title
        consider(label, {
          id: `space:${t.id}`,
          kind: 'space',
          title: label,
          subtitle: t.aiDisabled ? 'Space · private' : 'Space',
          color: isBrowse ? BROWSE_COLOR : groupColor(t.id),
          action: 'Switch Space',
          run: () => void store.switchGroup(t.id)
        })
      }
      if (activeTask)
        for (const r of activeResources)
          consider(r.title, {
            id: `res:${r.id}`,
            kind: 'resource',
            title: r.title,
            subtitle: `In this space · ${r.kind}`,
            glyph: r.kind === 'pdf' ? '▤' : r.kind === 'url' ? '◍' : '✎',
            action: 'Open',
            run: () => void store.openTaskAndResource(activeTask.id, r.id)
          })
      for (const w of workflows) {
        if (w.taskId && w.taskId !== activeTask?.id) continue
        const needsInput = w.params.some((p) => p.required && !p.default)
        consider(
          w.name.replace(/-/g, ' '),
          {
            id: `wf:${w.id}`,
            kind: 'workflow',
            title: w.name,
            subtitle: w.description || `Workflow · ${w.steps.length} steps`,
            glyph: '⚡',
            action: needsInput ? 'Fill in & Run' : 'Run',
            run: () => {
              if (needsInput) return store.setAutomationsOpen(true)
              void window.asit.workflows.run(w.name).then((r) =>
                store.pushNotice(r.started ? `Running ${w.name}…` : (r.reason ?? 'Could not start'), r.started ? 'info' : 'error')
              )
            }
          },
          w.description
        )
      }
      const seenCmd = new Set<string>()
      for (const s of SHORTCUTS) {
        if (!s.label || s.id === 'open-palette' || seenCmd.has(s.id)) continue
        seenCmd.add(s.id)
        consider(s.label, {
          id: `cmd:${s.id}`,
          kind: 'command',
          title: s.label,
          subtitle: s.accel.replace('CommandOrControl', navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'),
          glyph: '⌘',
          action: 'Run',
          run: () => runShortcut(s.id)
        })
      }
      app.sort((a, b) => b.score - a.score)
      for (const a of app.slice(0, 5)) out.push(a.row)
    }

    // ---- hand it to the agent ------------------------------------------------
    if (!aiOff && o.includeApp)
      out.push({
        id: 'ask',
        kind: 'ask',
        title: q,
        subtitle: 'Ask the agent to browse for you',
        glyph: '✦',
        action: '⇧↵ Ask',
        // The user's own typed words — sent, like the new-tab page's
        // "Browse for me" (invariant 21's one sent seed).
        run: () => store.seedChat(browseForMePrompt(q), { send: true })
      })

    return out
  }, [q, ql, completion, tabs, history, historyFor, suggestions, suggestFor, bookmarks, workflows, tasks, activeTask, scratch, activeResources, settings])

  return { rows, completion }
}

/** Bold the first place the query appears, so you can see why a row matched. */
function Marked({ text, query }: { text: string; query: string }): JSX.Element {
  const q = query.trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <b>{text.slice(at, at + q.length)}</b>
      {text.slice(at + q.length)}
    </>
  )
}

export function OmniIcon({ row }: { row: OmniRow | undefined }): JSX.Element {
  if (!row) return <span className="omni-icon omni-icon-glyph">⌕</span>
  if (row.kind === 'space')
    return (
      <span className="omni-icon">
        <span className="omni-space-dot" style={{ background: row.color }} />
      </span>
    )
  if (row.icon) return <FaviconIcon row={row} />
  return <span className={`omni-icon omni-icon-glyph omni-icon-${row.kind}`}>{row.glyph ?? '·'}</span>
}

function FaviconIcon({ row }: { row: OmniRow }): JSX.Element {
  const [broken, setBroken] = useState(false)
  if (broken) return <span className={`omni-icon omni-icon-glyph omni-icon-${row.kind}`}>{row.glyph ?? '·'}</span>
  return (
    <span className="omni-icon">
      <img src={row.icon ?? ''} alt="" onError={() => setBroken(true)} />
    </span>
  )
}

export function OmniRowView({
  row,
  query,
  on,
  onHover,
  onPick
}: {
  row: OmniRow
  query: string
  on: boolean
  onHover: () => void
  onPick: (newTab: boolean) => void
}): JSX.Element {
  return (
    <div
      className={`omni-row omni-${row.kind} ${on ? 'omni-row-on' : ''}`}
      data-on={on ? '1' : '0'}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        e.preventDefault() // keep focus in the box so blur doesn't race the click
        onPick(e.metaKey || e.ctrlKey || e.button === 1)
      }}
    >
      <OmniIcon row={row} />
      <span className="omni-text">
        <span className="omni-title">
          <Marked text={row.title} query={query} />
        </span>
        {row.subtitle && <span className="omni-sub">{row.subtitle}</span>}
      </span>
      <span className="omni-action">
        {row.action} <span className="omni-enter">↵</span>
      </span>
    </div>
  )
}
