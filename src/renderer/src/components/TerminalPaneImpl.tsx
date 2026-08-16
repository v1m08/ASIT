import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { IPC } from '@shared/ipc-contract'
import '@xterm/xterm/css/xterm.css'
import type { Task } from '@shared/types'

// The heavy half of the terminal pane (xterm + addon ≈ 300KB). Loaded on
// demand by TerminalPane.tsx so opening the app never pays for it — same
// Impl-wrapper pattern as the notes editor.

interface Props {
  task: Task
}

export default function TerminalPaneImpl({ task }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const idRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const [shell, setShell] = useState('powershell')
  const [shells, setShells] = useState<string[]>([])
  const [restartTick, setRestartTick] = useState(0)

  useEffect(() => {
    void window.asit.terminal.shells().then(setShells)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    setExited(null)
    setError(null)

    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      // Match the app's palette so it doesn't look bolted on.
      theme: {
        background: '#12141a',
        foreground: '#c8d0e0',
        cursor: '#7aa2f7',
        selectionBackground: '#2c3448'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    const safeFit = (): void => {
      try {
        fit.fit()
        if (idRef.current) void window.asit.terminal.resize(idRef.current, term.cols, term.rows)
      } catch {
        // fires while the pane is hidden / zero-sized
      }
    }

    void (async () => {
      const res = await window.asit.terminal.open(task.id, shell)
      if (disposed) return
      if (!res.id) {
        setError(res.error ?? 'could not start a terminal')
        return
      }
      idRef.current = res.id
      const backlog = await window.asit.terminal.replay(res.id)
      if (disposed) return
      if (backlog) term.write(backlog)
      safeFit()
      term.focus()
    })()

    // Keystrokes go straight to the pty. This is the ONLY write path.
    const keys = term.onData((data) => {
      if (idRef.current) void window.asit.terminal.write(idRef.current, data)
    })

    const offData = window.asit.on(IPC.TERMINAL_DATA, (...args: unknown[]) => {
      if (args[0] === idRef.current) term.write(args[1] as string)
    })
    const offExit = window.asit.on(IPC.TERMINAL_EXIT, (...args: unknown[]) => {
      if (args[0] === idRef.current) setExited((args[1] as number) ?? 0)
    })

    const ro = new ResizeObserver(() => safeFit())
    ro.observe(host)

    return () => {
      disposed = true
      ro.disconnect()
      keys.dispose()
      offData()
      offExit()
      if (idRef.current) void window.asit.terminal.close(idRef.current)
      idRef.current = null
      term.dispose()
      termRef.current = null
    }
    // restartTick lets "Restart" rebuild the whole session.
  }, [task.id, shell, restartTick])

  return (
    <div className="terminal-pane">
      <div className="terminal-bar">
        <select
          className="terminal-shell"
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          title="Shell"
        >
          {(shells.length ? shells : [shell]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="terminal-cwd" title={task.folderPath}>
          {task.folderPath.split('\\').slice(-1)[0]}
        </span>
        {task.terminalAiRead ? (
          <span className="terminal-ai-badge" title="This workspace's agent may READ this output. It can never type here.">
            👁 AI can read
          </span>
        ) : (
          <span className="terminal-ai-badge terminal-ai-off" title="No agent can see or type in this terminal.">
            🔒 AI blocked
          </span>
        )}
        <button className="rail-btn rail-toggle" title="Restart shell" onClick={() => setRestartTick((t) => t + 1)}>
          ⟳
        </button>
      </div>
      {error && <p className="terminal-error">Couldn’t start a terminal: {error}</p>}
      {exited !== null && (
        <p className="terminal-error">
          Shell exited (code {exited}) — press ⟳ to start a new one.
        </p>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}
