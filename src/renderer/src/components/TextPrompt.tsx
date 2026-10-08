import { useEffect, useState } from 'react'
import { useOverlay } from '../hooks/useOverlay'

// In-app replacement for window.prompt(). Electron does not implement
// prompt() — it returns null without showing anything — so every flow built
// on it (new space, rename, due date) silently did nothing.
//
// askText() resolves with the entered text, or null on cancel. One prompt at
// a time; <TextPrompt /> is mounted once in App.

interface Pending {
  message: string
  initial: string
  resolve: (value: string | null) => void
}

let show: ((p: Pending) => void) | null = null

export function askText(message: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null)
    show({ message, initial, resolve })
  })
}

export default function TextPrompt(): JSX.Element | null {
  const [pending, setPending] = useState<Pending | null>(null)
  const [value, setValue] = useState('')

  useOverlay(pending !== null)

  useEffect(() => {
    show = (p) => {
      setPending((prev) => {
        prev?.resolve(null) // a newer prompt replaces an unanswered one
        return p
      })
      setValue(p.initial)
    }
    return () => {
      show = null
    }
  }, [])

  if (!pending) return null

  const finish = (result: string | null): void => {
    pending.resolve(result)
    setPending(null)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => finish(null)}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          finish(value)
        }}
      >
        <label className="settings-field">
          {pending.message}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') finish(null)
            }}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => finish(null)}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            OK
          </button>
        </div>
      </form>
    </div>
  )
}
