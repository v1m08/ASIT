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

  // ---- Voice: mic → main (VAD + local STT) → Jarvis → spoken reply ----
  const [voiceState, setVoiceState] = useState<'off' | 'listening' | 'thinking' | 'speaking' | 'download'>('off')
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const voiceTick = useStore((s) => s.voiceTick)
  const captureRef = useRef<{ ctx: AudioContext; stream: MediaStream } | null>(null)
  const voiceStateRef = useRef(voiceState)
  voiceStateRef.current = voiceState

  const stopCapture = (): void => {
    const c = captureRef.current
    captureRef.current = null
    if (c) {
      c.stream.getTracks().forEach((t) => t.stop())
      void c.ctx.close()
    }
  }

  const startCapture = async (): Promise<void> => {
    if (captureRef.current) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    const ctx = new AudioContext({ sampleRate: 16000 })
    const source = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(2048, 1, 1)
    proc.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0)
      window.asit.voice.chunk(data.slice().buffer)
    }
    source.connect(proc)
    proc.connect(ctx.destination) // required for onaudioprocess to fire
    captureRef.current = { ctx, stream }
  }

  const toggleVoice = async (): Promise<void> => {
    const s = voiceStateRef.current
    if (s === 'listening') {
      await window.asit.voice.stop()
      stopCapture()
      setVoiceState('off')
      return
    }
    if (s === 'download') return
    const status = await window.asit.voice.status()
    if (!status.modelsReady) {
      setVoiceState('download')
      setDownloadPct(0)
      try {
        await window.asit.voice.download()
      } catch (err) {
        setError(`Voice model download failed: ${err instanceof Error ? err.message : String(err)}`)
        setVoiceState('off')
        setDownloadPct(null)
        return
      }
      setDownloadPct(null)
    }
    try {
      await window.asit.voice.start() // also silences any reply mid-speech
      await startCapture()
      setVoiceState('listening')
    } catch (err) {
      setError(`Mic failed: ${err instanceof Error ? err.message : String(err)}`)
      setVoiceState('off')
    }
  }
  const toggleVoiceRef = useRef(toggleVoice)
  toggleVoiceRef.current = toggleVoice

  // Ctrl+Space from anywhere.
  useEffect(() => {
    if (voiceTick > 0) void toggleVoiceRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceTick])

  useEffect(() => {
    const offState = window.asit.on(IPC.VOICE_STATE, (...args: unknown[]) => {
      const p = args[0] as { state: string; detail?: string }
      if (p.state === 'idle') setVoiceState('off')
      else setVoiceState(p.state as 'listening' | 'thinking' | 'speaking')
      if (p.state !== 'listening') stopCapture() // utterance captured — mic off
      if (p.state === 'thinking' && p.detail) setStatus(p.detail)
    })
    const offTranscript = window.asit.on(IPC.VOICE_TRANSCRIPT, (...args: unknown[]) => {
      const p = args[0] as { text: string }
      setBusy(true)
      setError(null)
      setExchanges((prev) => [...prev.slice(-8), { prompt: `🎙 ${p.text}`, reply: '', done: false }])
    })
    const offReply = window.asit.on(IPC.VOICE_REPLY, (...args: unknown[]) => {
      const p = args[0] as { text: string }
      setBusy(false)
      setStatus(null)
      setSteps([])
      setExchanges((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.done) return prev
        return [...prev.slice(0, -1), { ...last, reply: p.text, done: true }]
      })
    })
    const offProgress = window.asit.on(IPC.VOICE_DOWNLOAD_PROGRESS, (...args: unknown[]) => {
      setDownloadPct((args[0] as { pct: number }).pct)
    })
    return () => {
      offState()
      offTranscript()
      offReply()
      offProgress()
      stopCapture()
    }
  }, [])

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
        <button
          className={`voice-btn voice-${voiceState}`}
          title={
            voiceState === 'listening'
              ? 'Listening — pause to send, click to cancel (Ctrl+Space)'
              : voiceState === 'download'
                ? `Downloading voice models… ${downloadPct ?? 0}%`
                : voiceState === 'speaking'
                  ? 'Speaking — click to interrupt and talk'
                  : 'Talk to Jarvis (Ctrl+Space) — first use downloads ~130MB of local speech models'
          }
          onClick={() => void toggleVoice()}
        >
          {voiceState === 'listening'
            ? '🔴'
            : voiceState === 'thinking'
              ? '💭'
              : voiceState === 'speaking'
                ? '🔊'
                : voiceState === 'download'
                  ? `${downloadPct ?? 0}%`
                  : '🎙'}
        </button>
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
