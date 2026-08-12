import { useEffect } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore, type ActivityItem } from '../store/useStore'

// One subscriber for all background status, writing to the store. The header
// cluster on each screen renders it — mounting the listener there instead would
// reset a running job's state every time you navigate.
export default function StatusListener(): null {
  useEffect(() => {
    const { setActivity, setJobStatus, pushNotice } = useStore.getState()

    window.asit.activity.list().then((items) => setActivity(items as ActivityItem[]))
    const offActivity = window.asit.on(IPC.ACTIVITY_UPDATED, (...args: unknown[]) => {
      setActivity(args[0] as ActivityItem[])
    })

    const offApp = window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const p = args[0] as { type: string; text?: string }
      if (p.type === 'toast' && p.text) pushNotice(p.text, 'ok')
    })

    let active = 0
    let label = ''
    const offJobs = window.asit.on(IPC.JOBS_STATUS, (...args: unknown[]) => {
      const p = args[0] as {
        status: string
        title?: string
        count?: number
        error?: string
        mode?: string
      }
      const extracting = p.mode === 'extract'
      const verb = extracting ? 'Extracting' : 'Generating'
      if (p.status === 'queued') {
        active += 1
        label = `Queued: questions from “${p.title || 'document'}”`
      } else if (p.status === 'started') {
        active = Math.max(1, active) // jobs resumed after a restart never push 'queued'
        label = `${verb} questions from “${p.title}”…`
        pushNotice(label, 'info')
      } else if (p.status === 'done' || p.status === 'failed') {
        active = Math.max(0, active - 1)
        if (p.status === 'done')
          pushNotice(`${p.count} questions ${extracting ? 'extracted' : 'ready'} ✓`, 'ok')
        else
          pushNotice(
            `Question ${extracting ? 'extraction' : 'generation'} failed: ${p.error}`,
            'error'
          )
      }
      setJobStatus(active > 0 ? { label, queued: active - 1 } : null)
    })

    return () => {
      offActivity()
      offApp()
      offJobs()
    }
  }, [])

  return null
}
