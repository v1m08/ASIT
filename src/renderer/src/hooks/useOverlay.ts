import { useEffect } from 'react'

// WebContentsViews paint ABOVE the renderer DOM. Any overlay (modal, lockdown
// screen, review cards) must hide all views while open or it will be covered.
// This hook is the single sanctioned way to do that.
export function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return
    window.asit.panes.setVisible(null, false)
    return () => {
      window.asit.panes.setVisible(null, true)
    }
  }, [open])
}
