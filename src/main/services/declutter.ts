import type { WebContents } from 'electron'
import { getSettings } from './settings'

// Strip the chrome a site wraps around itself that means nothing inside a
// workspace pane: consent walls, "open in our app" interstitials, floating
// support-chat bubbles, sticky newsletter bars.
//
// This is COSMETIC and deliberately separate from browser.ts, which blocks at
// the network layer by domain. The two have different failure modes: a blocked
// domain silently costs you a subresource, while a hidden element can hide
// something you needed. So the rules here are limited to widgets that exist to
// interrupt you, never a site's own navigation — you cannot maintain per-app
// "hide their header" rules against apps that redesign twice a year, and a
// wrong one silently breaks a page.
//
// Anything beyond that is taste, so it is user-supplied: `declutterCss` in
// settings is appended verbatim, and `declutterExcludeHosts` turns the whole
// thing off for sites it fights with (some publishers hard-gate on consent).
//
// Agents see the page AFTER this runs, because the capture script skips
// display:none elements. That is the right way round — an agent that used to
// burn a turn clicking "Accept all cookies" now just doesn't see the banner.

const HIDE = [
  // Consent-management platforms, by their own stable container ids/classes.
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '#cookiescript_injected',
  '#usercentrics-root',
  '#didomi-host',
  '.qc-cmp2-container',
  '.osano-cm-window',
  '.truste_overlay',
  '.truste_box_overlay',
  '#hs-eu-cookie-confirmation',
  '#cookie-law-info-bar',
  '.cc-window',
  '.cookie-notice-container',
  '[aria-label="Cookie banner" i]',
  '[aria-label="Cookie Consent" i]',
  '[id*="cookie-banner" i]',
  '[class*="cookie-banner" i]',
  '[id*="cookie-consent" i]',
  '[class*="cookie-consent" i]',

  // Support-chat bubbles. Every one of these is a floating square that covers
  // the bottom-right corner of whatever you are reading.
  '#intercom-container',
  '.intercom-lightweight-app',
  '#drift-widget-container',
  '#hubspot-messages-iframe-container',
  '#launcher', // Zendesk web widget
  '#crisp-chatbox',
  '#tawkchat-container',
  '#tidio-chat',
  '#fc_frame', // Freshchat
  '#zsiq_float', // Zoho SalesIQ

  // "Get our app" / "continue in app" interstitials.
  '.branch-banner-iframe',
  '#branch-banner-iframe',
  '.smartbanner',
  '[class*="app-download-banner" i]',
  '[class*="open-in-app" i]'
]

/**
 * The sheet itself. `!important` throughout because these widgets set inline
 * styles from script; without it they simply repaint themselves.
 */
export function declutterCss(): string {
  const custom = (getSettings().declutterCss ?? '').slice(0, 20000)
  return [
    // ONE RULE PER SELECTOR, not a comma-joined list. A selector list is
    // all-or-nothing in CSS: a single malformed entry invalidates the whole
    // rule, so one typo in a hand-maintained list of thirty would silently
    // turn the entire feature off. Separate rules fail one at a time.
    ...HIDE.map((sel) => `${sel} { display: none !important; }`),
    // Consent walls usually lock the page behind them. Removing the wall
    // without this leaves a page you can see but cannot scroll, which is a
    // worse bug than the banner.
    'html.cookie-consent-open, body.cookie-consent-open,',
    'html[class*="no-scroll" i], body[class*="no-scroll" i],',
    'html[class*="scroll-lock" i], body[class*="scroll-lock" i],',
    'html[class*="modal-open" i], body[class*="modal-open" i] {',
    '  overflow: auto !important;',
    '  position: static !important;',
    '}',
    custom
  ].join('\n')
}

/** Hosts the user has opted out of, matched on host or parent domain. */
function excluded(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return true // not a normal page — leave it alone
  }
  return (getSettings().declutterExcludeHosts ?? []).some((raw) => {
    const d = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    return !!d && (host === d || host.endsWith('.' + d))
  })
}

// insertCSS returns a key we would need to remove the sheet again; we never
// remove per-page (navigation drops it), but we DO need to avoid stacking
// sheets when a SPA fires did-navigate-in-page repeatedly.
const applied = new WeakMap<WebContents, string>()

export async function applyDeclutter(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return

  const previous = applied.get(wc)
  if (previous) {
    await wc.removeInsertedCSS(previous).catch(() => undefined)
    applied.delete(wc)
  }
  if (!getSettings().declutter || excluded(url)) return

  try {
    applied.set(wc, await wc.insertCSS(declutterCss()))
  } catch {
    // page went away mid-navigation
  }
}
