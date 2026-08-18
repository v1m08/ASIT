// THE shortcut table. Single source of truth for both halves of the app.
//
// Keys have to work in two very different situations:
//   * the app's own DOM has focus  → a normal keydown in the renderer
//   * an embedded web page has focus → the page swallows the key, so main
//     grabs it with globalShortcut and replays it as an app event
//
// Those used to be two hand-maintained lists, and they drifted: the browser
// keys (Ctrl+T/W/R/F, zoom, tab cycling) were only ever added to the main-side
// list, so they did nothing whenever you were focused in ASIT's own UI —
// which is most of the time. Both sides now derive from this array, so a
// shortcut cannot exist in one and not the other.

export interface ShortcutDef {
  /** Also the app-event type main sends when a page ate the key. */
  id: string
  /** Electron accelerator, for globalShortcut registration in main. */
  accel: string
  /** Matcher against a renderer KeyboardEvent. */
  key: string // lowercase e.key, or 'space'/'tab'/'f5'
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  /** Shown in Settings. Empty = hidden from the reference list. */
  label: string
}

export const SHORTCUTS: ShortcutDef[] = [
  // --- tabs (whichever surface owns them: workspace panes or the scratchpad)
  { id: 'new-tab', accel: 'CommandOrControl+T', key: 't', ctrl: true, label: 'New tab' },
  { id: 'close-tab', accel: 'CommandOrControl+W', key: 'w', ctrl: true, label: 'Close tab' },
  {
    id: 'reopen-tab',
    accel: 'CommandOrControl+Shift+T',
    key: 't',
    ctrl: true,
    shift: true,
    label: 'Reopen closed tab'
  },
  { id: 'next-tab', accel: 'Control+Tab', key: 'tab', ctrl: true, label: 'Next tab' },
  {
    id: 'prev-tab',
    accel: 'Control+Shift+Tab',
    key: 'tab',
    ctrl: true,
    shift: true,
    label: 'Previous tab'
  },

  // --- page navigation
  { id: 'reload', accel: 'CommandOrControl+R', key: 'r', ctrl: true, label: 'Reload' },
  { id: 'reload', accel: 'F5', key: 'f5', label: '' },
  { id: 'back', accel: 'Alt+Left', key: 'arrowleft', alt: true, label: 'Back' },
  { id: 'forward', accel: 'Alt+Right', key: 'arrowright', alt: true, label: 'Forward' },
  { id: 'find', accel: 'CommandOrControl+F', key: 'f', ctrl: true, label: 'Find in page' },
  { id: 'open-history', accel: 'CommandOrControl+H', key: 'h', ctrl: true, label: 'History' },
  { id: 'zoom-in', accel: 'CommandOrControl+=', key: '=', ctrl: true, label: 'Zoom in' },
  { id: 'zoom-in', accel: 'CommandOrControl+Plus', key: '+', ctrl: true, label: '' },
  { id: 'zoom-out', accel: 'CommandOrControl+-', key: '-', ctrl: true, label: 'Zoom out' },
  { id: 'zoom-reset', accel: 'CommandOrControl+0', key: '0', ctrl: true, label: 'Reset zoom' },

  // --- app panels
  { id: 'focus-jarvis', accel: 'CommandOrControl+J', key: 'j', ctrl: true, label: 'Assistant' },
  { id: 'focus-address', accel: 'CommandOrControl+L', key: 'l', ctrl: true, label: 'Address bar' },
  { id: 'toggle-chat', accel: 'CommandOrControl+B', key: 'b', ctrl: true, label: 'Show / hide chat' },
  {
    id: 'toggle-notes',
    accel: 'CommandOrControl+Shift+E',
    key: 'e',
    ctrl: true,
    shift: true,
    label: 'Show / hide notes'
  },
  { id: 'go-home', accel: 'CommandOrControl+H', key: 'h', ctrl: true, label: 'Back to home' },
  { id: 'open-settings', accel: 'CommandOrControl+,', key: ',', ctrl: true, label: 'Settings' },
  {
    id: 'voice-toggle',
    accel: 'CommandOrControl+Space',
    key: ' ',
    ctrl: true,
    label: 'Talk to the assistant'
  }
]

/** Ctrl+1…9 jump to a panel; generated rather than listed nine times. */
export const ZONE_ACCELERATORS = Array.from({ length: 9 }, (_, i) => ({
  id: 'focus-zone',
  accel: `CommandOrControl+${i + 1}`,
  index: i
}))

/** Does this renderer keydown match a shortcut? */
export function matchShortcut(e: {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}): ShortcutDef | null {
  const key = e.key.toLowerCase()
  for (const def of SHORTCUTS) {
    if (def.key !== key) continue
    if (!!def.ctrl !== (e.ctrlKey || e.metaKey)) continue
    // Shift must match exactly, or Ctrl+Shift+T would also fire Ctrl+T.
    if (!!def.shift !== e.shiftKey) continue
    if (!!def.alt !== e.altKey) continue
    return def
  }
  return null
}
