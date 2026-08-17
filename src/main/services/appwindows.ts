import { BrowserWindow, screen } from 'electron'

// Embed a REAL native window (Emacs, Excel, anything) inside a workspace slot
// by reparenting its HWND under ASIT's window.
//
// This is genuinely best-effort per application, and the honest caveats are:
//   * The app's menus, dialogs and tooltips are separate top-level windows —
//     they pop OUTSIDE the frame.
//   * A reparented child HWND paints above everything Chromium draws, so it
//     is hidden whenever its slot isn't the visible one (same discipline the
//     WebContentsViews follow).
//   * The AI cannot read it. A native window has no DOM; embedding moves
//     pixels, it does not create context. Only the window's title is known.
//   * Some apps misbehave when their parent changes. Everything is restored
//     on release and on quit, and a failed embed leaves the window alone.
//
// Nothing here is reachable by an agent: there is no action verb, and the
// only callers are user-driven IPC handlers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let user32: any = null
let api: Record<string, any> = {}

function win32(): boolean {
  if (process.platform !== 'win32') return false
  if (user32) return true
  try {
    // Loaded lazily so a machine without koffi still runs the rest of the app.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')
    user32 = koffi.load('user32.dll')
    const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(void* hwnd, void* lparam)')
    api = {
      EnumWindows: user32.func('bool EnumWindows(void* proc, void* lparam)'),
      EnumWindowsProc,
      cb: koffi.pointer(EnumWindowsProc),
      IsWindowVisible: user32.func('bool IsWindowVisible(void* hwnd)'),
      IsWindow: user32.func('bool IsWindow(void* hwnd)'),
      GetWindowTextW: user32.func('int GetWindowTextW(void* hwnd, _Out_ uint16_t* str, int max)'),
      GetWindowTextLengthW: user32.func('int GetWindowTextLengthW(void* hwnd)'),
      GetWindowLongPtrW: user32.func('intptr_t GetWindowLongPtrW(void* hwnd, int index)'),
      SetWindowLongPtrW: user32.func('intptr_t SetWindowLongPtrW(void* hwnd, int index, intptr_t v)'),
      SetParent: user32.func('void* SetParent(void* child, void* parent)'),
      SetWindowPos: user32.func(
        'bool SetWindowPos(void* hwnd, void* after, int x, int y, int cx, int cy, unsigned int flags)'
      ),
      ShowWindow: user32.func('bool ShowWindow(void* hwnd, int cmd)'),
      GetWindow: user32.func('void* GetWindow(void* hwnd, unsigned int cmd)'),
      GetClassNameW: user32.func('int GetClassNameW(void* hwnd, _Out_ uint16_t* str, int max)'),
      // UWP/shell ghosts ("Windows Input Experience", the lock screen) are
      // visible but CLOAKED — without this they clutter the whole picker.
      DwmGetWindowAttribute: koffi
        .load('dwmapi.dll')
        .func('int DwmGetWindowAttribute(void* hwnd, unsigned int attr, _Out_ void* out, unsigned int size)')
    }
    return true
  } catch {
    user32 = null
    return false
  }
}

const GWL_STYLE = -16
const GWL_EXSTYLE = -20
const WS_CHILD = 0x40000000n
const WS_POPUP = 0x80000000n
const WS_CAPTION = 0x00c00000n
const WS_THICKFRAME = 0x00040000n
const WS_EX_TOOLWINDOW = 0x00000080n
const WS_EX_APPWINDOW = 0x00040000n
const SW_HIDE = 0
const SW_SHOW = 5
const SWP_NOZORDER = 0x0004
const SWP_FRAMECHANGED = 0x0020
const SWP_SHOWWINDOW = 0x0040
const GW_OWNER = 4

export interface AppWindow {
  handle: string // decimal HWND as a string (BigInt doesn't cross IPC)
  title: string
}

interface Embedded {
  hwnd: bigint
  title: string
  style: bigint
  exStyle: bigint
  owner: string // taskId
  visible: boolean
}

const embedded = new Map<string, Embedded>()

function textOf(fn: string, hwnd: bigint, max = 512): string {
  const buf = new Uint16Array(max)
  const n = api[fn](hwnd, buf, max)
  if (n <= 0) return ''
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le')
}

/** Visible, titled, top-level application windows — what a task switcher shows. */
export function listWindows(): AppWindow[] {
  if (!win32()) return []
  const out: AppWindow[] = []
  const self = new Set(
    BrowserWindow.getAllWindows().map((w) => hwndOf(w)?.toString() ?? '')
  )
  try {
    const koffi = require('koffi')
    const cb = koffi.register((hwnd: unknown, _lp: unknown) => {
      try {
        const h = BigInt(hwnd as never)
        if (!api.IsWindowVisible(h)) return true
        if (api.GetWindowTextLengthW(h) === 0) return true
        const ex = BigInt(api.GetWindowLongPtrW(h, GWL_EXSTYLE))
        // Tool windows are palettes/overlays, not apps.
        if ((ex & WS_EX_TOOLWINDOW) !== 0n && (ex & WS_EX_APPWINDOW) === 0n) return true
        if (api.GetWindow(h, GW_OWNER)) return true // owned dialog, not a main window
        if (isCloaked(h)) return true
        const title = textOf('GetWindowTextW', h).trim()
        if (!title) return true
        if (self.has(h.toString())) return true
        if (embedded.has(h.toString())) return true
        out.push({ handle: h.toString(), title: title.slice(0, 120) })
      } catch {
        // skip a window we can't inspect
      }
      return true
    }, api.cb)
    api.EnumWindows(cb, null)
    koffi.unregister(cb)
  } catch {
    return []
  }
  return out.slice(0, 60)
}

