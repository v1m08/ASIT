import { lazy, Suspense } from 'react'
import type { Resource, Task } from '@shared/types'

// CodeMirror (+ live preview) loads on first notes open, not at startup.
const Impl = lazy(() => import('./NotesEditorImpl'))

export default function NotesEditor(props: {
  filePath: string
  task?: Task
  resources?: Resource[]
}): JSX.Element {
  return (
    <Suspense fallback={<div className="notes-editor-wrap" />}>
      <Impl {...props} />
    </Suspense>
  )
}
