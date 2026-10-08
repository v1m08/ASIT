import { BrowserWindow, screen, shell, systemPreferences } from 'electron'
import type { AppWindow, AppWindowStatus } from './appwindows'

// macOS half of app-window embedding: "follow mode".
//
// macOS has no SetParent — another process's window can never become a child
// of ours. So instead the REAL window stays a normal top-level window and is
// kept positioned exactly over the slot's rectangle through the Accessibility
// API (AXPosition/AXSize), following ASIT's window as it moves and resizes.
// When the slot isn't on screen (tab switch, an overlay, ASIT minimised) the
// window is parked in the screen's bottom-right corner — the same trick tiling
// window managers use, with no minimise animation — and on release it goes
// back exactly where it was, at its original size.
//
// Honest limits, stated in the UI too:
//   * It's a separate window, so when ASIT itself is clicked to the front it
//     can sit BEHIND ASIT; the slot offers "bring it forward".
//   * Needs Accessibility permission (the OS prompt is user-triggered).
//     Titles come from AX, so Screen Recording is NOT needed.
//   * The AI cannot read it — moving pixels creates no context (invariant 17).
// Nothing here is agent-reachable: callers are user-driven IPC only.

/* eslint-disable @typescript-eslint/no-explicit-any */
let koffi: any = null
let fn: Record<string, any> | null = null
let loadFailed = false
let kTrue: bigint | null = null
let kFalse: bigint | null = null

const UTF8 = 0x08000100
const kCFNumberSInt64Type = 4
const kAXValueCGPointType = 1
const kAXValueCGSizeType = 2
const kCGWindowListOptionAll = 0
const kCGWindowListExcludeDesktopElements = 16

const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

function load(): boolean {
  if (process.platform !== 'darwin') return false
  if (fn) return true
  if (loadFailed) return false
  try {
    // Lazily, so a machine where koffi won't load still runs everything else.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffi = require('koffi')
    const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    const AS = koffi.load(
      '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
    )
    // CGPoint and CGSize are both two doubles; one struct serves both.
    koffi.struct('AsitCGPair', { a: 'double', b: 'double' })
    const Rect = koffi.struct('AsitCGRect', { x: 'double', y: 'double', w: 'double', h: 'double' })
    const f: Record<string, any> = {
      CFStringCreateWithCString: CF.func(
        'void* CFStringCreateWithCString(void* alloc, const char* s, uint32_t enc)'
      ),
      CFStringGetCString: CF.func(
        'bool CFStringGetCString(void* s, _Out_ uint8_t* buf, long size, uint32_t enc)'
      ),
      CFNumberGetValue: CF.func('bool CFNumberGetValue(void* n, long type, _Out_ int64_t* out)'),
      CFArrayGetCount: CF.func('long CFArrayGetCount(void* a)'),
      CFArrayGetValueAtIndex: CF.func('void* CFArrayGetValueAtIndex(void* a, long i)'),
      CFDictionaryGetValue: CF.func('void* CFDictionaryGetValue(void* d, void* k)'),
      CFGetTypeID: CF.func('unsigned long CFGetTypeID(void* x)'),
      CFStringGetTypeID: CF.func('unsigned long CFStringGetTypeID()'),
      CFBooleanGetValue: CF.func('bool CFBooleanGetValue(void* b)'),
      CFRetain: CF.func('void* CFRetain(void* x)'),
      CFRelease: CF.func('void CFRelease(void* x)'),
      CGWindowListCopyWindowInfo: CG.func('void* CGWindowListCopyWindowInfo(uint32_t opt, uint32_t rel)'),
      CGRectMakeWithDictionaryRepresentation: CG.func(
        'bool CGRectMakeWithDictionaryRepresentation(void* d, _Out_ AsitCGRect* r)'
      ),
      AXUIElementCreateApplication: AS.func('void* AXUIElementCreateApplication(int pid)'),
      AXUIElementCreateSystemWide: AS.func('void* AXUIElementCreateSystemWide()'),
      AXUIElementSetMessagingTimeout: AS.func('int AXUIElementSetMessagingTimeout(void* el, float t)'),
      AXUIElementCopyAttributeValue: AS.func(
        'int AXUIElementCopyAttributeValue(void* el, void* attr, _Out_ void** out)'
      ),
      AXUIElementSetAttributeValue: AS.func(
        'int AXUIElementSetAttributeValue(void* el, void* attr, void* value)'
      ),
      AXUIElementPerformAction: AS.func('int AXUIElementPerformAction(void* el, void* action)'),
      AXValueCreate: AS.func('void* AXValueCreate(int type, AsitCGPair* p)'),
      AXValueGetValue: AS.func('bool AXValueGetValue(void* v, int type, _Out_ AsitCGPair* p)'),
      Rect
    }
    try {
      // Private but long-stable (used by every macOS window manager): the
      // CGWindowID behind an AX window — the only exact AX<->CG join.
      f._AXUIElementGetWindow = AS.func('int _AXUIElementGetWindow(void* el, _Out_ uint32_t* id)')
    } catch {
      f._AXUIElementGetWindow = null // fall back to title/bounds matching
    }
    kTrue = koffi.decode(CF.symbol('kCFBooleanTrue'), 'void*')
    kFalse = koffi.decode(CF.symbol('kCFBooleanFalse'), 'void*')
    fn = f
    // An app that's hung must not hang ASIT's main process: cap every AX
    // round trip (applies globally when set on the system-wide element).
    try {
      f.AXUIElementSetMessagingTimeout(f.AXUIElementCreateSystemWide(), 0.4)
    } catch {
      // keep the default
    }
    return true
  } catch {
    loadFailed = true
    fn = null
    return false
  }
}

