import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

// Google refuses to run its sign-in CEREMONY inside any embedded browser (the
// "this browser or app may not be secure" wall). That is a deliberate account-
// security control applying to every Electron app, and no user-agent or window
// trick reliably clears it (see useragent.ts).
//
// Arc never meets it because Arc IS a Chromium browser. So ASIT borrows one:
// the sign-in bridge (main/services/signinbridge.ts) opens the user's own
// Chrome / Edge / Brave on a throwaway profile, they sign in there, and the
// session is imported into ASIT's browser profile — every group's tabs are
// then signed in. No Chromium-family browser installed → the old handoff
// (open the destination in their default browser) is all that's left.

function isGoogleSigninWall(url: string): boolean {
  return /accounts\.google\.com\/(v3\/signin|signin\/(rejected|identifier)|ServiceLogin)/i.test(url)
}

/** Where the user was actually trying to go, if the wall URL carries it. */
function signinDestination(wallUrl: string): string {
  try {
    const cont = new URL(wallUrl).searchParams.get('continue')
    if (cont && /^https?:\/\//i.test(cont)) return cont
  } catch {
    // malformed — fall through
  }
  return 'https://www.google.com/'
}

type Phase = { kind: 'idle' } | { kind: 'waiting' } | { kind: 'failed'; reason: string }

export default function SigninHandoff(): JSX.Element | null {
  const url = useStore((s) => s.activePageUrl)
  const paneId = useStore((s) => s.activePaneId)
  const [browser, setBrowser] = useState<string | null | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const onWall = !!url && isGoogleSigninWall(url)

  useEffect(() => {
    if (!onWall || browser !== undefined) return
    void window.asit.accounts.bridgeInfo().then((i) => setBrowser(i.browser))
  }, [onWall, browser])

  if (!url || (!onWall && phase.kind !== 'waiting')) return null
  const dest = signinDestination(url)

  async function bridge(): Promise<void> {
    setPhase({ kind: 'waiting' })
    // Sign in at Google's own entry point (never the wall URL itself — its
    // state is bound to the embedded attempt) and come back to `dest`.
    const signin = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(dest)}`
    const r = await window.asit.accounts.bridgeSignIn(signin)
    if (r.ok) {
      setPhase({ kind: 'idle' })
      if (paneId) window.asit.panes.navigate(paneId, { url: dest })
    } else {
      setPhase({
        kind: 'failed',
        reason: r.reason ?? 'sign-in did not finish'
      })
    }
  }

  if (phase.kind === 'waiting') {
    return (
      <div className="signin-handoff">
        <span>
          Finish signing in to Google in the {browser ?? 'browser'} window. ASIT brings the session
          back on its own as soon as you’re in — this window then closes.
        </span>
        <button
          className="btn"
          title="Import the session now (for when the browser didn’t close on its own)"
          onClick={() => void window.asit.accounts.bridgeFinish()}
        >
          I’m signed in
        </button>
        <button className="btn btn-ghost" onClick={() => void window.asit.accounts.bridgeCancel()}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="signin-handoff">
      <span>
        {phase.kind === 'failed'
          ? `That didn’t take (${phase.reason}). `
          : 'Google blocks sign-in inside embedded browsers. '}
        {browser
          ? `Sign in through ${browser} once — ASIT keeps the session, like any browser would.`
          : 'Open it in your real browser, where you’re already trusted.'}
      </span>
      {browser && (
        <button className="btn btn-primary" onClick={() => void bridge()}>
          Sign in with {browser}
        </button>
      )}
      <button
        className={browser ? 'btn btn-ghost' : 'btn btn-primary'}
        onClick={() => void window.asit.resources.openExternal({ url: dest })}
      >
        Open in my browser ↗
      </button>
    </div>
  )
}
