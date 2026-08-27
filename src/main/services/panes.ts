import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  Menu,
  session,
  shell,
  WebContentsView,
  type ContextMenuParams,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc-contract'
import { isMailHost, mailSendBlocked, sendRefusalReason } from './guardrails'
import type { DownloadItem } from '@shared/types'
import { SHORTCUTS, ZONE_ACCELERATORS } from '@shared/shortcuts'
import { setAllVisible as setAllAppWindowsVisible } from './appwindows'
import { applyDeclutter } from './declutter'
import { recordVisit } from './history'
import { searchUrlFor } from './search'

// All embedded browser panes share one persistent partition so logins
// (Overleaf, Google, ...) survive restarts and are shared across tasks.
const BROWSE_PARTITION = 'persist:asit-browse'

export interface PaneTarget {
  url?: string
  filePath?: string
  /**
   * Skip the HTTP cache for this load. Used when RESTORING a tab at startup:
   * a page whose signed-in state is baked into its HTML (google.com is the
   * one that keeps catching us out) comes back from cache showing whatever it
   * showed last time, so a perfectly valid session renders as "Sign in" and
   * the app looks broken. One revalidating request per restored tab, once per
   * launch, is a cheap price for the page telling the truth.
   */
  fresh?: boolean
}

export interface PaneBounds {
  x: number
  y: number
  width: number
  height: number
}

interface Pane {
  view: WebContentsView
  desiredVisible: boolean
  lastActive: number
  // The task whose workspace opened this pane. Panes are parked, not closed,
  // when the user navigates away — so at any moment the manager holds panes
  // from several workspaces plus the scratchpad. Every AI-facing operation
  // (snapshot, click, fill, key, type, navigate, watch-probe) REQUIRES the
  // acting task's id and only ever sees panes with a matching owner. A
  // workspace agent must never be able to read or drive another workspace's
  // tabs — least of all the user's personal scratchpad browser.
  owner: string
}

/**
 * A readable failure page, in the app's own colours, with a retry button —
 * instead of the blank pane a failed load used to leave behind.
 */
