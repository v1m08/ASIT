import { useCallback, useRef, useState } from 'react'

// Drag a file out of Explorer and drop it on the thing it belongs to.
//
// ONE hook for every drop target in the app, because a drop zone is four
// handlers that all have to agree, and hand-rolling that per component is how
// you end up with three fields that each accept files slightly differently.
//
// Two non-obvious pieces:
//  * dragenter/dragleave fire for every child element the cursor crosses, so
//    a naive boolean flickers the highlight off the moment you move over the
//    zone's own contents. Counting enter/leave pairs is the fix.
//  * a dropped File's path is not readable from the renderer — Electron 32
//    removed File.path — so it comes from webUtils via the preload bridge.

export interface FileDrop {
  /** True while a file is over this zone; spread onto className for styling. */
  over: boolean
  handlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

/** Does this drag carry OS files (rather than an in-app item being moved)? */
function carriesFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types ?? []).includes('Files')
}

export function useFileDrop(
  onFiles: (paths: string[]) => void,
  options: { accept?: (name: string) => boolean; disabled?: boolean } = {}
): FileDrop {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const { accept, disabled } = options

  const reset = useCallback(() => {
    depth.current = 0
    setOver(false)
  }, [])

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current += 1
      setOver(true)
    },
    [disabled]
  )

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !carriesFiles(e)) return
      // Both preventDefault AND stopPropagation: without the first the drop
      // never fires, without the second the window-level guard claims it.
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    },
    [disabled]
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current -= 1
      if (depth.current <= 0) reset()
    },
    [disabled, reset]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      reset()
      const paths = Array.from(e.dataTransfer.files ?? [])
        .map((f) => ({ name: f.name, path: window.asit.files.pathFor(f) }))
        .filter((f) => f.path && (!accept || accept(f.name)))
        .map((f) => f.path)
      if (paths.length > 0) onFiles(paths)
    },
    [disabled, accept, onFiles, reset]
  )

  return { over, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

/**
 * Anything dropped OUTSIDE a real target would otherwise make the window
 * navigate to the file, replacing the whole app with a PDF viewer and no way
 * back. Installed once, at the top.
 */
export function useFileDropGuard(): void {
  const install = useRef(false)
  if (!install.current) {
    install.current = true
    const swallow = (e: DragEvent): void => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
  }
}
