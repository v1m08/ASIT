import { BrowserWindow, globalShortcut, WebContentsView } from 'electron'
import { pathToFileURL } from 'url'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc-contract'

// All embedded browser panes share one persistent partition so logins
// (Overleaf, Google, ...) survive restarts and are shared across tasks.
const BROWSE_PARTITION = 'persist:asit-browse'

export interface PaneTarget {
  url?: string
  filePath?: string
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

// Panes are PARKED (hidden, alive) when navigating away, not destroyed — so
// moving between tasks never reloads pages or interrupts anything running in
// them. An LRU cap keeps memory bounded.
const MAX_PANES = 14

// Navigation keys, taken at the OS level while an embedded page holds focus.
// `before-input-event` is not enough: it never fires for keys delivered to a
// cross-process subframe — Chromium's built-in PDF viewer, and any site that
// puts its editor in an iframe — which is why Tab used to walk the PDF's own
// controls instead of leaving the pane.
const NAV_ACCELERATORS: { accel: string; event: Record<string, unknown> }[] = [
  { accel: 'Tab', event: { type: 'cycle-focus', back: false } },
  { accel: 'Shift+Tab', event: { type: 'cycle-focus', back: true } },
  { accel: 'CommandOrControl+K', event: { type: 'focus-assistant' } },
  { accel: 'CommandOrControl+J', event: { type: 'focus-jarvis' } },
  { accel: 'CommandOrControl+L', event: { type: 'focus-address' } },
  ...Array.from({ length: 9 }, (_, i) => ({
    accel: `CommandOrControl+${i + 1}`,
    event: { type: 'focus-zone', index: i }
  }))
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

    // Allow popups (Google OAuth login flows need them); they share the
    // persistent session so completed logins land back in the pane.
    view.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))

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
      if (input.key === 'Tab' && !input.control && !input.alt && !input.meta) {
        event.preventDefault()
        this.sendAppEvent({ type: 'cycle-focus', back: input.shift })
        return
      }
      if (!input.control || input.alt || input.meta) return
      const k = input.key.toLowerCase()
      if (k === 'k') {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-assistant' })
      } else if (k === 'j') {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-jarvis' })
      } else if (k === 'l') {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-address' })
      } else if (/^[1-9]$/.test(k)) {
        event.preventDefault()
        this.sendAppEvent({ type: 'focus-zone', index: Number(k) - 1 })
      }
    })

    const pushNavState = (): void => {
      if (!this.win || this.win.isDestroyed()) return
      const wc = view.webContents
      this.win.webContents.send(IPC.PANES_DID_NAVIGATE, {
        paneId,
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
    }
    view.webContents.on('did-navigate', pushNavState)
    view.webContents.on('did-navigate-in-page', pushNavState)
    view.webContents.on('page-title-updated', pushNavState)

    if (target.url) {
      view.webContents.loadURL(target.url)
    } else if (target.filePath) {
      view.webContents.loadURL(pathToFileURL(target.filePath).href)
    }

    view.setVisible(false) // hidden until the renderer sends bounds
    this.win.contentView.addChildView(view)
    this.panes.set(paneId, { view, desiredVisible: false, lastActive: Date.now(), owner })
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
  }

  navigate(paneId: string, action: { url?: string; nav?: 'back' | 'forward' | 'reload' }): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    const wc = pane.view.webContents
    if (action.url) wc.loadURL(action.url)
    else if (action.nav === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action.nav === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward()
    else if (action.nav === 'reload') wc.reload()
  }

  close(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
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
      const interactive = Array.from(document.querySelectorAll(selector)).filter(el => {
        if (seen.has(el)) return false
        seen.add(el)
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return style.display !== 'none' && style.visibility !== 'hidden' && (r.width > 0 || r.height > 0)
      }).slice(0, 350)
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
          value: typeof el.value === 'string' ? el.value.slice(0, 300) : (el.isContentEditable ? (el.innerText || '').slice(0, 300) : null),
          options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 40).map(o => o.value || o.text) : undefined,
          href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 200) : undefined
        }
        return entry
      })
      return {
        title: document.title,
        text: document.body ? document.body.innerText.slice(0, 20000) : '',
        elements
      }
    })()`
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
          for (const el of section.result.elements) {
            const bits = [`[${el.ref}] ${el.tag}${el.type ? `(${el.type})` : ''}`]
            if (el.label) bits.push(`"${el.label}"`)
            if (el.value) bits.push(`— current value: "${el.value}"`)
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

    if (op === 'click') {
      if (frameIndex === 0) {
        // Top frame: REAL input events at the element's coordinates —
        // synthetic el.click() doesn't fire the pointer listeners frameworks
        // like VS Code's workbench actually use.
        const rect = (await frame.executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-asit-ref=${JSON.stringify(ref)}]')
            if (!el) return null
            el.scrollIntoView({ block: 'center', inline: 'center' })
            const r = el.getBoundingClientRect()
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          })()`,
          true
        )) as { x: number; y: number } | null
        if (!rect) return 'element not found (page may have changed — run page_snapshot)'
        const wc = pane.view.webContents
        wc.focus()
        wc.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
        wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
        return `clicked ${ref} (real input at ${Math.round(rect.x)},${Math.round(rect.y)})`
      }
      // Inside an iframe, coordinates don't map across the frame boundary —
      // dispatch a full synthetic pointer sequence IN the frame instead.
      const result = await frame
        .executeJavaScript(
          `(() => {
            const el = document.querySelector('[data-asit-ref=${JSON.stringify(ref)}]')
            if (!el) return null
            el.scrollIntoView({ block: 'center', inline: 'center' })
            const r = el.getBoundingClientRect()
            const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
            el.dispatchEvent(new PointerEvent('pointerdown', opts))
            el.dispatchEvent(new MouseEvent('mousedown', opts))
            el.dispatchEvent(new PointerEvent('pointerup', opts))
            el.dispatchEvent(new MouseEvent('mouseup', opts))
            el.click()
            return 'clicked'
          })()`,
          true
        )
        .catch(() => null)
      return result
        ? `clicked ${ref} (in frame ${frameIndex})`
        : 'element not found in frame — run page_snapshot'
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

  private labelFindScript(label: string, fillValue?: string): string {
    return `(() => {
      const target = ${JSON.stringify(label.toLowerCase().trim())}
      const els = Array.from(document.querySelectorAll(${JSON.stringify(PaneManager.INTERACTIVE_SELECTOR)})).filter(el => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0)
      })
      const labelOf = el => (
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
        (el.innerText || '') || el.getAttribute('name') || el.id || ''
      ).replace(/\\s+/g, ' ').trim().toLowerCase()
      const el = els.find(e => labelOf(e) === target) || els.find(e => labelOf(e).includes(target))
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
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`
      }
    })()`
  }

  // The acting task's browser panes, in snapshot order — page N here is the
  // same pane as "Page N" in that task's .asit/pages/. Owner-filtering is what
  // keeps one workspace's agent out of every other workspace's tabs.
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
      const frames = view.webContents.mainFrame.framesInSubtree.slice(0, 15)
      for (let fi = 0; fi < frames.length; fi++) {
        try {
          const rect = (await frames[fi].executeJavaScript(
            this.labelFindScript(label),
            true
          )) as { x: number; y: number } | null
          if (!rect) continue
          if (fi === 0) {
            const wc = view.webContents
            wc.focus()
            wc.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
            wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
            wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
            return `clicked "${label}"`
          }
          // Iframe hit: synthetic pointer sequence in-frame (coords don't
          // cross frame boundaries). The find script tagged the element with
          // data-asit-flow-target — VERIFY we actually dispatched on it; a
          // silent miss here used to report "clicked" for a no-op.
          const hit = await frames[fi].executeJavaScript(
            `(() => {
              const el = document.querySelector('[data-asit-flow-target]')
              if (!el) return false
              el.removeAttribute('data-asit-flow-target')
              const r = el.getBoundingClientRect()
              const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
              el.dispatchEvent(new PointerEvent('pointerdown', opts))
              el.dispatchEvent(new MouseEvent('mousedown', opts))
              el.dispatchEvent(new PointerEvent('pointerup', opts))
              el.dispatchEvent(new MouseEvent('mouseup', opts))
              el.click()
              return true
            })()`,
            true
          )
          if (!hit) continue
          return `clicked "${label}" (in frame ${fi})`
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
          const result = await frame.executeJavaScript(this.labelFindScript(label, value), true)
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
    return this.sendKeyToView(views[0], key)
  }

  typeToPage(owner: string, pageIndex: number | undefined, text: string): Promise<string> {
    const views = this.urlViews(owner, pageIndex)
    if (views.length === 0) return Promise.resolve('no browser pane open in this workspace')
    return this.typeToView(views[0], text)
  }

  async navigateFlow(owner: string, url: string, pageIndex?: number): Promise<string> {
    const views = this.urlViews(owner, pageIndex)
    if (views.length === 0) return 'no browser pane open in this workspace to navigate'
    const wc = views[0].webContents
    await wc.loadURL(url).catch(() => undefined)
    return `navigated to ${url}`
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
    return this.sendKeyToView(view, key)
  }

  async typeText(owner: string, refOrPrefix: string, text: string): Promise<string> {
    const view = this.paneForRef(owner, refOrPrefix)
    if (!view) return `no pane matching "${refOrPrefix}" — run page_snapshot first`
    return this.typeToView(view, text)
  }
}

export const paneManager = new PaneManager()

