import { useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { DownloadItem } from '@shared/types'
import { useStore } from '../store/useStore'
import SavePasswordPrompt from './SavePasswordPrompt'
import Dictation from './Dictation'
import UpdatePill from './UpdatePill'
import { useOverlay } from '../hooks/useOverlay'
import { CliSetupButtons, CliSignInButtons, useCliStatus } from './CliSetup'

/**
 * Everything AI in this app runs on the Claude Code CLI, and installing ASIT
 * does not install it. This used to be discovered one broken feature at a
 * time — the app booted looking perfectly healthy with a dead AI, and the fix
 * lived in a settings field under "Advanced". Check on startup and say so, in
 * the one strip pages never paint over, with the fix one click away.
 */
function CliHealth(): JSX.Element | null {
  const status = useCliStatus()
  const [open, setOpen] = useState(false)
  const missing = status.path === null
  const needsLogin = !missing && status.path !== undefined && status.loggedIn === false
  const unhealthy = missing || needsLogin
  useOverlay(open && unhealthy)

  // The hook re-probes on a timer and when Settings closes, so fixing the
  // CLI anywhere clears this chip on its own; celebrate it once.
  const wasUnhealthy = useRef(false)
  useEffect(() => {
    if (unhealthy) wasUnhealthy.current = true
    else if (wasUnhealthy.current) {
      wasUnhealthy.current = false
      setOpen(false)
      useStore.getState().pushNotice('AI is ready — Claude Code is set up.', 'ok')
    }
  }, [unhealthy])

  if (!unhealthy) return null

  return (
    <>
      <button
        className="status-load-error"
        title={
          missing
            ? 'The AI features need Claude Code. One click installs it.'
            : 'Claude Code is installed but not signed in — one click fixes it.'
        }
        onClick={() => setOpen((v) => !v)}
      >
        {missing ? '⚠ AI setup needed' : '⚠ AI sign-in needed'}
      </button>
      {open && (
        <div className="downloads-popover cli-popover">
          {missing ? (
            <>
              <p className="cli-popover-text">
                ASIT&apos;s AI runs on <strong>Claude Code</strong>, which isn&apos;t installed
                yet. One click installs it; then sign in and you&apos;re done.
              </p>
              <div className="cli-popover-actions">
                <CliSetupButtons status={status} />
              </div>
            </>
          ) : (
            <>
              <p className="cli-popover-text">
                Claude Code is installed but no account is signed in, so AI replies will fail.
              </p>
              <div className="cli-popover-actions">
                <CliSignInButtons status={status} />
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

// Everything that used to float along the bottom edge — running work, job
// progress, toasts, the quick-assistant launcher — compressed into the header
// row. Embedded pages paint over all app DOM, so the header band is the only
// place a floating indicator stays visible; putting it here also costs zero
// screen space, which the bottom dock did not.

function elapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m`
}

/**
 * An error chip that stays until dismissed, with the FULL message one click
 * away — the header hasn't room for a paragraph, but a popover does.
 */
function ErrorNotice({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const dismiss = useStore((s) => s.dismissNotice)
  useOverlay(open)
  return (
    <>
      <button
        className="status-notice status-notice-error"
        title="Click for details"
        onClick={() => setOpen((v) => !v)}
      >
        {text}
      </button>
      {open && (
        <div className="downloads-popover cli-popover">
          <p className="cli-popover-text">{text}</p>
          <div className="cli-popover-actions">
            <button className="btn" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export default function StatusCluster(): JSX.Element {
  const activity = useStore((s) => s.activity)
  const jobStatus = useStore((s) => s.jobStatus)
  const notice = useStore((s) => s.notice)
  const loadError = useStore((s) => s.loadError)
  const retryLoad = useStore((s) => s.retryLoad)
  const assistantOpen = useStore((s) => s.assistantOpen)
  const setAssistantOpen = useStore((s) => s.setAssistantOpen)
  const openTask = useStore((s) => s.openTask)
  const activeTaskId = useStore((s) => s.activeTask?.id)
  const [now, setNow] = useState(Date.now())
  // Downloads: a pane download used to be silently cancelled. Progress lives
  // in the header band (the one strip pages never paint over).
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [showDownloads, setShowDownloads] = useState(false)
  // The popover hangs below the header into pane territory (invariant 2).
  useOverlay(showDownloads && downloads.length > 0)

  useEffect(() => {
    void window.asit.panes.downloads().then(setDownloads)
    return window.asit.on(IPC.PANES_DOWNLOAD_EVENT, (...args: unknown[]) => {
      const d = args[0] as DownloadItem
      setDownloads((prev) => {
        const next = prev.filter((x) => x.id !== d.id)
        next.unshift(d)
        return next.slice(0, 20)
      })
      if (d.state === 'progressing') setShowDownloads(true)
    })
  }, [])

  const active = downloads.filter((d) => d.state === 'progressing')

  useEffect(() => {
    if (activity.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [activity.length])

  return (
    <div className="status-cluster">
      <CliHealth />
      {loadError && (
        <button
          className="status-load-error"
          title={`${loadError}. Your data is still on disk — this is a load failure, not data loss. Click to retry.`}
          onClick={() => void retryLoad()}
        >
          ⚠ {loadError} — retry
        </button>
      )}
      {downloads.length > 0 && (
        <button
          className="status-job"
          title={active.length ? `${active.length} downloading` : 'Downloads'}
          onClick={() => setShowDownloads((v) => !v)}
        >
          {active.length > 0 && <span className="working-dot" />}↓{' '}
          {active.length > 0 ? active.length : downloads.length}
        </button>
      )}
      {showDownloads && downloads.length > 0 && (
        <div className="downloads-popover">
          {downloads.map((d) => {
            const pct =
              d.totalBytes > 0 ? Math.round((100 * d.receivedBytes) / d.totalBytes) : 0
            return (
              <div
                key={d.id}
                className="download-row"
                title={d.savePath}
                onClick={() => window.asit.panes.showDownload(d.id)}
              >
                <span className="download-name">{d.filename}</span>
                {d.state === 'progressing' ? (
                  <div className="download-bar">
                    <div style={{ width: `${pct}%` }} />
                  </div>
                ) : null}
                <span className="download-meta">
                  {d.state === 'completed'
                    ? 'Done — click to show in folder'
                    : d.state === 'progressing'
                      ? `${pct}%`
                      : d.state}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <UpdatePill />
      <Dictation />
      {/* The only way to learn a keyboard is to be told it exists. One quiet
          button, always in the same place. */}
      <button
        className="shortcuts-hint"
        title="Keyboard shortcuts (Ctrl+/)"
        onClick={() => useStore.getState().setShortcutsOpen(true)}
      >
        ⌘
      </button>
      <SavePasswordPrompt />
      {notice && notice.kind !== 'error' && (
        <span className={`status-notice status-notice-${notice.kind}`} title={notice.text}>
          {notice.text}
        </span>
      )}
      {notice && notice.kind === 'error' && <ErrorNotice text={notice.text} />}
      {jobStatus && (
        <span className="status-job" title={jobStatus.label}>
          <span className="working-dot" />
          {jobStatus.queued > 0 ? `+${jobStatus.queued} queued` : 'Questions…'}
        </span>
      )}
      {activity.filter((a) => a.done).length > 1 && (
        // Two or more checkmarks means they are stacking faster than you are
        // clearing them. One button beats picking them off individually.
        <button
          className="status-activity status-activity-done status-clear-all"
          title="Clear all finished"
          onClick={() => void window.asit.activity.dismissFinished()}
        >
          Clear {activity.filter((a) => a.done).length} ✓
        </button>
      )}
      {activity.map((item) => (
        <button
          key={item.id}
          className={`status-activity ${item.done ? 'status-activity-done' : ''}`}
          // Native tooltip on purpose: an HTML popover would drop below the
          // header and be painted over by the pages.
          title={
            item.done
              ? `${item.label} — finished. Click to open that workspace and clear this.`
              : `${item.label} — ${item.detail ?? 'Working…'}${
                  item.taskId && item.taskId !== activeTaskId ? '\nClick to open' : ''
                }`
          }
          // A finished entry is a NOTIFICATION, so acting on it consumes it.
          // It used to sit in the header forever after you had already opened
          // the workspace, turning the row into a pile of stale badges.
          onClick={() => {
            if (item.taskId && item.taskId !== activeTaskId) openTask(item.taskId)
            if (item.done) void window.asit.activity.dismiss(item.id)
          }}
        >
          <span className="status-activity-label">
            {item.done ? '✓ ' : ''}
            {item.label}
          </span>
          <span className="status-activity-time">
            {item.done ? 'open ↗' : elapsed(item.startedAt, now)}
          </span>
          {item.done && (
            // Dismiss without opening — for the ones you only wanted to know
            // had finished.
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Dismiss ${item.label}`}
              title="Dismiss"
              className="status-activity-x"
              onClick={(e) => {
                e.stopPropagation()
                void window.asit.activity.dismiss(item.id)
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}
      {/* One assistant button, one panel (agent + quick scopes inside). */}
      <button
        className={`assistant-launcher ${assistantOpen ? 'active' : ''}`}
        title="Assistant (Ctrl+J agent · Ctrl+K quick)"
        onClick={() => setAssistantOpen(!assistantOpen)}
      > Ask
      </button>
    </div>
  )
}
