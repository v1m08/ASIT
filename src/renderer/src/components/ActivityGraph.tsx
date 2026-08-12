import { useEffect, useState } from 'react'
import { fmtCost } from '../utils/fmt'

interface ActivityDay {
  date: string
  focusSec: number
  costUsd: number
  chats: number
}

function fmtDur(sec: number): string {
  if (sec === 0) return 'no focus time'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m focused` : `${m}m focused`
}

function niceDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

// Sequential ramp: one hue (app accent) light→dark against the dark surface.
function focusLevel(sec: number): number {
  if (sec === 0) return 0
  if (sec < 15 * 60) return 1
  if (sec < 45 * 60) return 2
  if (sec < 90 * 60) return 3
  return 4
}

export default function ActivityGraph(): JSX.Element | null {
  const [days, setDays] = useState<ActivityDay[]>([])

  useEffect(() => {
    window.asit.usage.activity().then(setDays)
  }, [])

  if (days.length === 0) return null
  const anyActivity = days.some((d) => d.focusSec > 0 || d.costUsd > 0)
  if (!anyActivity) return null

  // --- heatmap: GitHub-style week columns, Monday-first ---
  const firstDow = (new Date(days[0].date + 'T12:00:00').getDay() + 6) % 7
  const cells: (ActivityDay | null)[] = [...Array(firstDow).fill(null), ...days]
  const weeks: (ActivityDay | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  // --- cost bars: last 30 days, single series ---
  const last30 = days.slice(-30)
  const maxCost = Math.max(...last30.map((d) => d.costUsd), 0.01)
  const totalCost30 = last30.reduce((s, d) => s + d.costUsd, 0)

  return (
    <section className="activity">
      <h2>Focus activity</h2>
      <div className="heatmap" role="img" aria-label="Daily focused time, last 20 weeks">
        {weeks.map((week, wi) => (
          <div key={wi} className="heatmap-col">
            {week.map((day, di) =>
              day ? (
                <div
                  key={day.date}
                  className={`heatmap-cell level-${focusLevel(day.focusSec)}`}
                  title={`${niceDate(day.date)} · ${fmtDur(day.focusSec)}`}
                />
              ) : (
                <div key={`pad-${di}`} className="heatmap-cell heatmap-pad" />
              )
            )}
          </div>
        ))}
      </div>
      <div className="heatmap-legend">
        <span>less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <div key={l} className={`heatmap-cell level-${l}`} />
        ))}
        <span>more</span>
      </div>

      <h2 className="activity-cost-title">
        AI usage — last 30 days <span className="activity-total">{fmtCost(totalCost30)}</span>
      </h2>
      <div className="cost-chart" role="img" aria-label="Daily AI cost, last 30 days">
        {last30.map((d) => (
          <div
            key={d.date}
            className="cost-bar-slot"
            title={`${niceDate(d.date)} · ${fmtCost(d.costUsd)} · ${d.chats} chat${d.chats === 1 ? '' : 's'}`}
          >
            <div
              className="cost-bar"
              style={{ height: `${Math.max(d.costUsd > 0 ? 6 : 0, (d.costUsd / maxCost) * 100)}%` }}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
