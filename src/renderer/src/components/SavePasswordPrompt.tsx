import { useEffect, useState } from 'react'
import { IPC } from '@shared/ipc-contract'

// "Save this password?" — the offer a browser makes after you sign in.
//
// The password is NOT here. Main holds it from the moment the pane preload
// hands it over; this component only ever learns the site and username, and
// clicking Save just tells main to commit what it already has. A secret that
// never enters the renderer cannot be read out of it — same reasoning that
// keeps the vault out of every agent path.
//
// It renders in the header band rather than as a floating card, because a
// floating element over the pane area is painted over by the page (invariant
// 2) — the classic way to ship a prompt nobody can see.

export default function SavePasswordPrompt(): JSX.Element | null {
  const [offer, setOffer] = useState<{ origin: string; username: string } | null>(null)

  useEffect(() => {
    return window.asit.on(IPC.VAULT_OFFER_SAVE, (...args: unknown[]) => {
      setOffer(args[0] as { origin: string; username: string } | null)
    })
  }, [])

  if (!offer) return null

  const host = (() => {
    try {
      return new URL(offer.origin).hostname
    } catch {
      return offer.origin
    }
  })()

  return (
    <div className="save-password">
      <span className="save-password-text">
        Save the password for <strong>{host}</strong>
        {offer.username ? ` (${offer.username})` : ''}?
      </span>
      <button
        className="btn"
        onClick={() => {
          void window.asit.vaultPrompt.save()
          setOffer(null)
        }}
      >
        Save
      </button>
      <button
        className="btn btn-ghost"
        onClick={() => {
          void window.asit.vaultPrompt.discard()
          setOffer(null)
        }}
      >
        Never
      </button>
    </div>
  )
}
