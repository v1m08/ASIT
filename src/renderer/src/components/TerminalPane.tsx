import { lazy, Suspense } from 'react'
import type { Task } from '@shared/types'

// xterm loads on first terminal open, not at startup.
const Impl = lazy(() => import('./TerminalPaneImpl'))

export default function TerminalPane({ task }: { task: Task }): JSX.Element {
  return (
    <Suspense fallback={<div className="terminal-pane" />}>
      <Impl task={task} />
    </Suspense>
  )
}
