import { useEffect, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { UpdateStatus } from '@shared/types'

// "Update ready — restart" and nothing else.
//
// Updates download quietly in the background; this appears only once one is on
// disk and waiting. It deliberately does not show "checking…", a progress bar,
// or an error when you are offline — none of that is information you can act
// on, and a header full of status nobody reads is how the last set of badges
// ended up being ignored.

export default function UpdatePill(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    void window.asit.updates.status().then(setStatus)
    return window.asit.on(IPC.UPDATE_STATUS, (...args: unknown[]) =>
      setStatus(args[0] as UpdateStatus)
    )
  }, [])

  if (!status?.downloaded) return null

  return (
    <button
      className="update-pill"
      title={`Version ${status.downloaded} is downloaded. Restart to use it.`}
      disabled={restarting}
      onClick={() => {
        setRestarting(true)
        void window.asit.updates.install()
      }}
    >
      {restarting ? 'Restarting…' : `Update ready — restart`}
    </button>
  )
}
