import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'

// Hosts a real native window (Emacs, Excel, a game — anything with a window)
// inside the slot. The window itself is drawn by Windows, not by us: this
// component only reserves the rectangle and tells main where to put it.

interface AppWindow {
  handle: string
  title: string
}

export default function AppWindowPane({ task }: { task: Task }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [windows, setWindows] = useState<AppWindow[]>([])
  const [embedded, setEmbedded] = useState<AppWindow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setWindows(await window.asit.appwin.list())
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Keep the native window glued to this rectangle.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !embedded) return
    const report = (): void => {
      const r = host.getBoundingClientRect()
      void window.asit.appwin.bounds(embedded.handle, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(host)
    window.addEventListener('resize', report)
    const t = setInterval(report, 500) // catches scrolls/layout the observer misses
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      clearInterval(t)
    }
  }, [embedded])

  // A native child window paints over ALL app UI, so it must go away the
  // moment this pane is unmounted (tab switch, leaving the workspace).
  useEffect(() => {
    if (!embedded) return
    void window.asit.appwin.visible(embedded.handle, true)
    return () => {
      void window.asit.appwin.visible(embedded.handle, false)
    }
  }, [embedded])

  async function embed(w: AppWindow): Promise<void> {
    const err = await window.asit.appwin.embed(w.handle, task.id)
    if (err) {
      setError(err)
      return
    }
    setError(null)
    setEmbedded(w)
  }

  async function release(): Promise<void> {
    if (!embedded) return
    await window.asit.appwin.release(embedded.handle)
    setEmbedded(null)
    void refresh()
  }

  return (
    <div className="appwin-pane">
      <div className="terminal-bar">
        {embedded ? (
          <>
            <span className="terminal-cwd" title={embedded.title}>
              🪟 {embedded.title}
            </span>
            <span className="terminal-ai-badge terminal-ai-off" title="A native window has no page content, so the assistant can only see its title — not what's inside.">
              🔒 AI sees title only
            </span>
            <button className="rail-btn rail-toggle" title="Give the window back to the desktop" onClick={release}>
              ⏏
            </button>
          </>
        ) : (
          <>
            <span className="terminal-cwd">Pick a running app to embed</span>
            <button className="rail-btn rail-toggle" title="Refresh list" onClick={() => void refresh()}>
              ⟳
            </button>
          </>
        )}
      </div>

      {error && <p className="terminal-error">{error}</p>}

      {!embedded && (
        <div className="appwin-picker">
          {loading && <p className="slot-empty-hint">Looking for open windows…</p>}
          {!loading && windows.length === 0 && (
            <p className="slot-empty-hint">
              No embeddable windows found. Open the app first (Emacs, a file manager, anything with
              a normal window), then hit ⟳.
            </p>
          )}
          {windows.map((w) => (
            <button key={w.handle} className="appwin-row" onClick={() => void embed(w)}>
              🪟 <span className="appwin-title">{w.title}</span>
            </button>
          ))}
          <p className="slot-empty-hint appwin-note">
            The window is moved into this slot, not copied. Its menus and dialogs still open as
            separate windows, and closing ASIT hands it back to the desktop.
          </p>
        </div>
      )}

      {/* The native window is positioned over this box by the OS. */}
      <div className="appwin-host" ref={hostRef} style={{ display: embedded ? 'block' : 'none' }} />
    </div>
  )
}
