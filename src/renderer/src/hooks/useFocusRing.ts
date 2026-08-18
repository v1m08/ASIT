import { useEffect } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from '../store/useStore'
import { matchShortcut } from '@shared/shortcuts'

// Keyboard navigation ring.
//
// Tab / Shift+Tab do NOT walk the DOM — they move between a small ordered set
// of ZONES that actually matter (each open pane, the notes editor, the chat,
// the sidebar). Landing on a zone focuses its real control: the chat zone puts
// the caret in the chat box, a page zone focuses the embedded page itself.
//
// A zone is declared in markup:
//   data-focus-zone="Label"      the zone container (DOM order = ring order)
//   data-focus-pane="<paneId>"   zone is a WebContentsView; main focuses it
//   data-focus-target            the control to focus (else first focusable
//                                inside data-focus-body, else inside the zone)
//
// Panes swallow keystrokes, so main mirrors the same shortcuts into APP_EVENTs
// (see services/panes.ts) and they land back here.

const FOCUSABLE = [
  'textarea:not([tabindex="-1"])',
  'input:not([type=hidden]):not([tabindex="-1"])',
  'select:not([tabindex="-1"])',
  '[contenteditable="true"]',
  'button:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

let currentPaneId: string | null = null

function zones(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-zone]')].filter(
    (el) => el.getClientRects().length > 0
  )
}

function controlFor(zone: HTMLElement): HTMLElement {
  const explicit = zone.querySelector<HTMLElement>('[data-focus-target]')
  if (explicit) return explicit
  const body = zone.querySelector<HTMLElement>('[data-focus-body]') ?? zone
  const first = [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
    (el) => el.getClientRects().length > 0
  )
  if (first) return first
  if (!zone.hasAttribute('tabindex')) zone.setAttribute('tabindex', '-1')
  return zone
}

function mark(zone: HTMLElement | null): void {
  for (const el of document.querySelectorAll('[data-focus-active]'))
    el.removeAttribute('data-focus-active')
  zone?.setAttribute('data-focus-active', '')
}

function focusZone(zone: HTMLElement): void {
  const paneId = zone.dataset.focusPane
  mark(zone)
  if (paneId) {
    currentPaneId = paneId
    // Blur the DOM side first, or the page and an input both look focused.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    window.asit.panes.domFocus(false)
    window.asit.panes.focus(paneId)
    return
  }
  currentPaneId = null
  window.asit.panes.domFocus(true)
  const el = controlFor(zone)
  focusProgrammatically(el)
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select?.()
}

function currentIndex(list: HTMLElement[]): number {
  if (currentPaneId) {
    const i = list.findIndex((z) => z.dataset.focusPane === currentPaneId)
    if (i >= 0) return i
  }
  const active = document.activeElement as HTMLElement | null
  if (active && active !== document.body) {
    const i = list.findIndex((z) => z.contains(active))
    if (i >= 0) return i
  }
  return -1
}

function cycle(back: boolean): void {
  const list = zones()
  if (list.length === 0) return
  const i = currentIndex(list)
  const next = i === -1 ? (back ? list.length - 1 : 0) : (i + (back ? -1 : 1) + list.length) % list.length
  focusZone(list[next])
}

function jumpTo(index: number): void {
  const list = zones()
  if (list[index]) focusZone(list[index])
}

// Where Ctrl+K / Ctrl+L jumped from, so Escape can hand focus back.
let returnZone: HTMLElement | null = null
// True only while OUR focus() calls are landing — lets onFocusIn tell a
// user click apart from a programmatic jump.
let programmaticFocus = false

function focusProgrammatically(el: HTMLElement): void {
  programmaticFocus = true
  try {
    el.focus()
  } finally {
    setTimeout(() => {
      programmaticFocus = false
    }, 0)
  }
}

// Ctrl+K toggles: open with the cursor ready, or close and hand focus back
// to wherever the user was. (The panel may not be mounted yet when opening.)
function toggleAssistant(): void {
  const store = useStore.getState()
  if (store.assistantOpen) {
    store.setAssistantOpen(false)
    if (returnZone?.isConnected) focusZone(returnZone)
    returnZone = null
    return
  }
  returnZone = document.querySelector<HTMLElement>('[data-focus-active]')
  store.setAssistantOpen(true)
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLInputElement>('.assistant-panel input')
    el?.focus()
    el?.select()
  })
}

function toggleJarvis(): void {
  const store = useStore.getState()
  if (store.jarvisOpen) {
    store.setJarvisOpen(false)
    if (returnZone?.isConnected) focusZone(returnZone)
    returnZone = null
    return
  }
  returnZone = document.querySelector<HTMLElement>('[data-focus-active]')
  store.setJarvisOpen(true)
  requestAnimationFrame(() => {
    document.querySelector<HTMLInputElement>('.jarvis-panel input')?.focus()
  })
}

