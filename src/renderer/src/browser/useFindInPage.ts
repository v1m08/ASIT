import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'

// Find-in-page state machine, shared by every browsing surface. Owns the
// open/close state, the streamed match counts from main, and the two APP
// entry points: Ctrl+F replayed from a focused page, and "Find in page…"
// from the page context menu.

export interface FindState {
  /** Pane the find bar is targeting; null = closed. */
  findFor: string | null
  findText: string
  findResult: { activeMatch: number; matches: number } | null
  inputRef: React.RefObject<HTMLInputElement>
  openFind: (paneId: string) => void
  runFind: (text: string, findNext: boolean, forward?: boolean) => void
  closeFind: () => void
}

export function useFindInPage({
  ownsPane,
  activePaneId
}: {
  /** Does this surface own the pane an app event names? */
  ownsPane: (paneId: string) => boolean
  /** Target when an event arrives without a pane id (Ctrl+F in app chrome). */
  activePaneId: () => string | null
}): FindState {
  const [findFor, setFindFor] = useState<string | null>(null)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState<FindState['findResult']>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const findForRef = useRef<string | null>(null)
  findForRef.current = findFor

  const openFind = useCallback((paneId: string): void => {
    setFindFor(paneId)
    setTimeout(() => inputRef.current?.select(), 40)
  }, [])

  // Latest callbacks without re-subscribing the IPC listeners every render.
  const ownsRef = useRef(ownsPane)
  ownsRef.current = ownsPane
  const activeRef = useRef(activePaneId)
  activeRef.current = activePaneId

  useEffect(() => {
    const offFind = window.asit.on(IPC.PANES_FIND_RESULT, (...args: unknown[]) => {
      const r = args[0] as { paneId: string; activeMatch: number; matches: number }
      if (r.paneId !== findForRef.current) return
      setFindResult({ activeMatch: r.activeMatch, matches: r.matches })
    })
    const offApp = window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
      const e = args[0] as { type: string; paneId?: string }
      if (e.type !== 'find-in-page') return
      if (e.paneId && !ownsRef.current(e.paneId)) return
      const target = e.paneId ?? activeRef.current()
      if (target) {
        setFindFor(target)
        setTimeout(() => inputRef.current?.select(), 40)
      }
    })
    return () => {
      offFind()
      offApp()
    }
  }, [])

  const runFind = useCallback((text: string, findNext: boolean, forward = true): void => {
    const id = findForRef.current
    if (!id) return
    setFindText(text)
    if (!text) setFindResult(null)
    void window.asit.panes.find(id, text, forward, findNext)
  }, [])

  const closeFind = useCallback((): void => {
    const id = findForRef.current
    if (id) void window.asit.panes.findStop(id)
    setFindFor(null)
    setFindText('')
    setFindResult(null)
  }, [])

  return { findFor, findText, findResult, inputRef, openFind, runFind, closeFind }
}
