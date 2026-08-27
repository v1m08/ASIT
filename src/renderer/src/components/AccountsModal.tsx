import { useCallback, useEffect, useState } from 'react'
import { useOverlay } from '../hooks/useOverlay'
import { CliSetupButtons, CliSignInButtons, useCliStatus } from './CliSetup'

interface AccountRow {
  id: string
  name: string
  description: string
  connected: boolean
}

/**
 * First-run welcome + the connected-accounts manager.
 *
 * The welcome used to lead with eight sign-in buttons and never mention the
 * AI — homework before anything worked, silence about the one dependency
 * that actually blocks the app. Now it leads with whether the AI is ready
 * (with the fix one click away) and makes accounts the optional step it is.
 */
export default function AccountsModal({
  welcome,
  onClose
}: {
  welcome?: boolean
  onClose: () => void
}): JSX.Element {
  useOverlay(true)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showAccounts, setShowAccounts] = useState(!welcome)
  const cli = useCliStatus()

  const refresh = useCallback(async (): Promise<void> => {
    setAccounts(await window.asit.accounts.list())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function connect(id: string): Promise<void> {
    setBusyId(id)
    await window.asit.accounts.openLogin(id) // resolves when the login window closes
    setBusyId(null)
    await refresh()
  }

  const accountsList = (
    <div className="accounts-list">
      {accounts.map((a) => (
        <div key={a.id} className="account-row">
          <div className="account-info">
            <span className="account-name">{a.name}</span>
            <span className="account-desc">{a.description}</span>
          </div>
          {a.connected ? (
            <span className="account-connected">✓ Connected</span>
          ) : (
            <button className="btn" disabled={busyId !== null} onClick={() => connect(a.id)}>
              {busyId === a.id ? 'Waiting…' : 'Sign in'}
            </button>
          )}
        </div>
      ))}
    </div>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card accounts-modal" onClick={(e) => e.stopPropagation()}>
        {welcome ? (
          <>
            <h2>Welcome to ASIT 👋</h2>
            <p className="accounts-sub">
              Browse and study in one place, with an AI that can see your open pages, PDFs, and
              notes. Two quick things and you&apos;re set:
            </p>

            <div className="settings-cli">
              <div className="rail-header">1 · The AI engine</div>
              {cli.path === undefined ? (
                <p className="settings-hint">Checking for Claude Code…</p>
              ) : cli.path === null ? (
                <>
                  <p className="settings-hint">
                    ASIT&apos;s AI runs on <strong>Claude Code</strong>. One click installs it —
                    no other downloads, nothing to configure.
                  </p>
                  <CliSetupButtons status={cli} />
                </>
              ) : cli.loggedIn === false ? (
                <>
                  <p className="settings-hint settings-cli-ok" title={cli.path}>
                    ✓ Installed. Last step: sign in with your Claude account (free or paid).
                  </p>
                  <CliSignInButtons status={cli} />
                </>
              ) : (
                <p className="settings-hint settings-cli-ok" title={cli.path}>
                  ✓ Claude Code is installed{cli.loggedIn ? ' and signed in' : ''} — the AI is
                  ready to go.
                </p>
              )}
            </div>

            <div className="settings-cli">
              <div className="rail-header">2 · Your accounts (optional)</div>
              <p className="settings-hint">
                ASIT&apos;s built-in browser stays signed in forever. Connect what you study with
                now, or just sign in to sites as you visit them — it sticks either way.
              </p>
              <button className="btn btn-ghost" onClick={() => setShowAccounts((v) => !v)}>
                {showAccounts ? '▾ Hide accounts' : '▸ Connect accounts…'}
              </button>
              {showAccounts && accountsList}
            </div>
          </>
        ) : (
          <>
            <h2>Connected accounts</h2>
            <p className="accounts-sub">
              Logins live in ASIT&apos;s persistent browser profile and are shared by every
              workspace pane.
            </p>
            {accountsList}
            <p className="accounts-note">
              Need another site? Add it to any task as a website resource and sign in there — it
              sticks the same way.
            </p>
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {welcome ? "Let's go" : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