function focusSelector(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return
  // Always record where the jump came from — Escape hands focus back there.
  // (Recording only for zoneless targets left a STALE returnZone behind for
  // the address bar / chat box, so Escape jumped somewhere old.)
  returnZone = document.querySelector<HTMLElement>('[data-focus-active]')
  currentPaneId = null
  mark(el.closest<HTMLElement>('[data-focus-zone]'))
  focusProgrammatically(el)
  if (el instanceof HTMLInputElement) el.select()
}

export function installFocusRing(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const target = e.target instanceof HTMLElement ? e.target : null
    // Modals and small inline forms (new workspace, add to-do, save session)
    // keep native tab order — inside them Tab means "next field".
    if (target?.closest('.modal-backdrop, form')) return

    // Escape out of the assistant / address bar goes back where you came from.
    if (e.key === 'Escape' && (target?.closest('.assistant-bar') || target?.closest('.browser-toolbar'))) {
      if (returnZone?.isConnected) {
        focusZone(returnZone)
        returnZone = null
      }
      return
    }

    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      cycle(e.shiftKey)
      return
    }
    // Ctrl+1…9 jump to a panel.
    if (e.ctrlKey && !e.altKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault()
      jumpTo(Number(e.key) - 1)
      return
    }
    const hit = matchShortcut(e)
    if (hit) {
      e.preventDefault()
      runShortcut(hit.id)
    }
  }

  // THE dispatcher. Every shortcut — typed here, or replayed by main because a
  // page swallowed it — ends up in this one function, so the two paths can
  // never diverge again. Tab operations go to whichever screen registered
  // itself as the tab surface rather than to a hardcoded component.
  function runShortcut(id: string): void {
    const store = useStore.getState()
    const tabs = store.tabSurface
    switch (id) {
      case 'new-tab':
        return tabs?.newTab?.()
      case 'close-tab':
        return tabs?.closeTab?.()
      case 'reopen-tab':
        return tabs?.reopenTab?.()
      case 'next-tab':
        return tabs?.nextTab?.()
      case 'prev-tab':
        return tabs?.prevTab?.()
      case 'reload':
        return tabs?.reload?.()
      case 'back':
        return tabs?.back?.()
      case 'forward':
        return tabs?.forward?.()
      case 'find':
        return tabs?.find?.()
      case 'zoom-in':
        return tabs?.zoom?.(0.5)
      case 'zoom-out':
        return tabs?.zoom?.(-0.5)
      case 'zoom-reset':
        return tabs?.zoom?.(0)
      case 'focus-jarvis':
        return toggleJarvis()
      case 'focus-assistant':
        return toggleAssistant()
      case 'focus-address':
        return focusSelector('.browser-address')
      case 'focus-chat':
        return focusSelector('.chat-input-box textarea')
      case 'voice-toggle':
        return store.bumpVoice()
      case 'toggle-notes':
        return store.toggleScratchNotes()
      case 'open-settings':
        return store.setSettingsOpen(true)
      case 'toggle-chat':
        return store.toggleChat()
      case 'go-home':
        if (store.view === 'workspace') void window.asit.panes.park().then(() => store.goHome())
        return
      default:
        return
    }
  }

  // Clicking into something makes it the ring position, so the next Tab
  // continues from where the user actually is. A CLICK (as opposed to one of
  // our programmatic jumps) also invalidates any stored Escape-return target —
  // returning to a zone from three interactions ago is worse than not
  // returning at all.
  const onFocusIn = (e: FocusEvent): void => {
    if (!(e.target instanceof HTMLElement)) return
    const zone = e.target.closest<HTMLElement>('[data-focus-zone]')
    if (!zone) return
    if (!programmaticFocus) returnZone = null
    currentPaneId = null
    mark(zone)
  }

  // Panes swallow keys, so main replays the same shortcuts as app events.
  const offEvent = window.asit.on(IPC.APP_EVENT, (...args: unknown[]) => {
    const p = args[0] as { type: string; back?: boolean; index?: number; paneId?: string }
    if (p.type === 'pane-focused' && p.paneId) {
      // The user clicked into a page: move the ring there so the next Tab
      // continues from that pane, not from wherever the DOM was last focused.
      currentPaneId = p.paneId
      mark(document.querySelector<HTMLElement>(`[data-focus-pane="${CSS.escape(p.paneId)}"]`))
    } else if (p.type === 'cycle-focus') cycle(!!p.back)
    else if (p.type === 'focus-zone' && typeof p.index === 'number') jumpTo(p.index)
    else runShortcut(p.type)
  })

  // Clicking an embedded page blurs the whole renderer — that is main's cue to
  // grab the navigation keys at the OS level, because keys inside a page (or
  // its subframes, e.g. the PDF viewer) never reach us.
  const onWindowBlur = (): void => window.asit.panes.domFocus(false)
  const onWindowFocus = (): void => {
    currentPaneId = null
    window.asit.panes.domFocus(true)
  }

  window.addEventListener('keydown', onKey, true)
  window.addEventListener('focusin', onFocusIn)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  return () => {
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('focusin', onFocusIn)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('focus', onWindowFocus)
    offEvent()
  }
}

export function useFocusRing(): void {
  useEffect(() => installFocusRing(), [])
}
