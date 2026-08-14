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

// Global quick assistant (haiku — fastest model); knows every task's files.
// Opens from the ⚡ launcher in the header or Ctrl+K — nothing is docked while
// it is closed, so it costs no screen space.
export default function AssistantBar(): JSX.Element | null {
  const [input, setInput] = useState('')
  const open = useStore((s) => s.assistantOpen)
  const setOpen = useStore((s) => s.setAssistantOpen)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [lastCost, setLastCost] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pinnedRef = useRef(true)
  const prewarmedRef = useRef(false)
  const expand = useSnippets()
  const assistantRecall = useStore((s) => s.assistantRecall)
  const setAssistantRecall = useStore((s) => s.setAssistantRecall)

  // The app reserves the right column for this panel (body class set in
  // App.tsx — single owner, shared with Jarvis).

  // A past chat clicked in the sidebar opens here.
  useEffect(() => {
    if (!assistantRecall) return
    setExchanges((prev) => [
      ...prev.slice(-6),
      { prompt: assistantRecall.prompt, reply: assistantRecall.reply, done: true }
    ])
    setOpen(true)
    setAssistantRecall(null)
  }, [assistantRecall, setAssistantRecall])

  function handleScroll(): void {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  useEffect(() => {
    const offStream = window.asit.on(IPC.ASSISTANT_STREAM, (...args: unknown[]) => {
      const p = args[0] as { delta: string }
      setStatus(null)
      // Immutable update: StrictMode double-invokes updaters, and mutating
      // `last` in place duplicated every streamed delta in dev.
      setExchanges((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.done) return prev
        return [...prev.slice(0, -1), { ...last, reply: last.reply + p.delta }]
      })
    })
    const offStatus = window.asit.on(IPC.ASSISTANT_STATUS, (...args: unknown[]) => {
      setStatus((args[0] as { status: string }).status)
    })
    const offDone = window.asit.on(IPC.ASSISTANT_DONE, (...args: unknown[]) => {
      const p = args[0] as { text: string; costUsd: number }
      setBusy(false)
      setStatus(null)
      setLastCost(p.costUsd)
      setExchanges((prev) => {
        const last = prev[prev.length - 1]
        if (!last) return prev
        return [...prev.slice(0, -1), { ...last, reply: p.text, done: true }]
      })
    })
    const offError = window.asit.on(IPC.ASSISTANT_ERROR, (...args: unknown[]) => {
      setBusy(false)
      setStatus(null)
      setError((args[0] as { message: string }).message)
    })
    const onKey = (e: KeyboardEvent): void => {
      // Only when the Escape happened INSIDE this panel — a window-wide close
      // stole Escapes meant for the notes "/" popup and chat mention popup.
      if (e.key !== 'Escape') return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t?.closest('.assistant-panel:not(.jarvis-panel)')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offStream()
      offStatus()
      offDone()
      offError()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [exchanges, status])

  async function ask(): Promise<void> {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    setError(null)
    setOpen(true)
    setBusy(true)
    pinnedRef.current = true

    // ">name: message" = send a WhatsApp message from your linked account.
    // Deterministic (no model): exactly what you typed, to whom it matched,
    // reported back by name.
    if (prompt.startsWith('>')) {
      const m = prompt.match(/^>\s*(?:wa|whatsapp)?\s*([^:]{1,60}):\s*(.+)$/is)
      setExchanges((prev) => [...prev.slice(-6), { prompt, reply: '', done: false }])
      if (!m) {
        setExchanges((prev) => {
          const last = prev[prev.length - 1]
          return [...prev.slice(0, -1), { ...last, reply: 'Format: `> name: message` (WhatsApp)', done: true }]
        })
        setBusy(false)
        return
      }
      setStatus('📨 Sending on WhatsApp…')
      try {
        const res = await window.asit.quickfetch.sendWhatsApp(m[1].trim(), m[2].trim())
        setExchanges((prev) => {
          const last = prev[prev.length - 1]
          return [...prev.slice(0, -1), { ...last, reply: res.ok ? `✅ ${res.detail}` : `⚠️ ${res.detail}`, done: true }]
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Send failed.')
      } finally {
        setBusy(false)
        setStatus(null)
      }
      return
    }

    // "?query" = Quick Fetch: agentless grep of your logged-in sites via a
    // hidden background page. Instant, no tokens. "?otp" auto-grabs a code.
    if (prompt.startsWith('?')) {
      const q = prompt.slice(1).trim()
      setStatus('🔎 Fetching…')
      setExchanges((prev) => [...prev.slice(-6), { prompt, reply: '', done: false }])
      try {
        const res = await window.asit.quickfetch.run(q)
        let reply: string
        if (res.otp) {
          navigator.clipboard.writeText(res.otp)
          const typed = await window.asit.panes.typeActive(res.otp)
          reply = `🔑 **${res.otp}** (${res.source}) — copied to clipboard${typed.startsWith('typed') ? ' and typed into the active page' : ''}.`
        } else if (res.error) {
          reply = `Nothing found: ${res.error}`
        } else if (res.lines.length > 0) {
          reply = res.lines.map((l) => `- ${l}`).join('\n')
        } else {
          reply = `No matches in ${res.source || 'your sources'}.`
        }
        setExchanges((prev) => {
          const last = prev[prev.length - 1]
          return [...prev.slice(0, -1), { ...last, reply, done: true }]
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Quick fetch failed.')
      } finally {
        setBusy(false)
        setStatus(null)
      }
      return
    }

    setStatus('Thinking…')
    setExchanges((prev) => [...prev.slice(-6), { prompt, reply: '', done: false }])
    try {
      await window.asit.assistant.ask(prompt)
    } catch (err) {
      setBusy(false)
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Assistant failed to start.')
    }
  }

  function cancel(): void {
    window.asit.assistant.cancel()
    setBusy(false)
    setStatus(null)
    // Seal the cancelled exchange so late deltas can't bleed into it.
    setExchanges((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.done) return prev
      return [...prev.slice(0, -1), { ...last, reply: last.reply || '(cancelled)', done: true }]
    })
  }

  if (!open) return null

  return (
    <div className="assistant-panel">
      <div className="assistant-panel-head">
        <span className="assistant-title">⚡ Quick assistant</span>
        {lastCost !== null && <span className="assistant-cost">{fmtCost(lastCost)}</span>}
        <button className="btn btn-ghost" title="Close (Esc)" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <div className="assistant-scroll" ref={scrollRef} onScroll={handleScroll}>
        {exchanges.length === 0 && !busy && (
          <p className="assistant-hint">
            Ask anything across your workspaces — or <code>?g</code> to search, <code>?otp</code>{' '}
            for a code, <code>?keywords</code> to grep your mail.
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
            </div>
          </div>
        ))}
        {error && <div className="chat-msg chat-error">{error}</div>}
      </div>
      <div className="assistant-bar">
        <input
          ref={inputRef}
          autoFocus
          placeholder="Ask anything…"
          value={input}
          onChange={(e) => {
            const v = expand(e.target.value)
            setInput(v)
            // The instant a WhatsApp command begins, start loading WhatsApp
            // Web in the background so it's ready by the time you hit Enter.
            if (v.startsWith('>') && !prewarmedRef.current) {
              prewarmedRef.current = true
              window.asit.quickfetch.prewarmWhatsApp()
            } else if (!v.startsWith('>')) {
              prewarmedRef.current = false
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ask()
          }}
        />
        {busy ? (
          <button className="assistant-send" title="Stop" onClick={cancel}>
            ◼
          </button>
        ) : (
          <button className="assistant-send" title="Ask" onClick={ask} disabled={!input.trim()}>
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