const strCache = new Map<string, bigint>()
/** An immortal CFString for a constant name (attribute/dictionary keys). */
function cfs(s: string): bigint {
  let v = strCache.get(s)
  if (!v) {
    v = fn!.CFStringCreateWithCString(null, s, UTF8) as bigint
    strCache.set(s, v)
  }
  return v
}

function jsString(ref: unknown): string {
  if (!ref || !fn) return ''
  try {
    if (fn.CFGetTypeID(ref) !== fn.CFStringGetTypeID()) return ''
    const buf = Buffer.alloc(2048)
    if (!fn.CFStringGetCString(ref, buf, buf.length, UTF8)) return ''
    const end = buf.indexOf(0)
    return buf.toString('utf8', 0, end < 0 ? buf.length : end)
  } catch {
    return ''
  }
}

function jsNumber(ref: unknown): number | null {
  if (!ref || !fn) return null
  const out = new BigInt64Array(1)
  return fn.CFNumberGetValue(ref, kCFNumberSInt64Type, out) ? Number(out[0]) : null
}

/** Copy an AX attribute (caller releases a non-null result). */
function axCopy(el: unknown, attr: string): bigint | null {
  const out: unknown[] = [null]
  const err = fn!.AXUIElementCopyAttributeValue(el, cfs(attr), out)
  return err === 0 && out[0] ? (out[0] as bigint) : null
}

function axString(el: unknown, attr: string): string {
  const v = axCopy(el, attr)
  if (!v) return ''
  const s = jsString(v)
  fn!.CFRelease(v)
  return s
}

function axBool(el: unknown, attr: string): boolean | null {
  const v = axCopy(el, attr)
  if (!v) return null
  try {
    return fn!.CFBooleanGetValue(v)
  } catch {
    return null
  } finally {
    fn!.CFRelease(v)
  }
}

function axPair(el: unknown, attr: string, type: number): { a: number; b: number } | null {
  const v = axCopy(el, attr)
  if (!v) return null
  const p: { a?: number; b?: number } = {}
  const ok = fn!.AXValueGetValue(v, type, p)
  fn!.CFRelease(v)
  return ok && typeof p.a === 'number' && typeof p.b === 'number' ? { a: p.a, b: p.b } : null
}

function axSetPair(el: unknown, attr: string, type: number, a: number, b: number): boolean {
  const v = fn!.AXValueCreate(type, { a, b })
  if (!v) return false
  const err = fn!.AXUIElementSetAttributeValue(el, cfs(attr), v)
  fn!.CFRelease(v)
  return err === 0
}

function windowId(el: unknown): number | null {
  if (!fn!._AXUIElementGetWindow) return null
  const out = [0]
  return fn!._AXUIElementGetWindow(el, out) === 0 && out[0] ? out[0] : null
}

