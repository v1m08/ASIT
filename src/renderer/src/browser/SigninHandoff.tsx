import { useStore } from '../store/useStore'

// Google refuses to run its sign-in CEREMONY inside any embedded browser (the
// "this browser or app may not be secure" wall). That is a deliberate account-
// security control applying to every Electron app, not just this one, and
// there is no user-agent or window trick that legitimately clears it.
//
// Nor can it be worked around by moving cookies: the browsers Google TRUSTS
// encrypt their cookie stores against every other app, so the only jar ASIT
// can read is its own, and the two sets do not overlap by design.
//
// So the honest path is the one the user actually wants — open it in their
// REAL browser, where they are already trusted and signed in. This lives in
// the shell rather than in one browsing surface because there is only one
// shell now, and the wall can appear in any group.

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

export default function SigninHandoff(): JSX.Element | null {
  const url = useStore((s) => s.activePageUrl)
  const paneId = useStore((s) => s.activePaneId)
  if (!url || !isGoogleSigninWall(url)) return null
  const dest = signinDestination(url)
  return (
    <div className="signin-handoff">
      <span>
        Google won’t let you sign in inside an app — it blocks every embedded browser. Open it in
        your real browser, where you’re already trusted.
      </span>
      <button
        className="btn btn-primary"
        onClick={() => void window.asit.resources.openExternal({ url: dest })}
      >
        Open in my browser ↗
      </button>
      <button
        className="btn btn-ghost"
        title="Try ASIT’s own sign-in window (shares this profile, but Google may still refuse it)"
        onClick={async () => {
          await window.asit.accounts.openLogin('google')
          if (paneId) window.asit.panes.navigate(paneId, { nav: 'reload' })
        }}
      >
        Try in-app window
      </button>
    </div>
  )
}
