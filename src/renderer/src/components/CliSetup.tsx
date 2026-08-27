import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

// The Claude CLI status machine, shared by every surface that shows it (the
// header chip, Settings → AI engine, the first-run welcome). One copy, so the
// wording, the install flow, and the detection can never drift apart.
//
// Setup is TWO states, each with a one-click action:
//   installed?  → [Install automatically] runs the official native installer
//   signed in?  → [Sign in] opens a terminal running the CLI's own OAuth flow
// Both statuses poll while unsatisfied, so finishing either step flips the UI
// on its own — no "check again" button hunt.

export interface CliStatus {
  /** undefined = still checking, null = not found, string = resolved path. */
  path: string | null | undefined
  checking: boolean
  /** null = unknown (treat as "offer the sign-in button"). */
  loggedIn: boolean | null
  installing: boolean
  installError: string | null
  install: () => Promise<void>
  openLogin: () => Promise<void>
  loginNote: string | null
  /** Re-probe; with locate=true opens the file picker first. */
  recheck: (locate: boolean) => Promise<{ path: string | null; picked?: boolean }>
}

export function useCliStatus(): CliStatus {
  const [path, setPath] = useState<string | null | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [loginNote, setLoginNote] = useState<string | null>(null)
  const settingsOpen = useStore((s) => s.settingsOpen)

  const recheck = useCallback(
    async (locate: boolean): Promise<{ path: string | null; picked?: boolean }> => {
      setChecking(true)
      try {
        const s = locate
          ? await window.asit.settings.locateCli()
          : await window.asit.settings.cliStatus()
        setPath(s.path)
        if (s.path) {
          const login = await window.asit.setup.loginStatus()
          setLoggedIn(login.loggedIn)
        }
        return s
      } catch {
        setPath(null)
        return { path: null }
      } finally {
        setChecking(false)
      }
    },
    []
  )

  useEffect(() => {
    void recheck(false)
  }, [recheck])

  // While either step is unsatisfied, keep probing quietly: finish the
  // install or the terminal sign-in and the UI clears itself.
  useEffect(() => {
    if (path !== null && loggedIn !== false) return
    const t = setInterval(() => void recheck(false), path === null ? 10_000 : 4_000)
    return () => clearInterval(t)
  }, [path, loggedIn, recheck])

  useEffect(() => {
    if (!settingsOpen && (path === null || loggedIn === false)) void recheck(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  const install = useCallback(async (): Promise<void> => {
    setInstalling(true)
    setInstallError(null)
    try {
      const res = await window.asit.setup.installCli()
      if (res.ok) {
        setPath(res.path)
        const login = await window.asit.setup.loginStatus()
        setLoggedIn(login.loggedIn)
      } else {
        setInstallError(res.detail)
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }, [])

  const openLogin = useCallback(async (): Promise<void> => {
    const res = await window.asit.setup.openLogin()
    setLoginNote(
      res.ok
        ? 'A terminal opened — sign in there (your browser will pop up). This clears itself when you finish.'
        : res.detail
    )
  }, [])

  return { path, checking, loggedIn, installing, installError, install, openLogin, loginNote, recheck }
}

/** The setup actions, identical on every surface. One-click first. */
export function CliSetupButtons({
  status,
  onLocated
}: {
  status: CliStatus
  /** Fired only when the user actually picked a file in the locate dialog. */
  onLocated?: (path: string) => void
}): JSX.Element {
  return (
    <>
      <button className="btn btn-primary" disabled={status.installing} onClick={() => void status.install()}>
        {status.installing ? 'Installing… (about a minute)' : '⚡ Install automatically'}
      </button>
      {status.installError && (
        <p className="settings-hint settings-cli-bad">
          Auto-install failed: {status.installError}
        </p>
      )}
      <button
        className="btn btn-ghost"
        onClick={() =>
          void window.asit.resources.openExternal({ url: 'https://claude.com/claude-code' })
        }
      >
        Install it myself ↗
      </button>
      <button
        className="btn btn-ghost"
        disabled={status.checking}
        onClick={() =>
          void status.recheck(true).then((s) => {
            if (s.picked && s.path) onLocated?.(s.path)
          })
        }
      >
        It&apos;s installed somewhere else…
      </button>
    </>
  )
}

/** The sign-in step, shown once the binary exists but no account does. */
export function CliSignInButtons({ status }: { status: CliStatus }): JSX.Element {
  return (
    <>
      <button className="btn btn-primary" onClick={() => void status.openLogin()}>
        ⚿ Sign in to Claude
      </button>
      {status.loginNote && <p className="settings-hint">{status.loginNote}</p>}
    </>
  )
}
