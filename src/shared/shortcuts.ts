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
  // Moving between the app's panels. This used to be Tab, which meant Tab
  // never reached the page you were looking at — you could not tab between
  // fields on a form, which is most of what Tab is FOR. F6 is what Windows
  // and Chrome already use to cycle UI regions, so Tab goes back to the
  // page and the app takes the key nobody was using.
  { id: 'cycle-zone', accel: 'F6', key: 'f6', label: 'Next panel' },
  {
    id: 'cycle-zone-back',
    accel: 'Shift+F6',
    key: 'f6',
    shift: true,
    label: 'Previous panel'
  },
  { id: 'open-history', accel: 'CommandOrControl+H', key: 'h', ctrl: true, label: 'History' },
  {
    id: 'open-palette',
    accel: 'CommandOrControl+Shift+P',
    key: 'p',
    ctrl: true,
    shift: true,
    label: 'Command palette'
  },
  // Ctrl+P is the muscle memory almost everyone already has for "find
  // anything". Two accelerators for one id is fine; two ids on one is not.
  { id: 'open-palette', accel: 'CommandOrControl+P', key: 'p', ctrl: true, label: '' },
  {
    id: 'open-shortcuts',
    accel: 'CommandOrControl+/',
    key: '/',
    ctrl: true,
    label: 'Keyboard shortcuts'
  },
  { id: 'zoom-in', accel: 'CommandOrControl+=', key: '=', ctrl: true, label: 'Zoom in' },
  { id: 'zoom-in', accel: 'CommandOrControl+Plus', key: '+', ctrl: true, label: '' },
  { id: 'zoom-out', accel: 'CommandOrControl+-', key: '-', ctrl: true, label: 'Zoom out' },
  { id: 'zoom-reset', accel: 'CommandOrControl+0', key: '0', ctrl: true, label: 'Reset zoom' },

  // --- app panels
  { id: 'focus-jarvis', accel: 'CommandOrControl+J', key: 'j', ctrl: true, label: 'Assistant' },
  // Bound late: this had a dispatcher case and three README mentions but
  // no entry here, so the key genuinely did nothing. The cheat sheet is
  // what surfaced it — a list you can read is also a list you can audit.
  {
    id: 'focus-assistant',
    accel: 'CommandOrControl+K',
    key: 'k',
    ctrl: true,
    label: 'Quick assistant'
  },
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
  // Ctrl+H is history in every browser, so home moved off it. Two accelerators
  // for one id is fine (see reload/F5); two ids on ONE accelerator is not —
  // matchShortcut returns the first, and the loser silently stops working.
  { id: 'go-home', accel: 'Alt+Home', key: 'home', alt: true, label: 'Back to home' },
  {
    id: 'go-home',
    accel: 'CommandOrControl+Shift+H',
    key: 'h',
    ctrl: true,
    shift: true,
    label: ''
  },
  { id: 'open-settings', accel: 'CommandOrControl+,', key: ',', ctrl: true, label: 'Settings' },
  {
    id: 'open-automations',
    accel: 'CommandOrControl+Shift+A',
    key: 'a',
    ctrl: true,
    shift: true,
    label: 'Automations (workflows & schedules)'
  },

  // --- doing things that used to need the mouse
  // Ctrl+D is "bookmark this" everywhere — a real, global bookmark since the
  // bookmarks store landed. Pinning to a workspace rail stays as the ⌾
  // button and tab menu; it's the workspace-scoped cousin.
  {
    id: 'bookmark-page',
    accel: 'CommandOrControl+D',
    key: 'd',
    ctrl: true,
    label: 'Bookmark this page'
  },
  {
    id: 'copy-address',
    accel: 'CommandOrControl+Shift+C',
    key: 'c',
    ctrl: true,
    shift: true,
    label: 'Copy page address'
  },
  {
    id: 'add-file',
    accel: 'CommandOrControl+O',
    key: 'o',
    ctrl: true,
    label: 'Add a PDF or file'
  },
  {
    id: 'toggle-split',
    accel: 'CommandOrControl+\\',
    key: '\\',
    ctrl: true,
    label: 'Split / unsplit'
  },
  {
    id: 'toggle-direction',
    accel: 'CommandOrControl+Shift+\\',
    key: '\\',
    ctrl: true,
    shift: true,
    label: 'Split sideways / stacked'
  },
  {
    id: 'toggle-focus',
    accel: 'CommandOrControl+Shift+F',
    key: 'f',
    ctrl: true,
    shift: true,
    label: 'Start / end a focus session'
  },
  {
    id: 'focus-todo',
    accel: 'CommandOrControl+Shift+D',
    key: 'd',
    ctrl: true,
    shift: true,
    label: 'Add a to-do'
  },
  {
    id: 'dictate-toggle',
    accel: 'CommandOrControl+Shift+Space',
    key: ' ',
    ctrl: true,
    shift: true,
    label: 'Dictate into the focused field'
  },
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
/**
 * Accelerators claimed by more than one action. Two entries for one id is
 * intentional (Ctrl+R and F5 both reload); two DIFFERENT ids on one key means
 * one of them silently does nothing. Asserted by the smoke test.
 */
