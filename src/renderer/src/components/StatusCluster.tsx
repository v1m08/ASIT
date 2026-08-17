import { useEffect, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { DownloadItem } from '@shared/types'
import { useStore } from '../store/useStore'

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

export default function StatusCluster(): JSX.Element {
  const activity = useStore((s) => s.activity)
  const jobStatus = useStore((s) => s.jobStatus)
  const notice = useStore((s) => s.notice)
  const loadError = useStore((s) => s.loadError)
  const retryLoad = useStore((s) => s.retryLoad)
  const jarvisOpen = useStore((s) => s.jarvisOpen)
  const setJarvisOpen = useStore((s) => s.setJarvisOpen)
  const openTask = useStore((s) => s.openTask)
  const activeTaskId = useStore((s) => s.activeTask?.id)
  const [now, setNow] = useState(Date.now())
  // Downloads: a pane download used to be silently cancelled. Progress lives
  // in the header band (the one strip pages never paint over).
  const [downloads, setDownloads] = useState<DownloadItem[]>([])
  const [showDownloads, setShowDownloads] = useState(false)

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
      {notice && (
        <span className={`status-notice status-notice-${notice.kind}`} title={notice.text}>
          {notice.text}
        </span>
      )}
      {jobStatus && (
        <span className="status-job" title={jobStatus.label}>
          <span className="working-dot" />
          {jobStatus.queued > 0 ? `+${jobStatus.queued} queued` : 'Questions…'}
        </span>
      )}
      {activity.map((item) => (
        <button
          key={item.id}
          className={`status-activity ${item.done ? 'status-activity-done' : ''}`}
          // Native tooltip on purpose: an HTML popover would drop below the
          // header and be painted over by the pages.
          title={
            item.done
              ? `${item.label} — finished. Click to open that workspace.`
              : `${item.label} — ${item.detail ?? 'Working…'}${
                  item.taskId && item.taskId !== activeTaskId ? '\nClick to open' : ''
                }`
          }
          onClick={() => {
            if (item.taskId && item.taskId !== activeTaskId) openTask(item.taskId)
          }}
        >
          <span className="status-activity-label">
            {item.done ? '✓ ' : ''}
            {item.label}
          </span>
          <span className="status-activity-time">
            {item.done ? 'open ↗' : elapsed(item.startedAt, now)}
          </span>
        </button>
      ))}
      {/* One assistant button. Jarvis does everything the quick bar did — the
           launcher was a second door to a subset of the same thing. */}
      <button
        className={`assistant-launcher ${jarvisOpen ? 'active' : ''}`}
        title="Assistant (Ctrl+J)"
        onClick={() => setJarvisOpen(!jarvisOpen)}
      > Ask
      </button>
    </div>
  )
}