const DWMWA_CLOAKED = 14

function isCloaked(hwnd: bigint): boolean {
  try {
    const out = Buffer.alloc(4)
    if (api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out, 4) !== 0) return false
    return out.readUInt32LE(0) !== 0
  } catch {
    return false
  }
}

function hwndOf(win: BrowserWindow): bigint | null {
  try {
    const buf = win.getNativeWindowHandle()
    return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
  } catch {
    return null
  }
}

/** Embed `handle` into `parent`. Returns an error string, or null on success. */
export function embedWindow(handle: string, parent: BrowserWindow, owner: string): string | null {
  if (!win32()) return 'window embedding needs Windows'
  let hwnd: bigint
  try {
    hwnd = BigInt(handle)
  } catch {
    return 'bad window handle'
  }
  if (embedded.has(handle)) return null
  if (!api.IsWindow(hwnd)) return 'that window no longer exists'
  const parentHwnd = hwndOf(parent)
  if (!parentHwnd) return 'could not find the ASIT window'

  const style = BigInt(api.GetWindowLongPtrW(hwnd, GWL_STYLE))
  const exStyle = BigInt(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  const title = textOf('GetWindowTextW', hwnd).trim()

  try {
    const child = (style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD
    api.SetWindowLongPtrW(hwnd, GWL_STYLE, child)
    if (!api.SetParent(hwnd, parentHwnd)) {
      api.SetWindowLongPtrW(hwnd, GWL_STYLE, style) // put it back
      return 'Windows refused to reparent that window'
    }
    embedded.set(handle, { hwnd, title, style, exStyle, owner, visible: true })
    api.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_NOZORDER | SWP_FRAMECHANGED)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Position (DIP from the renderer → physical pixels for Win32). */
export function setWindowBounds(
  handle: string,
  bounds: { x: number; y: number; width: number; height: number },
  parent: BrowserWindow
): void {
  const item = embedded.get(handle)
  if (!item || !win32()) return
  const scale = screen.getDisplayMatching(parent.getBounds()).scaleFactor || 1
  const px = (v: number): number => Math.round(v * scale)
  try {
    api.SetWindowPos(
      item.hwnd,
      null,
      px(bounds.x),
      px(bounds.y),
      Math.max(1, px(bounds.width)),
      Math.max(1, px(bounds.height)),
      SWP_NOZORDER | SWP_SHOWWINDOW
    )
  } catch {
    // the app may have died — release() cleans up
  }
}

/**
 * A native child window paints above ALL Chromium content, so it must be
 * hidden whenever its slot isn't the one on screen — exactly the discipline
 * WebContentsViews follow (invariant 2).
 */
export function setWindowVisible(handle: string, visible: boolean): void {
  const item = embedded.get(handle)
  if (!item || !win32()) return
  if (item.visible === visible) return
  item.visible = visible
  try {
    api.ShowWindow(item.hwnd, visible ? SW_SHOW : SW_HIDE)
  } catch {
    // ignore
  }
}

export function setAllVisible(visible: boolean): void {
  for (const handle of embedded.keys()) setWindowVisible(handle, visible)
}

/** Give the window back to the desktop, restoring its original frame. */
export function releaseWindow(handle: string): void {
  const item = embedded.get(handle)
  if (!item) return
  embedded.delete(handle)
  if (!win32()) return
  try {
    if (api.IsWindow(item.hwnd)) {
      api.SetParent(item.hwnd, null)
      api.SetWindowLongPtrW(item.hwnd, GWL_STYLE, item.style)
      api.SetWindowLongPtrW(item.hwnd, GWL_EXSTYLE, item.exStyle)
      api.SetWindowPos(
        item.hwnd,
        null,
        120,
        120,
        1000,
        700,
        SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW
      )
      api.ShowWindow(item.hwnd, SW_SHOW)
    }
  } catch {
    // the app may already be gone
  }
}

export function releaseForTask(taskId: string): void {
  for (const [handle, item] of [...embedded.entries()]) {
    if (item.owner === taskId) releaseWindow(handle)
  }
}

/** MUST run on quit — otherwise the user's app is left parented to nothing. */
export function releaseAllWindows(): void {
  for (const handle of [...embedded.keys()]) releaseWindow(handle)
}

export function embeddedTitle(handle: string): string | null {
  return embedded.get(handle)?.title ?? null
}
