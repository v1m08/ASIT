import { useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from '../store/useStore'
import { useSnippets } from '../hooks/useSnippets'
import { fmtCost } from '../utils/fmt'
import Markdown from './Markdown'

interface Exchange {
  prompt: string
  reply: string
  done: boolean
}

// Jarvis: the universal agent panel (Ctrl+J / 🤖). Works across every
// workspace and can drive the app — unlike the ⚡ assistant, which is a fast
// read-only lookup. Text today; the same core gains voice later.
export default function JarvisPanel(): JSX.Element | null {
  const open = useStore((s) => s.jarvisOpen)
  const setOpen = useStore((s) => s.setJarvisOpen)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [steps, setSteps] = useState<string[]>([])
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [lastCost, setLastCost] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const expand = useSnippets()

  // Right-column reservation is owned by App.tsx (shared with the assistant).

  useEffect(() => {
    const offStream = window.asit.on(IPC.JARVIS_STREAM, (...args: unknown[]) => {
      const p = args[0] as { delta: string }
      setStatus(null)
      setExchanges((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.done) return prev
        return [...prev.slice(0, -1), { ...last, reply: last.reply + p.delta }]
      })
    })
    const offStatus = window.asit.on(IPC.JARVIS_STATUS, (...args: unknown[]) => {
      const s = (args[0] as { status: string }).status
      setStatus(s)
      setSteps((prev) => (prev[prev.length - 1] === s ? prev : [...prev.slice(-5), s]))
    })
    const offDone = window.asit.on(IPC.JARVIS_DONE, (...args: unknown[]) => {
      const p = args[0] as { text: string; costUsd: number }
      setBusy(false)
      setStatus(null)
      setSteps([])
      setLastCost(p.costUsd)
      setExchanges((prev) => {
        const last = prev[prev.length - 1]
        if (!last) return prev
        return [...prev.slice(0, -1), { ...last, reply: p.text, done: true }]
      })
    })
    const offError = window.asit.on(IPC.JARVIS_ERROR, (...args: unknown[]) => {
      setBusy(false)
      setStatus(null)
      setSteps([])
      setError((args[0] as { message: string }).message)
    })
    return () => {
      offStream()
      offStatus()
      offDone()
      offError()
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [exchanges, status])

  if (!open) return null

  function ask(): void {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    setError(null)
    setBusy(true)
    setSteps([])
    pinnedRef.current = true
    setExchanges((prev) => [...prev.slice(-8), { prompt, reply: '', done: false }])
    window.asit.jarvis.ask(prompt).catch(() => {
      setBusy(false)
      setError('Jarvis failed to start.')
    })
  }

  function stop(): void {
    window.asit.jarvis.cancel()
    setBusy(false)
    setStatus(null)
    setSteps([])
    setExchanges((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.done) return prev
      return [...prev.slice(0, -1), { ...last, reply: last.reply || '(stopped)', done: true }]
    })
  }

  return (
    <div className="assistant-panel jarvis-panel">
      <div className="assistant-panel-head">
        <span className="assistant-title">🤖 Jarvis</span>
        {lastCost !== null && <span className="assistant-cost">{fmtCost(lastCost)}</span>}
        <button
          className="btn btn-ghost"
          title="New conversation"
          onClick={() => {
            window.asit.jarvis.newSession()
            setExchanges([])
            setError(null)
          }}
        >
          ⟳
        </button>
        <button className="btn btn-ghost" title="Close (Ctrl+J)" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <div
        className="assistant-scroll"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current
          if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {exchanges.length === 0 && !busy && (
          <p className="assistant-hint">
            The agent that works <b>across</b> your workspaces and can drive the app — "add the
            syllabus link to CS 1331", "what's due this week anywhere?", "generate 10 questions
            from the bio slides". It reads every workspace and acts through the same tools your
            workspace chats use.
          </p>
        )}
        {exchanges.map((ex, i) => (
          <div key={i} className="assistant-exchange">
            <div className="assistant-q">{ex.prompt}</div>
            <div className="assistant-a">
              {ex.reply ? (
                <Markdown text={ex.reply} />
              ) : i === exchanges.length - 1 && busy ? (
                <span className="chat-working">
                  <span className="working-dot" />
                  {status ?? 'Thinking…'}
                </span>
              ) : (
                ''
              )}
              {i === exchanges.length - 1 && busy && steps.length > 0 && (
                <div className="jarvis-steps">
                  {steps.map((s, j) => (
                    <div key={j} className={j === steps.length - 1 ? 'jarvis-step-live' : 'jarvis-step'}>
                      {j === steps.length - 1 ? '…' : '✓'} {s}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {error && <div className="chat-msg chat-error">{error}</div>}
      </div>
      <div className="assistant-bar">
        <input
          autoFocus
          placeholder="Tell Jarvis what to do…"
          value={input}
          onChange={(e) => setInput(expand(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ask()
          }}
        />
        {busy ? (
          <button className="assistant-send" title="Stop" onClick={stop}>
            ◼
          </button>
        ) : (
          <button className="assistant-send" title="Go" onClick={ask} disabled={!input.trim()}>
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
