import { useEffect, useState } from 'react'
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
  const assistantOpen = useStore((s) => s.assistantOpen)
  const setAssistantOpen = useStore((s) => s.setAssistantOpen)
  const jarvisOpen = useStore((s) => s.jarvisOpen)
  const setJarvisOpen = useStore((s) => s.setJarvisOpen)
  const openTask = useStore((s) => s.openTask)
  const activeTaskId = useStore((s) => s.activeTask?.id)
  const [now, setNow] = useState(Date.now())

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
          className="status-activity"
          // Native tooltip on purpose: an HTML popover would drop below the
          // header and be painted over by the pages.
          title={`${item.label} — ${item.detail ?? 'Working…'}${
            item.taskId && item.taskId !== activeTaskId ? '\nClick to open' : ''
          }`}
          onClick={() => {
            if (item.taskId && item.taskId !== activeTaskId) openTask(item.taskId)
          }}
        >
          <span className="status-activity-label">{item.label}</span>
          <span className="status-activity-time">{elapsed(item.startedAt, now)}</span>
        </button>
      ))}
      <button
        className={`assistant-launcher ${assistantOpen ? 'active' : ''}`}
        title="Quick assistant (Ctrl+K)"
        onClick={() => setAssistantOpen(!assistantOpen)}
      >
        ⚡
      </button>
      <button
        className={`assistant-launcher ${jarvisOpen ? 'active' : ''}`}
        title="Jarvis — universal agent (Ctrl+J)"
        onClick={() => setJarvisOpen(!jarvisOpen)}
      >
        🤖
      </button>
    </div>
  )
}