/**
 * How the cheat sheet is laid out — by what you are DOING, not by which
 * modifier a key happens to use.
 *
 * It lives here rather than in the modal so `ungroupedShortcuts()` can prove
 * every labelled action is listed. A shortcut missing from the sheet is a
 * shortcut nobody will find, which is the same as not having it.
 */
export const SHORTCUT_GROUPS: { title: string; ids: string[] }[] = [
  {
    title: 'Find anything',
    ids: ['open-palette', 'open-history', 'focus-address', 'find', 'open-shortcuts']
  },
  {
    title: 'Tabs & pages',
    ids: [
      'new-tab',
      'close-tab',
      'reopen-tab',
      'next-tab',
      'prev-tab',
      'reload',
      'back',
      'forward',
      'zoom-in',
      'zoom-out',
      'zoom-reset'
    ]
  },
  {
    title: 'This workspace',
    ids: [
      'bookmark-page',
      'copy-address',
      'add-file',
      'toggle-split',
      'toggle-direction',
      'toggle-chat',
      'toggle-notes',
      'focus-todo',
      'toggle-focus'
    ]
  },
  {
    title: 'Assistant & voice',
    ids: ['focus-jarvis', 'focus-assistant', 'voice-toggle', 'dictate-toggle']
  },
  {
    title: 'Getting around',
    ids: ['cycle-zone', 'cycle-zone-back', 'focus-zone', 'go-home', 'open-settings', 'open-automations']
  }
]

/** Labelled actions the cheat sheet would not show. Asserted by the smoke. */
export function ungroupedShortcuts(): string[] {
  const grouped = new Set(SHORTCUT_GROUPS.flatMap((g) => g.ids))
  const labelled = new Set(SHORTCUTS.filter((s) => s.label).map((s) => s.id))
  return [...labelled].filter((id) => !grouped.has(id))
}

export function conflictingAccelerators(): string[] {
  const byAccel = new Map<string, Set<string>>()
  const seenPairs = new Set<string>()
  const bad: string[] = []
  for (const s of SHORTCUTS) {
    // An exact repeat of the same (id, accel) is a merge accident. Harmless
    // to press, but it registers the accelerator twice and shows up twice in
    // every list built from this table — and it is how a real conflict hides.
    const pair = `${s.id}\u0000${s.accel}`
    if (seenPairs.has(pair)) bad.push(`${s.accel} (duplicated entry)`)
    seenPairs.add(pair)
    if (!byAccel.has(s.accel)) byAccel.set(s.accel, new Set())
    byAccel.get(s.accel)!.add(s.id)
  }
  for (const [accel, ids] of byAccel) if (ids.size > 1) bad.push(accel)
  return bad
}

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
