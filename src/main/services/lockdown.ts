import type { BrowserWindow } from 'electron'

// Strong-friction lockdown: fullscreen kiosk, always-on-top, focus re-grab.
// Deliberately NOT a hard kiosk: no keyboard hooks, no process killing.
// Alt+Tab escapes for ~a second before the window re-grabs focus; Ctrl+Alt+Del
// and Win+L are untouched by design. Lockdown state is never persisted, so a
// crash can never leave the machine locked.
class LockdownController {
  private win: BrowserWindow | null = null
  private engaged = false
  private strict = false // true during work phase; false (relaxed) during breaks
  private regrabTimer: NodeJS.Timeout | null = null

  private onBlur = (): void => {
    if (!this.engaged || !this.strict || this.regrabTimer) return
    // Throttled re-grab: avoids a CPU-spinning focus war and reduces Windows'
    // foreground-lock fallback (taskbar flash instead of focus).
    this.regrabTimer = setTimeout(() => {
      this.regrabTimer = null
      const win = this.win
      if (!win || win.isDestroyed() || !this.engaged || !this.strict) return
      win.show()
      win.moveTop()
      win.focus()
      // Windows sometimes silently drops the flag; re-assert.
      win.setAlwaysOnTop(true, 'screen-saver')
    }, 250)
  }

  private onClose = (e: Electron.Event): void => {
    if (this.engaged) e.preventDefault()
  }

  attach(win: BrowserWindow): void {
    this.win = win
    win.on('closed', () => {
      this.win = null
      this.engaged = false
    })
  }

  isEngaged(): boolean {
    return this.engaged
  }

  engage(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    this.engaged = true
    this.strict = true
    win.setKiosk(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setSkipTaskbar(true)
    win.setClosable(false)
    win.removeListener('blur', this.onBlur)
    win.on('blur', this.onBlur)
    win.removeListener('close', this.onClose)
    win.on('close', this.onClose)
    win.show()
    win.focus()
  }

  // Break phase: stay fullscreen but let the user switch apps freely.
  relax(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !this.engaged) return
    this.strict = false
    win.setAlwaysOnTop(false)
  }

  // Back to work phase.
  tighten(): void {
    const win = this.win
    if (!win || win.isDestroyed() || !this.engaged) return
    this.strict = true
    win.setAlwaysOnTop(true, 'screen-saver')
    win.show()
    win.focus()
  }

  disengage(): void {
    const win = this.win
    this.engaged = false
    this.strict = false
    if (this.regrabTimer) {
      clearTimeout(this.regrabTimer)
      this.regrabTimer = null
    }
    if (!win || win.isDestroyed()) return
    win.removeListener('blur', this.onBlur)
    win.removeListener('close', this.onClose)
    win.setKiosk(false)
    win.setAlwaysOnTop(false)
    win.setSkipTaskbar(false)
    win.setClosable(true)
  }
}

export const lockdown = new LockdownController()
