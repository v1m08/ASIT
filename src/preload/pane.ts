/// <reference lib="dom" />
import { ipcRenderer } from 'electron'

// Injected into every embedded web pane (isolated world — the page can't see
// or call any of this). Makes "/KEY " snippets expand inside ANY form on any
// website, exactly like they do in the app's own inputs.

let snippets: Record<string, string> = {}
let fetchedAt = 0

async function ensureSnippets(): Promise<void> {
  if (Date.now() - fetchedAt < 15000) return
  try {
    snippets = (await ipcRenderer.invoke('snippets:get')) ?? {}
  } catch {
    // main not ready — try again next time
  }
  fetchedAt = Date.now()
}

const TEXT_TYPES = new Set(['', 'text', 'email', 'search', 'url', 'tel', 'password', 'number'])

// Declutter Google SEARCH pages inside narrow panes: hide the left filter
// rail so results get the full width. Scoped to google.*/search only —
// Gmail/Drive navs are untouched.
function injectGoogleDeclutter(): void {
  if (!/(^|\.)google\.[a-z.]+$/.test(location.hostname)) return
  if (!location.pathname.startsWith('/search')) return
  const style = document.createElement('style')
  style.textContent = `
    #lhs, #leftnav, [id="before-appbar"], div[role="navigation"][aria-label*="ilter"] { display: none !important; }
    #center_col, #rcnt { margin-left: 0 !important; }
  `
  document.documentElement.appendChild(style)
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', injectGoogleDeclutter)
} else {
  injectGoogleDeclutter()
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

window.addEventListener(
  'input',
  async (e: Event) => {
    const target = e.target as HTMLElement | null
    if (!target) return

    // Standard inputs / textareas
    if (
      (target instanceof HTMLInputElement && TEXT_TYPES.has((target.type || '').toLowerCase())) ||
      target instanceof HTMLTextAreaElement
    ) {
      const el = target as HTMLInputElement
      const pos = el.selectionStart ?? el.value.length
      const before = el.value.slice(0, pos)
      const m = before.match(/\/([A-Za-z0-9_-]+)( )$/)
      if (!m) return
      await ensureSnippets()
      const value = snippets[m[1]]
      if (value === undefined || value.includes(`/${m[1]}`)) return
      const start = pos - m[0].length
      setNativeValue(el, el.value.slice(0, start) + value + ' ' + el.value.slice(pos))
      const caret = start + value.length + 1
      try {
        el.setSelectionRange(caret, caret)
      } catch {
        // number inputs reject setSelectionRange
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return
    }

    // contenteditable editors (docs, rich comment boxes)
    if (target.isContentEditable) {
      const sel = window.getSelection()
      if (!sel || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) return
      const node = sel.anchorNode as Text
      const before = node.data.slice(0, sel.anchorOffset)
      const m = before.match(/\/([A-Za-z0-9_-]+)([  ])$/)
      if (!m) return
      await ensureSnippets()
      const value = snippets[m[1]]
      if (value === undefined || value.includes(`/${m[1]}`)) return
      const start = sel.anchorOffset - m[0].length
      node.replaceData(start, m[0].length, value + ' ')
      sel.collapse(node, start + value.length + 1)
      target.dispatchEvent(new Event('input', { bubbles: true }))
    }
  },
  true
)
