import { useEffect, useState } from 'react'
import ActivityGraph from '../components/ActivityGraph'
import ReviewCards from '../components/ReviewCards'
import { useOverlay } from '../hooks/useOverlay'
import { useStore } from '../store/useStore'
import { fmtCost } from '../utils/fmt'

// The numbers, and the two things you do with them.
//
// Focus time, AI spend, the activity graph and the recall queue all used to
// live on the home screen; retiring it would have taken them out of the app
// entirely. They are a footer here rather than a panel because that is their
// weight — worth seeing, never worth a click to dismiss.

function fmtHours(sec: number): string {
  if (sec < 60) return '0m'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function Overlay({
  children,
  onClose
}: {
  children: JSX.Element
  onClose: () => void
}): JSX.Element {
  // Panes paint above ALL renderer DOM (invariant 2) — hide them first.
  useOverlay(true)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card activity-modal" onClick={(e) => e.stopPropagation()}>
        {children}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export default function NtpStats(): JSX.Element | null {
  const [focus, setFocus] = useState<{ today: number; week: number } | null>(null)
  const [due, setDue] = useState(0)
  const [cost, setCost] = useState<number | null>(null)
  const [show, setShow] = useState<'activity' | 'review' | null>(null)
  const studyEnabled = useStore((s) => s.settings?.studyEnabled ?? true)

  useEffect(() => {
    void window.asit.tasks.stats().then((s) => {
      setFocus({ today: s.focusSecToday, week: s.focusSecWeek })
      setDue(Object.values(s.dueByTask).reduce((a, b) => a + b, 0))
    })
    void window.asit.usage
      .summary()
      .then((u) => setCost(u.week.costUsd))
      // Usage is a nicety; a failure here must not blank the dashboard.
      .catch(() => setCost(null))
  }, [])

  if (!focus) return null

  return (
    <>
      <div className="ntp-stats">
        {studyEnabled && (
          <span>
            Focused <b>{fmtHours(focus.today)}</b> today · {fmtHours(focus.week)} this week
          </span>
        )}
        {cost !== null && (
          <span>
            AI this week <b>{fmtCost(cost)}</b>
          </span>
        )}
        <button className="ntp-manage" onClick={() => setShow('activity')}>
          Activity →
        </button>
        {studyEnabled && due > 0 && (
          <button className="ntp-manage" onClick={() => setShow('review')}>
            {due} to recall →
          </button>
        )}
      </div>
      {show === 'activity' && (
        <Overlay onClose={() => setShow(null)}>
          <ActivityGraph />
        </Overlay>
      )}
      {show === 'review' && (
        <Overlay onClose={() => setShow(null)}>
          <ReviewCards onDone={() => setShow(null)} />
        </Overlay>
      )}
    </>
  )
}