interface CgWin {
  id: number
  pid: number
  owner: string
  title: string
  bounds: { x: number; y: number; w: number; h: number }
}

/** Normal-layer windows from the window server (owner names need no permission). */
function cgWindows(): CgWin[] {
  const arr = fn!.CGWindowListCopyWindowInfo(
    kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
    0
  )
  if (!arr) return []
  const out: CgWin[] = []
  try {
    const n = Number(fn!.CFArrayGetCount(arr))
    for (let i = 0; i < n; i++) {
      const d = fn!.CFArrayGetValueAtIndex(arr, i)
      const get = (k: string): unknown => fn!.CFDictionaryGetValue(d, cfs(k))
      if (jsNumber(get('kCGWindowLayer')) !== 0) continue
      const id = jsNumber(get('kCGWindowNumber'))
      const pid = jsNumber(get('kCGWindowOwnerPID'))
      if (!id || !pid) continue
      const r: { x?: number; y?: number; w?: number; h?: number } = {}
      const b = get('kCGWindowBounds')
      if (b) fn!.CGRectMakeWithDictionaryRepresentation(b, r)
      out.push({
        id,
        pid,
        owner: jsString(get('kCGWindowOwnerName')),
        title: jsString(get('kCGWindowName')), // empty without Screen Recording
        bounds: { x: r.x ?? 0, y: r.y ?? 0, w: r.w ?? 0, h: r.h ?? 0 }
      })
    }
  } finally {
    fn!.CFRelease(arr)
  }
  return out
}

/** Every AX window of `pid` (each retained — release with releaseAll). */
function axWindows(pid: number): { app: bigint; wins: bigint[] } | null {
  const app = fn!.AXUIElementCreateApplication(pid) as bigint
  if (!app) return null
  const arr = axCopy(app, 'AXWindows')
  const wins: bigint[] = []
  if (arr) {
    const n = Number(fn!.CFArrayGetCount(arr))
    for (let i = 0; i < n; i++) {
      const el = fn!.CFArrayGetValueAtIndex(arr, i)
      if (el) wins.push(fn!.CFRetain(el) as bigint)
    }
    fn!.CFRelease(arr)
  }
  return { app, wins }
}

/** No private join available: the CG window whose frame matches the AX one. */
function idByFrame(el: unknown, cands: CgWin[]): number | null {
  const p = axPair(el, 'AXPosition', kAXValueCGPointType)
  const s = axPair(el, 'AXSize', kAXValueCGSizeType)
  if (!p || !s) return null
  const hit = cands.find(
    (w) =>
      Math.abs(p.a - w.bounds.x) < 2 &&
      Math.abs(p.b - w.bounds.y) < 2 &&
      Math.abs(s.a - w.bounds.w) < 2 &&
      Math.abs(s.b - w.bounds.h) < 2
  )
  return hit?.id ?? null
}

// ---------------------------------------------------------------------------

export function macStatus(): AppWindowStatus {
  const supported = load()
  let trusted = false
  try {
    trusted = systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    trusted = false
  }
  return { platform: 'darwin', supported, needsPermission: supported && !trusted }
}

/**
 * User clicked "Allow…": ask the OS (shows its one-time prompt) and open the
 * Accessibility pane. A fixed constant opened from a user click — never a URL
 * from the renderer, never reachable by an agent.
 */
export function macRequestPermission(): void {
  try {
    systemPreferences.isTrustedAccessibilityClient(true)
  } catch {
    // older OS: the settings pane below is enough
  }
  void shell.openExternal(ACCESSIBILITY_SETTINGS_URL)
}

