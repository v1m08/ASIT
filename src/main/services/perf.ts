import { monitorEventLoopDelay } from 'perf_hooks'
import type { WebContents } from 'electron'

// Opt-in load timing (ASIT_PERF=1). Logs, per pane load, how long each phase
// took plus how stalled the main process was meanwhile — main-process lag is
// the usual suspect for "a page loads slower here than in Chrome", since
// every request that hits a webRequest hook waits on it. Timings and hosts
// only; never page content or full urls.

export const PERF = process.env.ASIT_PERF === '1'

const loop = PERF ? monitorEventLoopDelay({ resolution: 10 }) : null
loop?.enable()

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 30)
  }
}

export function tracePane(paneId: string, wc: WebContents, t0 = Date.now()): void {
  if (!PERF || !loop) return
  let start = t0
  let marks: string[] = []
  const mark = (label: string): void => {
    marks.push(`${label}=${Date.now() - start}ms`)
  }
  wc.on('did-start-loading', () => {
    if (marks.length === 0 || marks[marks.length - 1].startsWith('stop')) {
      if (marks.length) start = Date.now()
      marks = [`queued=${start - t0}ms`]
      loop.reset()
    }
  })
  wc.on('did-start-navigation', (_e, _url, _inPage, isMain) => {
    if (isMain) mark('nav')
  })
  wc.on('did-navigate', () => mark('commit'))
  wc.on('dom-ready', () => mark('domready'))
  wc.on('did-stop-loading', async () => {
    mark('stop')
    let fcp = -1
    try {
      fcp = Math.round(
        (await wc.executeJavaScript(
          `(performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime||-1`
        )) as number
      )
    } catch {
      /* page gone */
    }
    const lagMax = Math.round(loop.max / 1e6)
    const lagMean = Math.round(loop.mean / 1e6)
    console.log(
      `[perf] ${paneId} ${host(wc.getURL())} ${marks.join(' ')} fcp=${fcp}ms mainLag(mean/max)=${lagMean}/${lagMax}ms`
    )
  })
}
