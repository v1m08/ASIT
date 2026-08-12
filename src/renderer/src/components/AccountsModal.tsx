import { useCallback, useEffect, useState } from 'react'
import { useOverlay } from '../hooks/useOverlay'

interface AccountRow {
  id: string
  name: string
  description: string
  connected: boolean
}

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card accounts-modal" onClick={(e) => e.stopPropagation()}>
        {welcome ? (
          <>
            <h2>Welcome to ASIT 👋</h2>
            <p className="accounts-sub">
              ASIT has its own built-in browser profile that stays logged in forever. Connect the
              accounts you study with once, and every task workspace opens pre-authenticated. Start
              with Google — it unlocks most &quot;Sign in with Google&quot; sites too.
            </p>
          </>
        ) : (
          <>
            <h2>Connected accounts</h2>
            <p className="accounts-sub">
              Logins live in ASIT&apos;s persistent browser profile and are shared by every
              workspace pane.
            </p>
          </>
        )}

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
                <button
                  className="btn"
                  disabled={busyId !== null}
                  onClick={() => connect(a.id)}
                >
                  {busyId === a.id ? 'Waiting…' : 'Sign in'}
                </button>
              )}
            </div>
          ))}
        </div>

        <p className="accounts-note">
          Need another site? Add it to any task as a website resource and sign in there — it sticks
          the same way.
        </p>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {welcome ? "Let's go" : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
