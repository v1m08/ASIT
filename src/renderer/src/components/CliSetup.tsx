import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

// The Claude CLI status machine, shared by every surface that shows it (the
// header chip, Settings → AI engine, the first-run welcome). One copy, so the
// wording, the install URL, and the detection flow can never drift apart.

export interface CliStatus {
  /** undefined = still checking, null = not found, string = resolved path. */
  path: string | null | undefined
  checking: boolean
  /** Re-probe; with locate=true opens the file picker first. */
  recheck: (locate: boolean) => Promise<{ path: string | null; picked?: boolean }>
}

export function useCliStatus(): CliStatus {
  const [path, setPath] = useState<string | null | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const settingsOpen = useStore((s) => s.settingsOpen)

  const recheck = useCallback(
    async (locate: boolean): Promise<{ path: string | null; picked?: boolean }> => {
      setChecking(true)
      try {
        const s = locate
          ? await window.asit.settings.locateCli()
          : await window.asit.settings.cliStatus()
        setPath(s.path)
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

  // While missing, keep probing quietly: install Claude Code, and the chip
  // clears itself — no button hunt. Also re-probe when Settings closes, in
  // case the path was fixed there.
  useEffect(() => {
    if (path !== null) return
    const t = setInterval(() => void recheck(false), 10_000)
    return () => clearInterval(t)
  }, [path, recheck])

  useEffect(() => {
    if (!settingsOpen && path === null) void recheck(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  return { path, checking, recheck }
}

/** The three setup actions, identical on every surface. */
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
      <button
        className="btn"
        onClick={() =>
          void window.asit.resources.openExternal({ url: 'https://claude.com/claude-code' })
        }
      >
        Get Claude Code ↗
      </button>
      <button
        className="btn btn-ghost"
        disabled={status.checking}
        onClick={() => void status.recheck(false)}
      >
        I installed it — check again
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