function errorPageUrl(failedUrl: string, reason: string): string {
  const safe = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).slice(0, 300)
  const html = `<!doctype html><meta charset="utf-8"><title>Can't load page</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#12141a; color:#c8d0e0;
         font:14px/1.5 -apple-system,Segoe UI,system-ui,sans-serif }
  .card { max-width:460px; padding:28px; text-align:center }
  h1 { font-size:1.05rem; margin:0 0 10px; color:#e6ecff }
  code { display:block; margin:12px 0; padding:8px 10px; background:#191c24;
         border-radius:6px; color:#7aa2f7; font-size:.78rem; word-break:break-all }
  p { color:#8b93a7; font-size:.82rem; margin:6px 0 }
  button { margin-top:16px; padding:7px 18px; border-radius:7px; cursor:pointer;
           border:1px solid #3d59a1; background:#1d2233; color:#c8d0e0; font-size:.82rem }
  button:hover { background:#252c42 }
</style>
<div class="card">
  <h1>This page didn't load</h1>
  <code>${safe(failedUrl)}</code>
  <p>${safe(reason)}</p>
  <p>Check your connection, or open it in your browser if the site blocks embedding.</p>
  <button onclick="location.replace(${JSON.stringify(failedUrl)})">Try again</button>
</div>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Never silently overwrite an existing download: file.pdf -> file (1).pdf */
function uniquePath(target: string): string {
  if (!existsSync(target)) return target
  const dot = target.lastIndexOf('.')
  const stem = dot > 0 ? target.slice(0, dot) : target
  const ext = dot > 0 ? target.slice(dot) : ''
  for (let i = 1; i < 500; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return target
}

// Panes are PARKED (hidden, alive) when navigating away, not destroyed — so
// moving between tasks never reloads pages or interrupts anything running in
// them. An LRU cap keeps memory bounded.
const MAX_PANES = 14

// Navigation keys, taken at the OS level while an embedded page holds focus.
// `before-input-event` is not enough: it never fires for keys delivered to a
// cross-process subframe — Chromium's built-in PDF viewer, and any site that
// puts its editor in an iframe — which is why Tab used to walk the PDF's own
// controls instead of leaving the pane.
// Derived from the SHARED table — main's job is only to forward the key's id
// when an embedded page has swallowed it. It no longer decides what any key
// means; the renderer's dispatcher does, for both origins.
//
// Tab is deliberately ABSENT. Grabbing it here meant a focused page never
// received it, so Tab could not move between fields on a form — the single
// most common thing Tab does. Panel cycling moved to F6.
const NAV_ACCELERATORS: { accel: string; event: Record<string, unknown> }[] = [
  ...SHORTCUTS.map((d) => ({ accel: d.accel, event: { type: d.id } })),
  ...ZONE_ACCELERATORS.map((z) => ({ accel: z.accel, event: { type: 'focus-zone', index: z.index } }))
]

// WebContentsViews always paint above the renderer DOM. The renderer owns
// bounds + per-pane visibility; overlays use setAllHidden to get on top.
class PaneManager {
  private win: BrowserWindow | null = null
  private panes = new Map<string, Pane>()
  // Refcounted: overlays and divider-drags each push a hide and pop it on
  // close. A plain boolean broke stacked overlays (closing the inner one
  // repainted panes over the outer one).
  private hideCount = 0

  private get allHidden(): boolean {
    return this.hideCount > 0
  }

  attach(win: BrowserWindow): void {
    this.win = win
    this.wireDownloads()
    win.on('closed', () => {
      this.win = null
      this.panes.clear()
      this.focusedPaneId = null
      this.syncNavKeys()
    })
    // Releasing on window blur is what keeps these accelerators from leaking
    // into other applications.
    win.on('blur', () => this.syncNavKeys())
    win.on('focus', () => this.syncNavKeys())
  }

  private focusedPaneId: string | null = null
  private favicons = new Map<string, string | null>()
  private downloads = new Map<string, DownloadItem>()
  private downloadsWired = false
  private zoomLevels = new Map<string, number>()
  private navKeysHeld = false
  // The renderer reports whether IT holds the keyboard. When it doesn't, an
  // embedded page does — and that page (or one of its subframes) would
  // otherwise eat every navigation key.
  private domFocused = true

  setDomFocused(focused: boolean): void {
    this.domFocused = focused
    this.syncNavKeys()
  }

  private syncNavKeys(): void {
    const pageHasKeyboard =
      !this.domFocused && [...this.panes.values()].some((p) => p.desiredVisible)
    const want =
      pageHasKeyboard &&
      !this.allHidden &&
      !!this.win &&
      !this.win.isDestroyed() &&
      this.win.isFocused()
    if (want === this.navKeysHeld) return
    this.navKeysHeld = want
    if (!want) {
      for (const { accel } of NAV_ACCELERATORS) globalShortcut.unregister(accel)
      return
    }
    for (const { accel, event } of NAV_ACCELERATORS) {
      try {
        globalShortcut.register(accel, () => this.sendAppEvent(event))
      } catch {
        // A key another app already owns — the rest still register.
      }
    }
  }

  releaseNavKeys(): void {
    this.focusedPaneId = null
    this.domFocused = true
    this.syncNavKeys()
  }

  open(paneId: string, target: PaneTarget, owner: string): void {
    if (!this.win) return
    const existing = this.panes.get(paneId)
    if (existing) {
      existing.lastActive = Date.now() // revived from parking — no reload
      // Re-stamp: "save session" moves scratch resources into a new task, and
      // the revived pane now belongs to that task.
      existing.owner = owner
      return
    }

    // LRU eviction: destroy the oldest parked panes to stay under the cap.
    if (this.panes.size >= MAX_PANES) {
      const parked = [...this.panes.entries()]
        .filter(([, p]) => !p.desiredVisible)
        .sort((a, b) => a[1].lastActive - b[1].lastActive)
      for (const [id] of parked.slice(0, this.panes.size - MAX_PANES + 1)) {
        this.close(id)
        // TELL the renderer. It keeps its own "already opened" set, so an
        // eviction it never hears about leaves a tab that looks open, is
        // gone in main, and renders blank forever — every setVisible and
        // setBounds for it is silently a no-op. This was the intermittent
        // "sometimes a tab just doesn't load".
        this.announceGone(id)
      }
    }

    const isUrl = !!target.url
    const view = new WebContentsView({
      webPreferences: {
        partition: isUrl ? BROWSE_PARTITION : undefined,
        plugins: true, // Chromium built-in PDF viewer
        sandbox: true,
        contextIsolation: true,
        // Isolated-world helper: makes "/KEY " snippets expand inside any
        // website's forms. Pages cannot see or reach it.
        preload: join(__dirname, '../preload/pane.js')
      }
    })

    // Allow web popups (Google OAuth login flows need them); they share the
    // persistent session so completed logins land back in the pane. Anything
    // that isn't http(s) — file:, custom protocol handlers — is denied: a
    // page must not be able to pop local content or trigger scheme handlers.
    //
    // Ctrl+click and middle-click ask for a TAB, not a window: honour that by
    // opening a real pane in the workspace instead of a floating window.
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^https?:\/\//i.test(url)) return { action: 'deny' }
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        this.sendAppEvent({ type: 'open-url-tab', url, owner: this.panes.get(paneId)?.owner })
        return { action: 'deny' }
      }
      return { action: 'allow' }
    })

    // Right-click. Panes had no context menu at all — no copy, no paste, no
    // "open link in new tab", which is most of what makes an embedded page
    // feel broken next to a real browser.
    view.webContents.on('context-menu', (_e, params) => {
      this.showContextMenu(paneId, view.webContents, params)
    })

    // A failed load used to leave a blank pane with no explanation. Show what
    // failed and offer a retry instead (same rule as the app's own loads).
    view.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3 = aborted (normal during nav)
      view.webContents.loadURL(errorPageUrl(failedUrl, desc || String(code)))
    })

    view.webContents.on('page-favicon-updated', (_e, icons) => {
      this.favicons.set(paneId, icons[0] ?? null)
      pushNavState()
    })

    view.webContents.on('found-in-page', (_e, result) => {
      if (!this.win || this.win.isDestroyed()) return
      this.win.webContents.send(IPC.PANES_FIND_RESULT, {
        paneId,
        activeMatch: result.activeMatchOrdinal,
        matches: result.matches
      })
    })

    // Pages that ask for the camera/mic/notifications used to hang on a
    // promise that never settled. Deny by default, allow the ones a study
    // workspace legitimately needs.
    view.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')
    })

    // Focus tracking drives the OS-level key grab above, and tells the
    // renderer which zone the ring is sitting on when the user CLICKS into a
    // page (no DOM focus event reaches the renderer in that case).
    view.webContents.on('focus', () => {
      this.focusedPaneId = paneId
      this.domFocused = false // second signal: works even if the renderer misses its blur
      this.syncNavKeys()
      this.sendAppEvent({ type: 'pane-focused', paneId })
    })
    view.webContents.on('blur', () => {
      if (this.focusedPaneId === paneId) this.focusedPaneId = null
      this.syncNavKeys()
    })

    // Same shortcuts for pages whose keys DO reach us here (main-frame
    // content). While the accelerators above are held this never fires — the
    // key is consumed before the page sees it — so there is no double-handling.
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'Tab' && input.control) {
        event.preventDefault()
        this.sendAppEvent({ type: input.shift ? 'prev-tab' : 'next-tab' })
        return
      }
      // Plain Tab is deliberately NOT handled: it belongs to the page, so a
      // form's fields tab in order. Panel cycling is F6 (see NAV_ACCELERATORS).
      if (!input.control || input.alt || input.meta) return
      const k = input.key.toLowerCase()
      if (k === 'k') {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-assistant' })
      } else if (k === 'j') {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-jarvis' })
      } else if (k === ' ' || input.code === 'Space') {
        event.preventDefault()
        this.sendAppEvent({ type: 'voice-toggle' })
      } else if (k === 'l') {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-address' })
      } else if (/^[1-9]$/.test(k)) {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-zone', index: Number(k) - 1 })
      } else if (k === 'f') {
        event.preventDefault()
        this.sendAppEvent({ type: 'find-in-page', paneId })
      } else if (k === '=' || k === '+' || k === '-' || k === '0') {
        event.preventDefault()
        const level = this.zoom(paneId, k === '0' ? 0 : k === '-' ? -0.5 : 0.5)
        this.sendAppEvent({ type: 'pane-zoom', paneId, zoom: level })
      } else if (k === 'r') {
        event.preventDefault()
        view.webContents.reload()
      } else if (k === 't') {
        event.preventDefault()
        this.sendAppEvent({ type: input.shift ? 'reopen-tab' : 'new-tab' })
      } else if (k === 'w') {
        event.preventDefault()
        this.sendAppEvent({ type: 'close-tab' })
      }
    })

    let lastNavPayload = ''
    const pushNavState = (): void => {
      if (!this.win || this.win.isDestroyed()) return
      const wc = view.webContents
      const payload = {
        paneId,
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        favicon: this.favicons.get(paneId) ?? null,
        zoom: this.zoomLevels.get(paneId) ?? 0,
        loading: wc.isLoading()
      }
      // Deduped: loading events fire per frame-load cycle (iframe-heavy
      // pages flip constantly), and every send re-renders both tab strips.
      const key = JSON.stringify(payload)
      if (key === lastNavPayload) return
      lastNavPayload = key
      this.win.webContents.send(IPC.PANES_DID_NAVIGATE, payload)
    }
    // Loading state, so the UI can show a spinner and a stop button — without
    // these a slow page and a dead page look identical.
    view.webContents.on('did-start-loading', pushNavState)
    view.webContents.on('did-stop-loading', pushNavState)
    // Strip the page's own interruption furniture as soon as its DOM is
    // up. dom-ready rather than did-navigate: inserting before the
    // document exists is a no-op, and consent walls appear immediately.
    view.webContents.on('dom-ready', () => void applyDeclutter(view.webContents))
    // A crashed renderer is the other way a pane dies without the UI knowing.
    view.webContents.on('render-process-gone', () => {
      this.close(paneId)
      this.announceGone(paneId)
    })
    view.webContents.on('did-navigate', pushNavState)
    view.webContents.on('did-navigate', () => void applyDeclutter(view.webContents))
    // History is keyed to the OWNING workspace so private ones can opt out.
    // page-title-updated rather than did-navigate alone: at navigation time
    // the title is still the previous page's, and a history list of wrong
    // titles is worse than none.
    view.webContents.on('page-title-updated', () => {
      const pane = this.panes.get(paneId)
      recordVisit(view.webContents.getURL(), view.webContents.getTitle(), pane?.owner ?? null)
    })
    view.webContents.on('did-navigate-in-page', pushNavState)
    view.webContents.on('page-title-updated', pushNavState)

    if (target.url) {
      view.webContents.loadURL(
        target.url,
        target.fresh
          ? { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache' }
          : undefined
      )
    } else if (target.filePath) {
      view.webContents.loadURL(pathToFileURL(target.filePath).href)
    }

    view.setVisible(false) // hidden until the renderer sends bounds
    this.win.contentView.addChildView(view)
    this.panes.set(paneId, { view, desiredVisible: false, lastActive: Date.now(), owner })
  }

  /** A pane went away for a reason the renderer did not ask for. */
  private announceGone(paneId: string): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(IPC.PANES_GONE, { paneId })
  }

  setBounds(paneId: string, bounds: PaneBounds): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    pane.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    })
  }

  setVisible(paneId: string, visible: boolean): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    pane.desiredVisible = visible
    if (visible) pane.lastActive = Date.now()
    pane.view.setVisible(visible && !this.allHidden)
  }

  private sendAppEvent(payload: Record<string, unknown>): void {
    const win = this.win
    if (win && !win.isDestroyed()) win.webContents.send(IPC.APP_EVENT, payload)
  }

  // Give keyboard focus to one pane (a stop on the renderer's focus ring).
  focusPane(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (!pane || !pane.desiredVisible) return
    pane.lastActive = Date.now()
    this.focusedPaneId = paneId
    this.domFocused = false
    this.syncNavKeys()
    pane.view.webContents.focus()
  }

  // Park everything: hide but keep alive (used when navigating home↔task).
  parkAll(): void {
    for (const pane of this.panes.values()) {
      pane.desiredVisible = false
      pane.view.setVisible(false)
    }
    this.releaseNavKeys()
  }

  // The user's open WhatsApp Web pane, if any. USER-COMMAND path only (the
  // "> name: message" sender): WhatsApp allows one active tab per session, so
  // a hidden window would fight the visible pane for the session. Scoped hard
  // to web.whatsapp.com — this is not a general AI pane accessor.
  whatsappWebContents(): Electron.WebContents | null {
    for (const pane of this.panes.values()) {
      try {
        if (pane.view.webContents.getURL().startsWith('https://web.whatsapp.com')) {
          return pane.view.webContents
        }
      } catch {
        // view mid-destroy
      }
    }
    return null
  }

  // Autotype into whichever pane is currently visible (quick-fetch OTP flow).
  async typeToFirstVisible(text: string): Promise<string> {
    const pane = [...this.panes.values()].find(
      (p) => p.desiredVisible && /^https?:/i.test(p.view.webContents.getURL())
    )
    if (!pane) return 'no visible page to type into'
    return this.typeToView(pane.view, text)
  }

  // Overlay support: hide every view so renderer DOM (modals, lockdown
  // overlay, review cards) can appear on top; restore per-pane state after.
  setAllHidden(hidden: boolean): void {
    this.hideCount = Math.max(0, this.hideCount + (hidden ? 1 : -1))
    // An overlay is up and the DOM owns the keyboard again.
    if (hidden) this.releaseNavKeys()
    for (const pane of this.panes.values()) {
      pane.view.setVisible(pane.desiredVisible && !this.allHidden)
    }
    // Embedded native windows paint above EVERYTHING (including the panes), so
    // an overlay has to banish them too or it opens underneath the app.
    setAllAppWindowsVisible(!this.allHidden)
  }

  navigate(
    paneId: string,
    action: { url?: string; nav?: 'back' | 'forward' | 'reload' | 'stop' }
  ): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    const wc = pane.view.webContents
    if (action.url) wc.loadURL(action.url)
    else if (action.nav === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action.nav === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward()
    else if (action.nav === 'reload') wc.reload()
    else if (action.nav === 'stop') wc.stop()
  }

  // --- browser basics (user-driven only; none of this is agent-reachable) ---

  /**
   * Downloads. Clicking a download link in a pane previously did nothing at
   * all — Electron cancels a download with no `will-download` handler. Files
   * land in the OS Downloads folder, with progress and a "show in folder".
   */
  private wireDownloads(): void {
    if (this.downloadsWired) return
    this.downloadsWired = true
    const ses = session.fromPartition(BROWSE_PARTITION)
    ses.on('will-download', (_e, item) => {
      const id = `dl-${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
      const savePath = join(app.getPath('downloads'), item.getFilename())
      item.setSavePath(uniquePath(savePath))

      const emit = (state: DownloadItem['state']): void => {
        const entry: DownloadItem = {
          id,
          filename: item.getFilename(),
          savePath: item.getSavePath(),
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          state
        }
        this.downloads.set(id, entry)
        if (this.win && !this.win.isDestroyed())
          this.win.webContents.send(IPC.PANES_DOWNLOAD_EVENT, entry)
      }

      emit('progressing')
      item.on('updated', (_ev, state) =>
        emit(state === 'interrupted' ? 'interrupted' : 'progressing')
      )
      item.once('done', (_ev, state) =>
        emit(state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted')
      )
    })
  }

  listDownloads(): DownloadItem[] {
    return [...this.downloads.values()].slice(-20).reverse()
  }

  showDownload(id: string): void {
    const d = this.downloads.get(id)
    if (d?.savePath) shell.showItemInFolder(d.savePath)
  }

  /** Ctrl+F. Empty text stops the search and clears highlights. */
  find(paneId: string, text: string, forward = true, findNext = false): void {
    const wc = this.panes.get(paneId)?.view.webContents
    if (!wc) return
    if (!text) {
      wc.stopFindInPage('clearSelection')
      return
    }
    wc.findInPage(text, { forward, findNext })
  }

  stopFind(paneId: string): void {
    this.panes.get(paneId)?.view.webContents.stopFindInPage('clearSelection')
  }

  /** Ctrl+= / Ctrl+- / Ctrl+0. `delta` of 0 resets. */
  zoom(paneId: string, delta: number): number {
    const wc = this.panes.get(paneId)?.view.webContents
    if (!wc) return 0
    const next = delta === 0 ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + delta))
    wc.setZoomLevel(next)
    this.zoomLevels.set(paneId, next)
    return next
  }

  private showContextMenu(paneId: string, wc: WebContents, params: ContextMenuParams): void {
    const owner = this.panes.get(paneId)?.owner
    const items: Electron.MenuItemConstructorOptions[] = []
    const add = (item: Electron.MenuItemConstructorOptions): number => items.push(item)

    if (params.linkURL && /^https?:/i.test(params.linkURL)) {
      add({
        label: 'Open link in new tab',
        click: () => this.sendAppEvent({ type: 'open-url-tab', url: params.linkURL, owner })
      })
      add({
        label: 'Open link in browser',
        click: () => void shell.openExternal(params.linkURL)
      })
      add({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) })
      add({ type: 'separator' })
    }

    if (params.mediaType === 'image' && /^https?:/i.test(params.srcURL)) {
      add({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) })
      add({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) })
      add({ label: 'Save image…', click: () => wc.downloadURL(params.srcURL) })
      add({ type: 'separator' })
    }

    // Clipboard. These were the biggest omission: without a context menu the
    // only way to copy out of a page was a keyboard shortcut.
    if (params.isEditable || params.selectionText) {
      add({ role: 'cut', enabled: params.isEditable && !!params.selectionText })
      add({ role: 'copy', enabled: !!params.selectionText })
      add({ role: 'paste', enabled: params.isEditable })
      add({ role: 'selectAll' })
      add({ type: 'separator' })
    }

    if (params.selectionText && !params.isEditable) {
      const q = params.selectionText.trim().slice(0, 100)
      add({
        label: `Search for “${q.length > 30 ? q.slice(0, 30) + '…' : q}”`,
        click: () =>
          this.sendAppEvent({
            type: 'open-url-tab',
            url: searchUrlFor(q),
            owner
          })
      })
      add({ type: 'separator' })
    }

    add({
      label: 'Back',
      enabled: wc.navigationHistory.canGoBack(),
      click: () => wc.navigationHistory.goBack()
    })
    add({
      label: 'Forward',
      enabled: wc.navigationHistory.canGoForward(),
      click: () => wc.navigationHistory.goForward()
    })
    add({ label: 'Reload', click: () => wc.reload() })
    add({ type: 'separator' })
    add({ label: 'Find in page…', click: () => this.sendAppEvent({ type: 'find-in-page', paneId }) })
    add({ label: 'Copy page address', click: () => clipboard.writeText(wc.getURL()) })
    add({
      label: 'Open page in browser',
      click: () => {
        const u = wc.getURL()
        if (/^https?:/i.test(u)) void shell.openExternal(u)
      }
    })
    add({ type: 'separator' })
    add({ label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) })

    Menu.buildFromTemplate(items).popup({ window: this.win ?? undefined })
  }

  close(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    this.favicons.delete(paneId)
    this.zoomLevels.delete(paneId)
    if (this.focusedPaneId === paneId) this.releaseNavKeys()
    if (this.win && !this.win.isDestroyed()) {
      this.win.contentView.removeChildView(pane.view)
    }
    pane.view.webContents.close()
    this.panes.delete(paneId)
  }

  closeAll(): void {
    for (const paneId of [...this.panes.keys()]) {
      this.close(paneId)
    }
  }

  // -------------------------------------------------------------------------
  // Page bridge: snapshot open web pages (with stable element refs injected
  // into the live DOM) so the AI can read them, and perform fill/click/select
  // on those refs so it can act on them. All driven through the file-based
  // action protocol — fast, no extra processes.
  // -------------------------------------------------------------------------

  // Ref maps are PER OWNER: two agents snapshotting concurrently (Jarvis +
  // a background workspace chat) must not clear each other's live refs.
  private refMaps = new Map<string, Map<string, string>>() // owner → ref → paneId
  private prefixMaps = new Map<string, Map<string, string>>() // owner → pN → paneId

  private ownerRefs(owner: string): Map<string, string> {
    let m = this.refMaps.get(owner)
    if (!m) {
      m = new Map()
      this.refMaps.set(owner, m)
    }
    return m
  }

  private ownerPrefixes(owner: string): Map<string, string> {
    let m = this.prefixMaps.get(owner)
    if (!m) {
      m = new Map()
      this.prefixMaps.set(owner, m)
    }
    return m
  }

  // Close every pane a task owns — called when the task is deleted or made
  // private, BEFORE its folder moves (a parked PDF pane holds a file handle
  // into the folder, which makes the Windows rename fail).
  closeByOwner(owner: string): void {
    for (const [paneId, pane] of [...this.panes]) {
      if (pane.owner === owner) this.close(paneId)
    }
    this.refMaps.delete(owner)
    this.prefixMaps.delete(owner)
  }

  private capturScript(prefix: string): string {
    return `(() => {
      // Real apps (VS Code, Kaggle, ...) build "buttons" from divs with ARIA
      // roles — capture those too, not just native form elements.
      const selector = 'input, textarea, select, button, [contenteditable="true"], a[href], ' +
        '[role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="tab"], ' +
        '[role="option"], [role="checkbox"], [role="radio"], [role="combobox"], ' +
        '[role="link"], [role="treeitem"], [role="switch"]'
      const seen = new Set()
      const all = Array.from(document.querySelectorAll(selector)).filter(el => {
        if (seen.has(el)) return false
        seen.add(el)
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden' && (r.width > 0 || r.height > 0)
      })
      // ON-SCREEN FIRST, then the rest. A flat DOM-order cut is what broke
      // Google Calendar: its month grid is hundreds of role="button" cells, so
      // a plain slice(0, 350) spent the whole budget on day squares and the
      // agent never saw the toolbar it needed. What the user can see is what
      // the agent should get.
      const onScreen = [], offScreen = []
      for (const el of all) {
        const r = el.getBoundingClientRect()
        ;(r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? onScreen : offScreen).push(el)
      }
      const CAP = 400
      const interactive = onScreen.slice(0, CAP).concat(offScreen.slice(0, Math.max(0, CAP - onScreen.length)))
      const omitted = all.length - interactive.length
      const elements = interactive.map((el, i) => {
        const ref = '${prefix}e' + i
        el.setAttribute('data-asit-ref', ref)
        const role = el.getAttribute('role')
        const label =
          el.getAttribute('aria-label') ||
          (el.labels && el.labels[0] && el.labels[0].innerText) ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          (role || el.tagName === 'BUTTON' || el.tagName === 'A' ? (el.innerText || '').slice(0, 80) : '') ||
          el.getAttribute('name') ||
          el.id || ''
        const entry = {
          ref,
          tag: role ? el.tagName.toLowerCase() + '[' + role + ']' : el.tagName.toLowerCase(),
          type: el.getAttribute('type') || (el.isContentEditable ? 'contenteditable' : null),
          label: String(label).replace(/\\s+/g, ' ').trim().slice(0, 120),
          value: (function () {
            // NEVER hand a secret to the model. Password inputs (and anything
            // marked as a one-time code) report only whether they are filled —
            // the agent still learns the form state, never the value. Autofill
            // puts real credentials in these fields, so this is load-bearing.
            var t = (el.getAttribute('type') || '').toLowerCase();
            var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
            if (t === 'password' || ac.indexOf('one-time-code') !== -1 || ac.indexOf('current-password') !== -1 || ac.indexOf('new-password') !== -1) {
              return el.value ? '[hidden credential — filled]' : '';
            }
            return typeof el.value === 'string' ? el.value.slice(0, 300) : (el.isContentEditable ? (el.innerText || '').slice(0, 300) : null);
          })(),
          options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 40).map(o => o.value || o.text) : undefined,
          href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 200) : undefined
        }
        return entry
      })
      return {
        title: document.title,
        text: document.body ? document.body.innerText.slice(0, 20000) : '',
        elements,
        omitted
      }
    })()`
  }

  /**
   * Owner-filtered read model for the context header (services/context.ts):
   * which pages a task has open, without capturing any content. Same
   * ownership rule as every other AI-facing method (invariant 6).
   */
  listForOwner(owner: string): { paneId: string; url: string; title: string; visible: boolean }[] {
    const out: { paneId: string; url: string; title: string; visible: boolean }[] = []
    for (const [paneId, pane] of this.panes) {
      if (pane.owner !== owner) continue
      const url = pane.view.webContents.getURL()
      if (!/^https?:/i.test(url)) continue
      out.push({
        paneId,
        url,
        title: pane.view.webContents.getTitle(),
        visible: pane.desiredVisible
      })
    }
    return out
  }

  /** The task whose panes are on screen right now (null = none visible). */
  visibleOwner(): string | null {
    for (const [, pane] of this.panes) {
      if (pane.desiredVisible) return pane.owner
    }
    return null
  }

  async snapshotAll(taskFolder: string, owner: string): Promise<number> {
    const pagesDir = join(taskFolder, '.asit', 'pages')
    mkdirSync(pagesDir, { recursive: true })
    for (const f of readdirSync(pagesDir)) rmSync(join(pagesDir, f), { force: true })
    const refs = this.ownerRefs(owner)
    const prefixes = this.ownerPrefixes(owner)
    refs.clear()
    prefixes.clear()

    let count = 0
    let paneIndex = 0
    for (const [paneId, pane] of this.panes) {
      if (pane.owner !== owner) continue // other workspaces' tabs are invisible
      const url = pane.view.webContents.getURL()
      if (!/^https?:/i.test(url)) continue
      paneIndex++
      const prefix = `p${paneIndex}`

      // A pane showing a PDF: DOM capture sees only viewer chrome. Download
      // + extract the text instead and point the model at it.
      if (/\.pdf([?#]|$)/i.test(url)) {
        prefixes.set(prefix, paneId)
        try {
          const { ensureWebPdfText } = await import('./resources')
          const txt = await ensureWebPdfText(taskFolder, url)
          const { basename } = await import('path')
          const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '')
          writeFileSync(
            join(pagesDir, `page-${paneIndex}-${host}.md`),
            [
              `# Page ${paneIndex}: PDF document`,
              `URL: ${url}`,
              '',
              txt
                ? `This pane shows a PDF. Its FULL TEXT is extracted at \`pdfs/${basename(txt)}\` — Read that file for the content.`
                : 'This pane shows a PDF, but text extraction failed (possibly a scanned/image PDF).'
            ].join('\n')
          )
          count++
        } catch (err) {
          console.error('pdf pane snapshot failed:', err)
        }
        continue
      }

      try {
        interface CaptureResult {
          title: string
          text: string
          elements: {
            ref: string
            tag: string
            type: string | null
            label: string
            value: string | null
            options?: string[]
            href?: string
          }[]
          omitted?: number
        }

        // Capture EVERY frame in the page tree — course platforms, editors,
        // and embeds routinely render the real content inside iframes that
        // top-frame scripts can't see.
        const frames = pane.view.webContents.mainFrame.framesInSubtree.slice(0, 15)
        const sections: { fi: number; url: string; result: CaptureResult }[] = []
        for (let fi = 0; fi < frames.length; fi++) {
          try {
            const result = (await frames[fi].executeJavaScript(
              this.capturScript(`${prefix}f${fi}`),
              true
            )) as CaptureResult
            if (result && (result.elements.length > 0 || result.text.trim().length > 0)) {
              for (const el of result.elements) refs.set(el.ref, paneId)
              sections.push({ fi, url: frames[fi].url, result })
            }
          } catch {
            // frame gone / inaccessible — skip
          }
        }
        prefixes.set(prefix, paneId)
        if (sections.length === 0) continue

        const main = sections[0]
        const lines = [
          `# Page ${paneIndex}: ${main.result.title || url}`,
          `URL: ${url}`,
          sections.length > 1
            ? `(${sections.length - 1} embedded frame(s) captured below — their content is part of this page)`
            : '',
          '',
          '## Interactive elements (use the [ref] with page_fill / page_click / page_select actions)',
          ''
        ]
        for (const section of sections) {
          if (section.fi > 0) {
            lines.push('', `### In embedded frame ${section.fi} (${section.url.slice(0, 120)})`, '')
          }
          if (section.result.omitted && section.result.omitted > 0) {
            lines.push(
              `_(${section.result.omitted} more off-screen element(s) not listed — scroll the page and snapshot again to reach them.)_`,
              ''
            )
          }
          for (const el of section.result.elements) {
            const bits = [`[${el.ref}] ${el.tag}${el.type ? `(${el.type})` : ''}`]
            if (el.label) bits.push(`"${el.label}"`)
            // The capture script already replaced password/OTP values with a
            // placeholder — belt and braces in case `type` says otherwise.
            if (el.value) {
              bits.push(
                (el.type ?? '').toLowerCase() === 'password'
                  ? '— current value: [hidden credential]'
                  : `— current value: "${el.value}"`
              )
            }
            if (el.options) bits.push(`— options: ${el.options.join(' | ').slice(0, 300)}`)
            if (el.href) bits.push(`— href: ${el.href}`)
            lines.push(`- ${bits.join(' ')}`)
          }
        }
        lines.push('', '## Page text', '', main.result.text)
        for (const section of sections.slice(1)) {
          lines.push(
            '',
            `## Embedded frame ${section.fi} text (${section.url.slice(0, 120)})`,
            '',
            section.result.text
          )
        }

        const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '')
        writeFileSync(join(pagesDir, `page-${paneIndex}-${host}.md`), lines.join('\n'))
        count++
      } catch (err) {
        console.error('page snapshot failed for', url, err)
      }
    }
    return count
  }

  async interact(
    owner: string,
    ref: string,
    op: 'fill' | 'click' | 'select',
    value?: string
  ): Promise<string> {
    // Refs are app-assigned (p<N>[f<N>]e<N>). Rejecting anything else also
    // blocks script injection via a hostile page echoing a poisoned "ref".
    const refMatch = ref.match(/^p\d{1,4}(?:f(\d{1,3}))?e\d{1,4}$/)
    if (!refMatch) return `invalid ref "${ref.slice(0, 40)}"`
    const frameIndex = refMatch[1] ? Number(refMatch[1]) : 0
    const paneId = this.ownerRefs(owner).get(ref)
    if (!paneId) return `unknown ref ${ref} — run page_snapshot first`
    const pane = this.panes.get(paneId)
    if (!pane) return `pane for ${ref} is gone`
    if (pane.owner !== owner) return `unknown ref ${ref} — run page_snapshot first` // stale ref from another workspace's snapshot
    const frames = pane.view.webContents.mainFrame.framesInSubtree
    const frame = frames[frameIndex]
    if (!frame) return `frame ${frameIndex} is gone — run page_snapshot`

    // Mail "Send" is the one click that can't be undone. Read the element's
    // own label and refuse if it fires mail without user authorization.
    if (op === 'click' && isMailHost(pane.view.webContents.getURL())) {
      const label = (await frame
        .executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-asit-ref=${JSON.stringify(ref)}]')
            if (!el) return ''
            return (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.innerText || '').slice(0, 80)
          })()`,
          true
        )
        .catch(() => '')) as string
      if (mailSendBlocked(pane.view.webContents.getURL(), label)) {
        return `BLOCKED: "${label.trim().slice(0, 40)}" would send mail. ${sendRefusalReason('email')}`
      }
    }

    if (op === 'click') {
      const how = await this.clickTagged(
        pane.view.webContents,
        frame,
        frameIndex,
        `[data-asit-ref=${JSON.stringify(ref)}]`
      )
      return how
        ? `clicked ${ref} (${how})`
        : `could not click ${ref} — it is gone or off-screen (run page_snapshot)`
    }

    const escaped = JSON.stringify(value ?? '')
    const script = `(() => {
      const el = document.querySelector('[data-asit-ref=${JSON.stringify(ref)}]')
      if (!el) return 'element not found (page may have changed — run page_snapshot)'
      const op = ${JSON.stringify(op)}
      const value = ${escaped}
      if (op === 'select') {
        el.value = value
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return 'selected ' + value
      }
      // fill
      el.focus()
      if (el.isContentEditable) {
        el.innerText = value
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
        return 'filled'
      }
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')
      if (setter && setter.set) setter.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return 'filled'
    })()`
    try {
      // Runs in the element's own frame (fill/select work fine in iframes).
      return String(await frame.executeJavaScript(script, true))
    } catch (err) {
      return `interaction failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // ---------------------------------------------------------------------
  // Label-based targeting: site-independent and reload-proof. Elements are
  // found at execution time by aria-label/visible text, so recorded flows
  // replay deterministically without a model in the loop.
  // ---------------------------------------------------------------------

  private static INTERACTIVE_SELECTOR =
    'input, textarea, select, button, a[href], [contenteditable="true"], ' +
    '[role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="tab"], ' +
    '[role="option"], [role="checkbox"], [role="radio"], [role="combobox"], ' +
    '[role="link"], [role="treeitem"], [role="switch"]'

  /**
   * Click an element a find script has already tagged — and be honest about it.
   *
   * "Read a rect, send a mouse event" fails two ways, and both used to report
   * success, which is worse than failing outright because the agent then moves
   * on believing the page advanced:
   *   * the page reports CSS pixels but sendInputEvent takes DIP, and those
   *     diverge the moment page zoom isn't 100% — at 120% a click aimed at a
   *     button 292px down lands ~58px above it, on whatever is behind;
   *   * something can be on top of the point (sticky footer, consent banner,
   *     an open menu). Google Forms' "Next" sits under exactly that kind of bar.
   * So hit-test the point first and only send OS input when the element really
   * is under it; otherwise dispatch the pointer sequence on the element. Screen
   * coordinates don't cross frame boundaries either, so subframes always take
   * the synthetic path.
   *
   * Returns how the click was delivered, or null if it could not be delivered
   * at all — never a bare "clicked".
   */
  private async clickTagged(
    wc: WebContents,
    frame: WebFrameMain,
    frameIndex: number,
    selector: string
  ): Promise<string | null> {
    const sel = JSON.stringify(selector)
    const probe = (await frame
      .executeJavaScript(
        `(() => {
          const el = document.querySelector(${sel})
          if (!el) return null
          // INSTANT, not smooth: a smooth scroll animates, so the rect read
          // next is stale and the click lands somewhere else.
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
          const r = el.getBoundingClientRect()
          if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null
          const x = r.x + r.width / 2, y = r.y + r.height / 2
          // Only the TOPMOST element matters — that is who Chromium would
          // hand the click to. Accepting any ancestor in the stack is the
          // trap: <body> is always in it and always contains the target, so
          // every covered element read as reachable.
          const top = document.elementFromPoint(x, y)
          const reachable = !!top && (top === el || el.contains(top))
          return { x, y, reachable }
        })()`,
        true
      )
      .catch(() => null)) as { x: number; y: number; reachable: boolean } | null
    if (!probe) return null

    if (frameIndex === 0 && probe.reachable) {
      // Real OS input: synthetic el.click() doesn't fire the pointer listeners
      // frameworks like VS Code's workbench actually use.
      const zoom = wc.getZoomFactor() || 1
      const x = Math.round(probe.x * zoom)
      const y = Math.round(probe.y * zoom)
      wc.focus()
      wc.sendInputEvent({ type: 'mouseMove', x, y })
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      return `real input at ${x},${y}`
    }

    const hit = await frame
      .executeJavaScript(
        `(() => {
          const el = document.querySelector(${sel})
          if (!el) return false
          const r = el.getBoundingClientRect()
          const opts = { bubbles: true, cancelable: true, composed: true, view: window,
                         clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
          if (el.focus) el.focus()
          el.dispatchEvent(new PointerEvent('pointerdown', opts))
          el.dispatchEvent(new MouseEvent('mousedown', opts))
          el.dispatchEvent(new PointerEvent('pointerup', opts))
          el.dispatchEvent(new MouseEvent('mouseup', opts))
          el.click()
          return true
        })()`,
        true
      )
      .catch(() => false)
    if (!hit) return null
    return frameIndex === 0
      ? 'synthetic click — the point was covered by something on top'
      : `synthetic click in frame ${frameIndex}`
  }

  private labelFindScript(label: string, fillValue?: string): string {
    return `(() => {
      // Clear last run's tag first, so a stale one can never be clicked.
      document.querySelectorAll('[data-asit-flow-target]').forEach(e => e.removeAttribute('data-asit-flow-target'))
      const target = ${JSON.stringify(label.toLowerCase().trim())}
      const els = Array.from(document.querySelectorAll(${JSON.stringify(PaneManager.INTERACTIVE_SELECTOR)})).filter(el => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' &&
               (r.width > 0 || r.height > 0) && !el.disabled && el.getAttribute('aria-hidden') !== 'true'
      })
      const labelOf = el => (
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
        (el.innerText || '') || el.value || el.getAttribute('name') || el.id || ''
      ).replace(/\s+/g, ' ').trim().toLowerCase()

      // SCORE candidates instead of taking the first loose match. "first
      // includes() wins" picked giant wrapper divs whose text happened to
      // contain the label, so clicks landed on the wrong thing and the agent
      // had to be re-prompted. Prefer exact names, real controls, and the
      // SMALLEST element that matches (the button, not its container).
      let best = null, bestScore = -1
      for (const el of els) {
        const name = labelOf(el)
        if (!name) continue
        let score = -1
        if (name === target) score = 100
        else if (name.startsWith(target)) score = 70
        else if (name.includes(target)) score = 40
        else continue
        const tag = el.tagName.toLowerCase()
        const role = (el.getAttribute('role') || '').toLowerCase()
        if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link') score += 12
        if (tag === 'input' || tag === 'select' || tag === 'textarea') score += 10
        // Tie-break toward tighter elements: a 40-char name matching a 4-char
        // target is a worse hit than an exact-length one.
        score -= Math.min(20, Math.floor(name.length / 12))
        const r = el.getBoundingClientRect()
        score -= Math.min(10, Math.floor((r.width * r.height) / 40000))
        if (score > bestScore) { bestScore = score; best = el }
      }
      const el = best
      if (!el) return null
      el.setAttribute('data-asit-flow-target', '')
      ${
        fillValue !== undefined
          ? `
      el.focus()
      if (el.isContentEditable) {
        el.innerText = ${JSON.stringify(fillValue)}
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
        return { filled: true }
      }
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(fillValue)})
      else el.value = ${JSON.stringify(fillValue)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { filled: true }`
          : `
      // INSTANT, not smooth: a smooth scroll animates, so the rect we read
      // next was stale and the synthetic click landed somewhere else.
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      // Off-screen after scrolling (sticky header, virtualised list) — report
      // so the caller can retry rather than clicking empty space.
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`
      }
    })()`
  }

  /**
   * Find a target, RETRYING briefly. Pages render asynchronously — a button
   * that exists 300ms from now used to be reported as "not found", and the
   * agent had to be told to snapshot and try again. Polling here is what
   * turns "usually needs another nudge" into "just worked".
   */
  private async findWithRetry<T>(
    run: () => Promise<T | null>,
    timeoutMs = 4000
  ): Promise<T | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = await run()
      if (hit) return hit
      if (Date.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, 220))
    }
  }

  private urlViews(owner: string, pageIndex?: number): WebContentsView[] {
    const views = [...this.panes.values()]
      .filter((p) => p.owner === owner)
      .map((p) => p.view)
      .filter((v) => /^https?:/i.test(v.webContents.getURL()))
    if (pageIndex && pageIndex >= 1 && pageIndex <= views.length) return [views[pageIndex - 1]]
    return views
  }

  // Passive presence check (no scrolling, no attributes) — cheap enough to
  // poll every few seconds for watch conditions.
  // 'label': an ENABLED, visible interactive element with that label —
  //   disabled buttons don't count (course players keep "Continue" in the DOM
  //   but disabled during the video; counting it made watches fire instantly).
  // 'text': the string appears anywhere in the page's visible text.
  async existsCondition(
    owner: string,
    cond: { label?: string; text?: string },
    pageIndex?: number
  ): Promise<boolean> {
    const probe = cond.label
      ? `(() => {
          const target = ${JSON.stringify(cond.label.toLowerCase().trim())}
          const els = document.querySelectorAll(${JSON.stringify(PaneManager.INTERACTIVE_SELECTOR)})
          for (const el of els) {
            const r = el.getBoundingClientRect()
            if (r.width === 0 && r.height === 0) continue
            const s = getComputedStyle(el)
            if (s.display === 'none' || s.visibility === 'hidden') continue
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
            if (s.pointerEvents === 'none') continue
            const l = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '') || el.getAttribute('name') || '')
              .replace(/\\s+/g, ' ').trim().toLowerCase()
            if (l === target || l.includes(target)) return true
          }
          return false
        })()`
      : `(() => {
          const target = ${JSON.stringify((cond.text ?? '').toLowerCase().trim())}
          if (!target || !document.body) return false
          return document.body.innerText.toLowerCase().includes(target)
        })()`
    for (const view of this.urlViews(owner, pageIndex)) {
      const frames = view.webContents.mainFrame.framesInSubtree.slice(0, 15)
      for (const frame of frames) {
        try {
          if (await frame.executeJavaScript(probe, true)) return true
        } catch {
          // frame inaccessible
        }
      }
    }
    return false
  }

  async existsByLabel(owner: string, label: string, pageIndex?: number): Promise<boolean> {
    return this.existsCondition(owner, { label }, pageIndex)
  }

  async clickByLabel(owner: string, label: string, pageIndex?: number): Promise<string> {
    for (const view of this.urlViews(owner, pageIndex)) {
      if (mailSendBlocked(view.webContents.getURL(), label)) {
        return `BLOCKED: clicking "${label}" would send mail. ${sendRefusalReason('email')}`
      }
      const frames = view.webContents.mainFrame.framesInSubtree.slice(0, 15)
      for (let fi = 0; fi < frames.length; fi++) {
        try {
          const found = await this.findWithRetry(
            () => frames[fi].executeJavaScript(this.labelFindScript(label), true) as Promise<unknown>
          )
          if (!found) continue
          const how = await this.clickTagged(
            view.webContents,
            frames[fi],
            fi,
            '[data-asit-flow-target]'
          )
          if (!how) continue
          return `clicked "${label}" (${how})`
        } catch {
          // try next frame
        }
      }
    }
    return `no visible element matching "${label}"`
  }

  async fillByLabel(owner: string, label: string, value: string, pageIndex?: number): Promise<string> {
    for (const view of this.urlViews(owner, pageIndex)) {
      const frames = view.webContents.mainFrame.framesInSubtree.slice(0, 15)
      for (const frame of frames) {
        try {
          // Same retry as clicking: a field that mounts a moment later used
          // to come back "not found" and cost the user another prompt.
          const result = await this.findWithRetry(
            () =>
              frame.executeJavaScript(this.labelFindScript(label, value), true) as Promise<{
                filled?: boolean
              } | null>
          )
          if (result) return `filled "${label}"`
        } catch {
          // try next frame
        }
      }
    }
    return `no visible field matching "${label}"`
  }

  keyToPage(owner: string, pageIndex: number | undefined, key: string): string {
    const views = this.urlViews(owner, pageIndex)
    if (views.length === 0) return 'no browser pane open in this workspace'
    // Ctrl+Enter is Gmail's send shortcut — the keyboard route to the same
    // irreversible action the button guard blocks.
    if (mailSendBlocked(views[0].webContents.getURL(), key)) {
      return `BLOCKED: "${key}" sends mail. ${sendRefusalReason('email')}`
    }
    return this.sendKeyToView(views[0], key)
  }

  typeToPage(owner: string, pageIndex: number | undefined, text: string): Promise<string> {
    const views = this.urlViews(owner, pageIndex)
    if (views.length === 0) return Promise.resolve('no browser pane open in this workspace')
    return this.typeToView(views[0], text)
  }

  async navigateFlow(owner: string, url: string, pageIndex?: number): Promise<string> {
    // http(s) ONLY. An agent navigating a pane to file:// and snapshotting it
    // would read arbitrary local files straight past every cwd sandbox — this
    // is the single most valuable move a prompt-injected agent could make.
    if (!/^https?:\/\//i.test(url)) return `navigate refused: only http(s) URLs (got "${url.slice(0, 40)}")`
    const views = this.urlViews(owner, pageIndex)
    if (views.length === 0) return 'no browser pane open in this workspace to navigate'
    const wc = views[0].webContents
    await wc.loadURL(url).catch(() => undefined)
    return `navigated to ${url}`
  }

  /**
   * Type text into the page that currently has focus. Dictation needs this:
   * app DOM cannot reach inside a WebContentsView, so when the caret is in an
   * embedded page the renderer hands the words here instead.
   *
   * NOT agent-reachable, and not an oversight that it isn't — this types into
   * whatever the USER is focused on, with no owner scoping, which is exactly
   * the thing every AI-facing pane method is careful to prevent. It is driven
   * only by the dictation session the user started.
   */
  insertTextIntoFocused(text: string): boolean {
    const paneId = this.focusedPaneId
    if (!paneId) return false
    const pane = this.panes.get(paneId)
    if (!pane || pane.view.webContents.isDestroyed()) return false
    // insertText goes through the same path as real typing, so React-based
    // editors see it; setting .value from a script does not.
    pane.view.webContents.insertText(String(text).slice(0, 2000))
    return true
  }

  /** Smoke tests only — where every visible pane actually sits, in DIP. */
  boundsForSmoke(): [string, { x: number; y: number; width: number; height: number }][] {
    return [...this.panes.entries()]
      .filter(([, p]) => p.desiredVisible)
      .map(([id, p]) => [id, p.view.getBounds()] as [
        string,
        { x: number; y: number; width: number; height: number }
      ])
  }

  /** Smoke tests only — reach a pane directly to assert on real page state. */
  viewForSmoke(paneId: string): WebContentsView | null {
    return this.panes.get(paneId)?.view ?? null
  }

  private paneForRef(owner: string, refOrPrefix: string): WebContentsView | null {
    const prefix = refOrPrefix.match(/^p\d{1,4}/)?.[0]
    if (!prefix) return null
    const paneId = this.ownerRefs(owner).get(refOrPrefix) ?? this.ownerPrefixes(owner).get(prefix)
    if (!paneId) return null
    const pane = this.panes.get(paneId)
    return pane && pane.owner === owner ? pane.view : null
  }

  // Keyboard shortcut as REAL input (e.g. "Ctrl+Shift+P", "Enter", "F1") —
  // command palettes reach everything a mouse can, more reliably.
  private sendKeyToView(view: WebContentsView, key: string): string {
    const parts = String(key).split('+').map((p) => p.trim())
    const keyCode = parts[parts.length - 1]
    if (!keyCode || keyCode.length > 20) return `invalid key "${key}"`
    const modifiers: Array<'control' | 'shift' | 'alt' | 'meta'> = []
    for (const p of parts.slice(0, -1)) {
      const m = p.toLowerCase()
      if (m === 'ctrl' || m === 'control') modifiers.push('control')
      else if (m === 'shift') modifiers.push('shift')
      else if (m === 'alt') modifiers.push('alt')
      else if (m === 'meta' || m === 'cmd' || m === 'win') modifiers.push('meta')
    }
    const wc = view.webContents
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1 && modifiers.every((m) => m === 'shift')) {
      wc.sendInputEvent({ type: 'char', keyCode })
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    return `sent ${key}`
  }

  // Type text into whatever has focus in the page (real char input, fast).
  private async typeToView(view: WebContentsView, text: string): Promise<string> {
    const wc = view.webContents
    wc.focus()
    const chars = String(text).slice(0, 500)
    for (const ch of chars) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await new Promise((r) => setTimeout(r, 8)) // brief pacing; some UIs debounce input
    }
    return `typed ${chars.length} chars`
  }

  async sendKey(owner: string, refOrPrefix: string, key: string): Promise<string> {
    const view = this.paneForRef(owner, refOrPrefix)
    if (!view) return `no pane matching "${refOrPrefix}" — run page_snapshot first`
    if (mailSendBlocked(view.webContents.getURL(), key)) {
      return `BLOCKED: "${key}" sends mail. ${sendRefusalReason('email')}`
    }
    return this.sendKeyToView(view, key)
  }

  async typeText(owner: string, refOrPrefix: string, text: string): Promise<string> {
    const view = this.paneForRef(owner, refOrPrefix)
    if (!view) return `no pane matching "${refOrPrefix}" — run page_snapshot first`
    return this.typeToView(view, text)
  }
}

export const paneManager = new PaneManager()

