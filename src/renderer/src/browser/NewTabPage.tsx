import { useEffect, useState } from 'react'
import type { Bookmark, HistoryEntry, Task } from '@shared/types'
import AddressBar, { hostOf } from '../components/AddressBar'
import { onBookmarksChanged } from './BookmarkStar'
import { useStore } from '../store/useStore'
import { groupColor } from './GroupBar'
import TodoList from '../components/TodoList'
import NtpAutomations from './NtpAutomations'

// The new-tab page — and, since the home screen was retired, the dashboard.
//
// A separate home SCREEN was the wrong shape: it was a mode you had to leave
// to browse, so the two halves of the app fought over the window. Everything
// that lived there is genuinely "what I might do next", which is exactly the
// question a new tab asks. So it lives here, one Ctrl+T away from anywhere,
// and it costs nothing when you just want to type an address.
//
// Plain DOM: an NTP tab has no pane, so nothing paints over this (invariant 2
// by construction — the builtin-notes pattern).

function daysUntil(dueDate: string): number {
  return Math.ceil((new Date(dueDate + 'T23:59:59').getTime() - Date.now()) / 86400000)
}

function dueLabel(task: Task): { text: string; overdue: boolean } | null {
  if (!task.dueDate) return null
  const days = daysUntil(task.dueDate)
  if (days < 0) return { text: `${-days}d overdue`, overdue: true }
  if (days === 0) return { text: 'due today', overdue: true }
  if (days === 1) return { text: 'due tomorrow', overdue: false }
  return { text: `due in ${days}d`, overdue: false }
}

/** What to work on first: overdue beats due-soon beats stale beats priority. */
function score(task: Task, dueQuestions: number): number {
  let s = 0
  if (task.dueDate) {
    const days = daysUntil(task.dueDate)
    if (days < 0) s += 1000 + Math.min(10, -days) * 10
    else if (days === 0) s += 500
    else s += Math.max(0, 200 - days * 25)
  }
  s += Math.min(50, dueQuestions * 5)
  s += (4 - task.priority) * 50
  const staleDays = task.lastOpenedAt
    ? (Date.now() - new Date(task.lastOpenedAt).getTime()) / 86400000
    : 3
  s += Math.min(20, staleDays * 2)
  return s
}

export default function NewTabPage({
  onNavigate
}: {
  /** Typing or clicking a site converts this tab into a real page. */
  onNavigate: (value: string) => void
}): JSX.Element {
  const [topSites, setTopSites] = useState<HistoryEntry[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [dueByTask, setDueByTask] = useState<Record<string, number>>({})
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  const scratchId = useStore((s) => s.scratchTask?.id)
  const switchGroup = useStore((s) => s.switchGroup)
  const studyEnabled = useStore((s) => s.settings?.studyEnabled ?? true)

  useEffect(() => {
    // An empty query is the visit-count ranking — the browser's "top sites".
    void window.asit.history.search('', 8).then(setTopSites)
    void window.asit.tasks.stats().then((s) => setDueByTask(s.dueByTask))
    const load = (): void => {
      void window.asit.bookmarks.list().then(setBookmarks)
    }
    load()
    return onBookmarksChanged(load)
  }, [])

  const groups = tasks
    .filter((t) => t.status === 'active' && t.id !== activeTask?.id && t.id !== scratchId)
    .map((t) => ({ task: t, due: dueByTask[t.id] ?? 0 }))
    .sort((a, b) => score(b.task, b.due) - score(a.task, a.due))
    .slice(0, 6)

  return (
    <div className="ntp">
      <div className="ntp-inner">
        <AddressBar url="" onNavigate={onNavigate} className="ntp-address" autoFocus />

        {groups.length > 0 && (
          <div className="ntp-section">
            <div className="ntp-label">Pick up where you left off</div>
            <div className="ntp-groups">
              {groups.map(({ task, due }) => {
                const label = dueLabel(task)
                return (
                  <button
                    key={task.id}
                    className="ntp-group"
                    style={{ ['--group-color' as string]: groupColor(task.id) }}
                    onClick={() => void switchGroup(task.id)}
                  >
                    <span className="group-dot" />
                    <span className="ntp-group-name">{task.title}</span>
                    {label && (
                      <span className={`ntp-group-due ${label.overdue ? 'ntp-due-late' : ''}`}>
                        {label.text}
                      </span>
                    )}
                    {studyEnabled && due > 0 && <span className="ntp-group-recall">{due} to recall</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="ntp-columns">
          <div className="ntp-section ntp-todos">
            <div className="ntp-label">To do</div>
            <TodoList onOpenUrl={onNavigate} />
          </div>

          <div className="ntp-side">
            <NtpAutomations />
            {bookmarks.length > 0 && (
              <div className="ntp-section">
                <div className="ntp-label">Bookmarks</div>
                <div className="ntp-sites">
                  {bookmarks.slice(0, 10).map((b) => (
                    <button
                      key={b.id}
                      className="ntp-site"
                      title={b.url}
                      onClick={() => onNavigate(b.url)}
                    >
                      <span className="ntp-site-host">
                        {b.favicon ? <img className="ntp-favicon" src={b.favicon} alt="" /> : '★'}{' '}
                        {hostOf(b.url)}
                      </span>
                      <span className="ntp-site-title">{b.title || hostOf(b.url)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {topSites.length > 0 && (
              <div className="ntp-section">
                <div className="ntp-label">Often visited</div>
                <div className="ntp-sites">
                  {topSites.map((s) => (
                    <button
                      key={s.id}
                      className="ntp-site"
                      title={s.url}
                      onClick={() => onNavigate(s.url)}
                    >
                      <span className="ntp-site-host">{hostOf(s.url)}</span>
                      <span className="ntp-site-title">{s.title || hostOf(s.url)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {topSites.length === 0 && bookmarks.length === 0 && (
              <p className="ntp-empty">
                Type an address or search — sites you visit often will show up here.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
