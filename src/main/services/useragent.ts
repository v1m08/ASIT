import { app, session } from 'electron'

// Identifying as the browser we actually are.
//
// ASIT's panes are Chromium, so pages should treat them as Chromium. They
// didn't, and Google's sign-in refused with "this browser or app may not be
// secure", because what we reported about ourselves did not add up:
//
//   * the UA string claimed Chrome 139 while the engine was Chromium 130
//   * navigator.userAgentData listed only "Chromium", never "Google Chrome"
//   * no Sec-CH-UA request headers were sent at all
//   * on macOS the UA still claimed "Windows NT 10.0"
//
// Any one of those is a mismatch a sign-in flow can key on, and the version
// disagreement is the loudest: a real browser's UA string and its client
// hints always name the same build. So derive everything from the Chromium we
// are actually running, and say the same thing in every channel.
//
// This is a compatibility fix, not a disguise: it is the user's own browser
// signing into the user's own account, and the credentials and 2FA are
// entirely theirs. We simply stop describing ourselves inconsistently.

/**
 * The Chrome major we CLAIM. Consistency across channels is the load-bearing
 * part (see above) — but the version must also not be ancient: some sites
 * hard-refuse "outdated" Chrome (WhatsApp Web's update wall is exactly this
 * check), and Chromium 130 reads as a year old by late 2026. So claim
 * max(real, floor) — the SAME number in the UA string and every Sec-CH-UA
 * header — and raise the floor now and then until an Electron upgrade brings
 * the real engine current. (Google's sign-in block is NOT a version check —
 * see the note above browserUserAgent.)
 */
const MIN_CLAIMED_CHROME = 140

function chromeMajor(): string {
  const real = Number((process.versions.chrome ?? '130').split('.')[0])
  return String(Math.max(Number.isFinite(real) ? real : 130, MIN_CLAIMED_CHROME))
}

/** The platform token a real browser would use here. */
function platformToken(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7'
    case 'linux':
      return 'X11; Linux x86_64'
    default:
      return 'Windows NT 10.0; Win64; x64'
  }
}

/** Value for Sec-CH-UA-Platform — quoted, and matching the UA string. */
function platformHint(): string {
  switch (process.platform) {
    case 'darwin':
      return '"macOS"'
    case 'linux':
      return '"Linux"'
    default:
      return '"Windows"'
  }
}

export function browserUserAgent(): string {
  return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor()}.0.0.0 Safari/537.36`
}

// NOTE on Google sign-in (probed 2026-08-27, ASIT_SMOKE_GOOGLE=1): Google's
// "This browser or app may not be secure" wall is embedded-webview DETECTION,
// not a UA/version check. It appears at the password step regardless of the
// claimed identity, and spoofing as Firefox (header and/or navigator) did NOT
// reliably clear it — a single apparent pass turned out to be non-
// deterministic (cookie/IP/rate dependent), blocking on every repeat. This is
// Google's documented policy against OAuth in embedded browsers, and there is
// no reliable client-side bypass. ASIT handles it honestly with a real-
// browser handoff (ScratchBrowser's signin banner); no UA disguise is worth
// the fragility. Everything else on the partition stays consistent Chromium.

/**
 * The Sec-CH-UA brand list. Real Chrome sends a deliberately-shuffled trio
 * including a nonsense "Not;A=Brand" entry — sites that hard-code positions
 * break, which is the point of it existing.
 */
function brandList(): string {
  const v = chromeMajor()
  return `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="99"`
}

/**
 * Applies to the shared browse partition, where every embedded page and every
 * provider-login window lives. Headers only — `navigator.userAgentData` is
 * owned by Chromium and cannot be changed from the main process; it still
 * reports Chromium, which is honest and no longer contradicts anything.
 */
export function applyBrowserIdentity(partition: string): void {
  app.userAgentFallback = browserUserAgent()

  const ses = session.fromPartition(partition)
  ses.setUserAgent(browserUserAgent())
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    // Only for real web requests; leave anything else untouched.
    if (/^https?:/i.test(details.url)) {
      headers['sec-ch-ua'] = brandList()
      headers['sec-ch-ua-mobile'] = '?0'
      headers['sec-ch-ua-platform'] = platformHint()
      // Chromium omits the UA header on some internal requests; don't invent
      // one where there wasn't any.
      if (headers['User-Agent'] || headers['user-agent']) {
        delete headers['user-agent']
        headers['User-Agent'] = browserUserAgent()
      }
    }
    callback({ requestHeaders: headers })
  })
}