function trusted(): boolean {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

export function macListWindows(skip: Set<string>): AppWindow[] {
  if (!load() || !trusted()) return []
  const cg = cgWindows()
  const byId = new Map(cg.map((w) => [w.id, w]))
  const owners = new Map<number, string>()
  for (const w of cg) if (w.pid !== process.pid && !owners.has(w.pid)) owners.set(w.pid, w.owner)
  // Window-server furniture, never an app the user would embed.
  for (const [pid, name] of owners) {
    if (['Dock', 'Window Server', 'Control Center', 'Notification Center', 'SystemUIServer'].includes(name)) {
      owners.delete(pid)
    }
  }
  const out: AppWindow[] = []
  for (const [pid, owner] of owners) {
    if (out.length >= 60) break
    let found: { app: bigint; wins: bigint[] } | null = null
    try {
      found = axWindows(pid)
      if (!found) continue
      for (const el of found.wins) {
        const sub = axString(el, 'AXSubrole')
        if (sub && sub !== 'AXStandardWindow') continue // sheets, palettes, popovers
        const id = windowId(el) ?? idByFrame(el, cg.filter((w) => w.pid === pid))
        if (!id) continue
        const handle = `${pid}:${id}`
        if (skip.has(handle)) continue
        const title = axString(el, 'AXTitle').trim() || byId.get(id)?.title.trim() || ''
        const label = !title || title === owner ? owner || 'Untitled window' : `${title} — ${owner}`
        out.push({ handle, title: label.slice(0, 120) })
      }
    } catch {
      // an app that won't answer AX is simply not listed
    } finally {
      if (found) {
        for (const el of found.wins) fn!.CFRelease(el)
        fn!.CFRelease(found.app)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface MacItem {
  handle: string
  pid: number
  app: bigint
  el: bigint
  title: string
  orig: { x: number; y: number; w: number; h: number } | null
  owner: string
  visible: boolean
  parked: boolean
  rect: Rect | null
  lastSize: string
  parent: BrowserWindow
  detach: () => void
}

const items = new Map<string, MacItem>()

/** Find the AX element for "pid:windowId", retained; null if it's gone. */
function resolve(pid: number, id: number): { app: bigint; el: bigint; title: string } | null {
  const found = axWindows(pid)
  if (!found) return null
  let pick: bigint | null = null
  for (const el of found.wins) {
    if (!pick && windowId(el) === id) pick = el
  }
  if (!pick && !fn!._AXUIElementGetWindow) {
    // No exact join available: match the CG window's frame.
    const cg = cgWindows().filter((w) => w.id === id)
    pick = found.wins.find((el) => idByFrame(el, cg) === id) ?? null
  }
  for (const el of found.wins) if (el !== pick) fn!.CFRelease(el)
  if (!pick) {
    fn!.CFRelease(found.app)
    return null
  }
  return { app: found.app, el: pick, title: axString(pick, 'AXTitle').trim() }
}

function raise(item: MacItem, activate: boolean): void {
  try {
    fn!.AXUIElementPerformAction(item.el, cfs('AXRaise'))
    if (activate && kTrue) {
      fn!.AXUIElementSetAttributeValue(item.el, cfs('AXMain'), kTrue)
      fn!.AXUIElementSetAttributeValue(item.app, cfs('AXFrontmost'), kTrue)
    }
  } catch {
    // the app may be gone
  }
}

/** Put the window where it belongs right now: over the slot, or parked. */
function place(item: MacItem): void {
  if (!fn) return
  const p = item.parent
  const onScreen =
    item.visible && !!item.rect && !p.isDestroyed() && p.isVisible() && !p.isMinimized()
  try {
    if (!onScreen) {
      if (item.parked) return
      // Bottom-right corner of the display ASIT is on: out of sight, never
      // minimised (no animation, and nothing to un-minimise later).
      const d = screen.getDisplayMatching(p.isDestroyed() ? { x: 0, y: 0, width: 1, height: 1 } : p.getBounds()).bounds
      axSetPair(item.el, 'AXPosition', kAXValueCGPointType, d.x + d.width - 1, d.y + d.height - 1)
      item.parked = true
      return
    }
    // DIP == points on macOS, and both Electron and AX use a top-left origin
    // on the primary display — the content bounds translate the slot directly.
    const cb = p.getContentBounds()
    const r = item.rect!
    const x = Math.round(cb.x + r.x)
    const y = Math.round(cb.y + r.y)
    const w = Math.max(1, Math.round(r.width))
    const h = Math.max(1, Math.round(r.height))
    const sizeKey = `${w}x${h}`
    // Position first (a resize at the old spot can be clamped by the screen
    // edge), size, then position again in case the app snapped its origin.
    axSetPair(item.el, 'AXPosition', kAXValueCGPointType, x, y)
    if (sizeKey !== item.lastSize || item.parked) {
      axSetPair(item.el, 'AXSize', kAXValueCGSizeType, w, h)
      axSetPair(item.el, 'AXPosition', kAXValueCGPointType, x, y)
      item.lastSize = sizeKey
    }
    if (item.parked) {
      item.parked = false
      raise(item, false)
    }
  } catch {
    // window or app gone — release() will tidy up
  }
}

export function macEmbed(handle: string, parent: BrowserWindow, owner: string): string | null {
  if (!load()) return 'window embedding is unavailable on this Mac (native bridge failed to load)'
  if (!trusted()) {
    return 'ASIT needs Accessibility permission to move another app’s window. Allow it in System Settings › Privacy & Security › Accessibility, then try again.'
  }
  if (items.has(handle)) return null
  const m = /^(\d+):(\d+)$/.exec(handle)
  if (!m) return 'bad window handle'
  const pid = Number(m[1])
  const id = Number(m[2])
  if (pid === process.pid) return 'that is one of ASIT’s own windows'
  const found = resolve(pid, id)
  if (!found) return 'that window no longer exists (or is on another Space)'

  if (axBool(found.el, 'AXMinimized') && kFalse) {
    fn!.AXUIElementSetAttributeValue(found.el, cfs('AXMinimized'), kFalse)
  }
  const pos = axPair(found.el, 'AXPosition', kAXValueCGPointType)
  const size = axPair(found.el, 'AXSize', kAXValueCGSizeType)
  const item: MacItem = {
    handle,
    pid,
    app: found.app,
    el: found.el,
    title: found.title,
    orig: pos && size ? { x: pos.a, y: pos.b, w: size.a, h: size.b } : null,
    owner,
    visible: true,
    parked: false,
    rect: null,
    lastSize: '',
    parent,
    detach: () => undefined
  }
  // Follow ASIT's own window: move, resize, minimise/hide, restore/show.
  const follow = (): void => place(item)
  const gone = (): void => macRelease(handle)
  const events = ['move', 'resize', 'minimize', 'restore', 'hide', 'show', 'enter-full-screen', 'leave-full-screen'] as const
  for (const e of events) parent.on(e as any, follow)
  parent.once('closed', gone)
  item.detach = () => {
    if (parent.isDestroyed()) return
    for (const e of events) parent.removeListener(e as any, follow)
    parent.removeListener('closed', gone)
  }
  items.set(handle, item)
  raise(item, true)
  return null
}

export function macSetBounds(handle: string, bounds: Rect): void {
  const item = items.get(handle)
  if (!item) return
  item.rect = bounds
  place(item)
}

export function macSetVisible(handle: string, visible: boolean): void {
  const item = items.get(handle)
  if (!item || item.visible === visible) return
  item.visible = visible
  place(item)
}

/** User clicked the slot: bring the followed window in front of ASIT. */
export function macRaise(handle: string): void {
  const item = items.get(handle)
  if (!item) return
  place(item)
  raise(item, true)
}

export function macRelease(handle: string): void {
  const item = items.get(handle)
  if (!item) return
  items.delete(handle)
  item.detach()
  if (!fn) return
  try {
    // Never strand the user's window in a corner or at slot size.
    if (item.orig) {
      axSetPair(item.el, 'AXPosition', kAXValueCGPointType, item.orig.x, item.orig.y)
      axSetPair(item.el, 'AXSize', kAXValueCGSizeType, item.orig.w, item.orig.h)
      axSetPair(item.el, 'AXPosition', kAXValueCGPointType, item.orig.x, item.orig.y)
    } else {
      const d = screen.getPrimaryDisplay().workArea
      axSetPair(item.el, 'AXPosition', kAXValueCGPointType, d.x + 120, d.y + 120)
    }
    fn.AXUIElementPerformAction(item.el, cfs('AXRaise'))
  } catch {
    // the app may already be gone
  } finally {
    fn.CFRelease(item.el)
    fn.CFRelease(item.app)
  }
}

export function macEmbeddedHandles(): string[] {
  return [...items.keys()]
}

export function macEmbeddedTitle(handle: string): string | null {
  return items.get(handle)?.title ?? null
}

export function macOwnerOf(handle: string): string | null {
  return items.get(handle)?.owner ?? null
}
