import { session, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getSettings, setSettings } from './settings'

// Ad/tracker blocking + Chrome extensions for the embedded browser panes.
//
// Blocking is DOMAIN-level on the shared browse partition. That is deliberately
// not a full filter-list engine (no cosmetic rules, no regex EasyList parsing):
// domain blocking kills the requests that cost bandwidth, battery and tracking,
// with no per-request regex work on the hot path. Custom domains from settings
// are merged in, so anything missed can be added without a code change.

const BLOCKLIST = [
  // ad exchanges / serving
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'g.doubleclick.net', 'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com',
  'openx.net', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'sharethrough.com',
  'media.net', 'amazon-adsystem.com', 'casalemedia.com', 'smartadserver.com', 'teads.tv',
  'indexww.com', 'bidswitch.net', 'yieldmo.com', 'zemanta.com', '3lift.com', 'gumgum.com',
  'ad.doubleclick.net', 'adform.net', 'sonobi.com', 'districtm.io', 'appnexus.com',
  // analytics / tracking
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'googletagservices.com',
  'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mouseflow.com', 'fullstory.com',
  'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'heap.io', 'branch.io',
  'chartbeat.com', 'parsely.com', 'newrelic.com', 'nr-data.net', 'bugsnag.com',
  'crazyegg.com', 'luckyorange.com', 'inspectlet.com', 'clarity.ms', 'yandex.ru',
  // social trackers
  'facebook.net', 'connect.facebook.net', 'ads-twitter.com', 'analytics.tiktok.com',
  'ads.linkedin.com', 'px.ads.linkedin.com', 'bat.bing.com', 'ads.pinterest.com',
  // misc beacons
  'adroll.com', 'krxd.net', 'demdex.net', 'everesttech.net', 'omtrdc.net', 'moatads.com',
  'serving-sys.com', 'flashtalking.com', 'agkn.com', 'rlcdn.com', 'exelator.com'
]

let blockedCount = 0
let wired = false

/** Host matches the domain, or is a subdomain of it. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain)
}

function activeBlocklist(): string[] {
  const custom = (getSettings().blockedDomains ?? [])
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
  return [...BLOCKLIST, ...custom]
}

/**
 * Installed once on the browse partition. The handler stays installed and
 * checks the setting per request, so toggling takes effect immediately
 * without re-registering (Electron allows only one handler per session).
 */
export function initBrowserFilters(): void {
  if (wired) return
  wired = true
  const ses = session.fromPartition('persist:asit-browse')
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!getSettings().adBlock) return callback({})
    // Never block the page the user actually asked for — only subresources.
    if (details.resourceType === 'mainFrame') return callback({})
    let host: string
    try {
      host = new URL(details.url).hostname.toLowerCase()
    } catch {
      return callback({})
    }
    if (activeBlocklist().some((d) => hostMatches(host, d))) {
      blockedCount++
      return callback({ cancel: true })
    }
    callback({})
  })
}

export function blockedRequestCount(): number {
  return blockedCount
}

// --- Chrome extensions -----------------------------------------------------
//
// Electron supports UNPACKED extensions only (no Web Store install), and its
// support is partial — background service workers and many chrome.* APIs are
// missing, so complex extensions may not work. Content-script extensions
// (blockers, restylers, userscript hosts) generally do.

export async function loadExtensions(): Promise<{ loaded: string[]; failed: string[] }> {
  const ses = session.fromPartition('persist:asit-browse')
  const loaded: string[] = []
  const failed: string[] = []
  for (const path of getSettings().extensionPaths ?? []) {
    if (!existsSync(path)) {
      failed.push(path)
      continue
    }
    try {
      const ext = await ses.loadExtension(path, { allowFileAccess: false })
      loaded.push(ext.name)
    } catch {
      failed.push(path)
    }
  }
  return { loaded, failed }
}

export function listExtensions(): { name: string; id: string; path: string }[] {
  try {
    return session
      .fromPartition('persist:asit-browse')
      .getAllExtensions()
      .map((e: Electron.Extension) => ({ name: e.name, id: e.id, path: e.path }))
  } catch {
    return []
  }
}

/** Pick an unpacked extension folder and remember it across restarts. */
export async function addExtension(
  win: BrowserWindow | null
): Promise<{ ok: boolean; message: string }> {
  if (!win) return { ok: false, message: 'no window' }
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose an unpacked extension folder (the one with manifest.json)',
    properties: ['openDirectory']
  })
  if (res.canceled || res.filePaths.length === 0) return { ok: false, message: '' }
  const path = res.filePaths[0]
  if (!existsSync(join(path, 'manifest.json')))
    return { ok: false, message: 'That folder has no manifest.json — pick the unpacked extension root.' }
  try {
    const ses = session.fromPartition('persist:asit-browse')
    const ext = await ses.loadExtension(path, { allowFileAccess: false })
    const paths = getSettings().extensionPaths ?? []
    if (!paths.includes(path)) setSettings({ extensionPaths: [...paths, path] })
    return { ok: true, message: `Loaded ${ext.name}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function removeExtension(path: string): void {
  setSettings({ extensionPaths: (getSettings().extensionPaths ?? []).filter((p) => p !== path) })
  // Electron cannot unload cleanly in every version; it's gone next launch.
}
