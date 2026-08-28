import { useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from '../store/useStore'
import { openMicGate, warmMic } from '../lib/micCapture'
import { useSnippets } from '../hooks/useSnippets'
import { fmtCost } from '../utils/fmt'
import Markdown from './Markdown'

// THE assistant panel — one surface, routed views. The app used to have two
// mutually-exclusive right panels (a read-only "quick assistant" bar and the
// Jarvis agent panel) with duplicated input handling; now there is one panel
// with a scope switch:
//
//   Agent (Ctrl+J)  — Jarvis: cross-workspace, acts through the app protocol,
//                     voice-capable. Wire protocol: JARVIS_*.
//   Quick (Ctrl+K)  — the haiku read-only fast lane. Wire protocol:
//                     ASSISTANT_*.
//
// The services are deliberately NOT merged — each IS a containment identity
// (cwd, tools, verbs chosen in main by which service spawned the CLI), so a
// renderer routing bug here can't escalate anything (invariant 12/13). The
// workspace chat keeps its own docked panel; the header links to it.
//
// The ?/> prefixes (quickfetch, WhatsApp) are deterministic main-side paths
// and work in either scope.

interface Exchange {
  prompt: string
  reply: string
  done: boolean
  // Voice and typed turns can interleave (a voice ask running while the user
  // types, or vice versa). Events are routed ONLY to their own source's last
  // open exchange — without this, replies landed under the wrong prompt.
  source: 'typed' | 'voice' | 'quick'
}

function finishLast(prev: Exchange[], source: Exchange['source'], reply: string): Exchange[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].source === source && !prev[i].done) {
      const next = [...prev]
      next[i] = { ...next[i], reply, done: true }
      return next
    }
  }
  return prev
}

function appendLast(prev: Exchange[], source: Exchange['source'], delta: string): Exchange[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].source === source && !prev[i].done) {
      const next = [...prev]
      next[i] = { ...next[i], reply: next[i].reply + delta }
      return next
    }
  }
  return prev
}

export default function AssistantPanel(): JSX.Element | null {
  const open = useStore((s) => s.assistantOpen)
  const setOpen = useStore((s) => s.setAssistantOpen)
  const scope = useStore((s) => s.assistantScope)
  const setScope = useStore((s) => s.setAssistantScope)
  const activeTask = useStore((s) => s.activeTask)
  const scratchId = useStore((s) => s.scratchTask?.id)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [steps, setSteps] = useState<string[]>([])
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [lastCost, setLastCost] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Past conversations live behind a caret here instead of a separate
  // "quick chats" list in the sidebar.
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<{ id: string; prompt: string; reply: string }[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const prewarmedRef = useRef(false)
  const expand = useSnippets()

  // Right-column reservation is owned by App.tsx.

  // ---- Voice: mic → main (VAD + local STT) → Jarvis → spoken reply ----
  // Voice always talks to the AGENT — opening it forces agent scope.
  const [voiceState, setVoiceState] = useState<'off' | 'listening' | 'thinking' | 'speaking' | 'download'>('off')
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const voiceTick = useStore((s) => s.voiceTick)
  // The mic itself lives in lib/micCapture — shared with dictation. Two
  // AudioContexts on one input device fight, and the loser records silence,
  // so there is exactly one and callers hold a gate on it.
  const closeGateRef = useRef<(() => void) | null>(null)
  const playCtxRef = useRef<AudioContext | null>(null)
  const playNodeRef = useRef<AudioBufferSourceNode | null>(null)
  const voiceStateRef = useRef(voiceState)
  voiceStateRef.current = voiceState

  const closeGate = (): void => {
    closeGateRef.current?.()
    closeGateRef.current = null
  }

  const stopCapture = (): void => closeGate()
  const warmCapture = (): Promise<void> => warmMic()

  // Play a Kokoro clip streamed from main; keep the node for barge-in.
  const playAudio = (sampleRate: number, samples: Float32Array): void => {
    try {
      stopAudio()
      let ctx = playCtxRef.current
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContext()
        playCtxRef.current = ctx
      }
      const buf = ctx.createBuffer(1, samples.length, sampleRate)
      buf.getChannelData(0).set(samples)
      const node = ctx.createBufferSource()
      node.buffer = buf
      node.connect(ctx.destination)
      node.onended = () => {
        if (playNodeRef.current === node) playNodeRef.current = null
        window.asit.voice.audioDone()
      }
      playNodeRef.current = node
      node.start()
    } catch {
      window.asit.voice.audioDone()
    }
  }

  const stopAudio = (): void => {
    const n = playNodeRef.current
    playNodeRef.current = null
    if (n) {
      n.onended = null
      try {
        n.stop()
      } catch {
        // already stopped
      }
    }
  }

  const toggleInFlight = useRef(false)

  const toggleVoice = async (): Promise<void> => {
    // Two rapid Ctrl+Space presses must collapse into one action — a double
    // start opened TWO mic streams and kept the first one hot forever.
    if (toggleInFlight.current) return
    toggleInFlight.current = true
    try {
      await doToggleVoice()
    } finally {
      toggleInFlight.current = false
    }
  }

  const doToggleVoice = async (): Promise<void> => {
    const s = voiceStateRef.current
    if (s === 'listening' || s === 'thinking' || s === 'speaking') {
      // Cancel / barge-in: abort the utterance and silence any reply.
      closeGate()
      stopAudio()
      await window.asit.voice.stop()
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
      // Mic is already warm (panel-open prewarm) — flip the gate FIRST so the
      // very first frames after Ctrl+Space are captured, then tell main.
      await warmCapture()
      closeGate()
      closeGateRef.current = openMicGate()
      setVoiceState('listening')
      await window.asit.voice.start() // engine prewarmed; also silences a reply
    } catch (err) {
      setError(`Mic failed: ${err instanceof Error ? err.message : String(err)}`)
      setVoiceState('off')
      stopCapture()
      // Main may already be listening with no audio source — release it.
      void window.asit.voice.stop()
    }
  }
  const toggleVoiceRef = useRef(toggleVoice)
  toggleVoiceRef.current = toggleVoice

  // Ctrl+Space from anywhere (bumpVoice also opens the panel in agent scope).
  useEffect(() => {
    if (voiceTick > 0) void toggleVoiceRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceTick])

  // On panel open: prewarm the STT/TTS engines AND the mic, so the first
  // Ctrl+Space records instantly. On close: fully release the mic + engines'
  // audio and any playback.
  useEffect(() => {
    if (open) {
      window.asit.voice.prewarm()
      void warmCapture().catch(() => undefined)
    } else {
      closeGate()
      stopAudio()
      if (voiceStateRef.current !== 'off') void window.asit.voice.stop()
      stopCapture()
      setVoiceState('off')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    const offState = window.asit.on(IPC.VOICE_STATE, (...args: unknown[]) => {
      const p = args[0] as { state: string; detail?: string }
      if (p.state === 'idle') setVoiceState('off')
      else setVoiceState(p.state as 'listening' | 'thinking' | 'speaking')
      // Utterance captured (main left 'listening') → stop feeding chunks, but
      // keep the mic WARM so the next turn is instant.
      if (p.state !== 'listening') closeGate()
      if (p.state === 'thinking' && p.detail) setStatus(p.detail)
    })
    const offTranscript = window.asit.on(IPC.VOICE_TRANSCRIPT, (...args: unknown[]) => {
      const p = args[0] as { text: string }
      setError(null)
      setBusy(true) // a voice turn is running → the Stop control appears
      setExchanges((prev) => [...prev.slice(-8), { prompt: `◉ ${p.text}`, reply: '', done: false, source: 'voice' }])
    })
    const offReply = window.asit.on(IPC.VOICE_REPLY, (...args: unknown[]) => {
      const p = args[0] as { text: string }
      setStatus(null)
      setBusy(false)
      setExchanges((prev) => finishLast(prev, 'voice', p.text))
    })
    const offProgress = window.asit.on(IPC.VOICE_DOWNLOAD_PROGRESS, (...args: unknown[]) => {
      setDownloadPct((args[0] as { pct: number }).pct)
    })
    const offAudio = window.asit.on(IPC.VOICE_AUDIO, (...args: unknown[]) => {
      const p = args[0] as { sampleRate: number; samples: ArrayBuffer | Uint8Array }
      // samples arrive as a Node Buffer → view as Float32.
      const bytes = p.samples instanceof Uint8Array ? p.samples : new Uint8Array(p.samples)
      const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
      playAudio(p.sampleRate, f32)
    })
    const offAudioStop = window.asit.on(IPC.VOICE_AUDIO_STOP, () => stopAudio())
    return () => {
      offState()
      offTranscript()
      offReply()
      offProgress()
      offAudio()
      offAudioStop()
      stopAudio()
      stopCapture()
    }
  }, [])

  // Agent (Jarvis) wire protocol → 'typed' exchanges.
  useEffect(() => {
    const offStream = window.asit.on(IPC.JARVIS_STREAM, (...args: unknown[]) => {
      const p = args[0] as { delta: string }
      setStatus(null)
      setExchanges((prev) => appendLast(prev, 'typed', p.delta))
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
      setExchanges((prev) => finishLast(prev, 'typed', p.text))
    })
    const offError = window.asit.on(IPC.JARVIS_ERROR, (...args: unknown[]) => {
      setBusy(false)
      setStatus(null)
      setSteps([])
      setError((args[0] as { message: string }).message)
      setExchanges((prev) => finishLast(prev, 'typed', '⚠️ (failed)'))
    })
    return () => {
      offStream()
      offStatus()
      offDone()
      offError()
    }
  }, [])

  // Quick (haiku) wire protocol → 'quick' exchanges.
  useEffect(() => {
    const offStream = window.asit.on(IPC.ASSISTANT_STREAM, (...args: unknown[]) => {
      const p = args[0] as { delta: string }
      setStatus(null)
      setExchanges((prev) => appendLast(prev, 'quick', p.delta))
    })
    const offStatus = window.asit.on(IPC.ASSISTANT_STATUS, (...args: unknown[]) => {
      setStatus((args[0] as { status: string }).status)
    })
    const offDone = window.asit.on(IPC.ASSISTANT_DONE, (...args: unknown[]) => {
      const p = args[0] as { text: string; costUsd: number }
      setBusy(false)
      setStatus(null)
      setLastCost(p.costUsd)
      setExchanges((prev) => finishLast(prev, 'quick', p.text))
    })
    const offError = window.asit.on(IPC.ASSISTANT_ERROR, (...args: unknown[]) => {
      setBusy(false)
      setStatus(null)
      setError((args[0] as { message: string }).message)
      setExchanges((prev) => finishLast(prev, 'quick', '⚠️ (failed)'))
    })
    // Escape inside the panel closes it (window-wide would steal Escapes
    // meant for the notes "/" popup and chat mention popup).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t?.closest('.assistant-panel')) useStore.getState().setAssistantOpen(false)
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

  if (!open) return null

  async function ask(): Promise<void> {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    setError(null)
    pinnedRef.current = true

    // Deterministic quick-command prefixes, any scope: "?g …" search, "?otp",
    // "?keywords" (agentless mail grep), "> name: message" (WhatsApp).
    if (prompt.startsWith('?') || prompt.startsWith('>')) {
      setExchanges((prev) => [...prev.slice(-8), { prompt, reply: '', done: false, source: 'typed' }])
      try {
        let reply: string
        if (prompt.startsWith('>')) {
          const m = prompt.match(/^>\s*(?:wa|whatsapp)?\s*([^:]{1,60}):\s*(.+)$/is)
          if (!m) reply = 'Format: `> name: message` (WhatsApp)'
          else {
            const res = await window.asit.quickfetch.sendWhatsApp(m[1].trim(), m[2].trim())
            reply = res.ok ? `✅ ${res.detail}` : `⚠️ ${res.detail}`
          }
        } else {
          const res = await window.asit.quickfetch.run(prompt.slice(1).trim())
          if (res.otp) {
            // The code you asked for should land where codes go: clipboard,
            // and the focused field of the active page if there is one.
            void navigator.clipboard.writeText(res.otp)
            const typed = await window.asit.panes.typeActive(res.otp)
            reply = `⚿ **${res.otp}** (${res.source}) — copied to clipboard${typed.startsWith('typed') ? ' and typed into the active page' : ''}.`
          } else if (res.error) reply = `Nothing found: ${res.error}`
          else if (res.lines.length > 0) reply = res.lines.map((l) => `- ${l}`).join('\n')
          else reply = `No matches in ${res.source || 'your sources'}.`
        }
        setExchanges((prev) => finishLast(prev, 'typed', reply))
      } catch (err) {
        setExchanges((prev) =>
          finishLast(prev, 'typed', `⚠️ ${err instanceof Error ? err.message : 'failed'}`)
        )
      }
      return
    }

    setBusy(true)
    setSteps([])
    if (scope === 'quick') {
      setStatus('Thinking…')
      setExchanges((prev) => [...prev.slice(-8), { prompt, reply: '', done: false, source: 'quick' }])
      try {
        await window.asit.assistant.ask(prompt)
      } catch (err) {
        setBusy(false)
        setStatus(null)
        setError(err instanceof Error ? err.message : 'Assistant failed to start.')
      }
      return
    }
    setExchanges((prev) => [...prev.slice(-8), { prompt, reply: '', done: false, source: 'typed' }])
    window.asit.jarvis.ask(prompt).catch(() => {
      setBusy(false)
      setError('The agent failed to start.')
    })
  }

  function stop(): void {
    // Stops a running turn whichever lane it came from, and any spoken reply.
    window.asit.jarvis.cancel()
    window.asit.assistant.cancel()
    closeGate()
    stopAudio()
    if (voiceStateRef.current !== 'off') void window.asit.voice.stop()
    setBusy(false)
    setStatus(null)
    setSteps([])
    setVoiceState('off')
    setExchanges((prev) => {
      let next = finishLast(prev, 'voice', '(stopped)')
      next = finishLast(next, 'typed', '(stopped)')
      return finishLast(next, 'quick', '(stopped)')
    })
  }

  // The scratchpad ("Browse") is not a project, so the assistant treats it as
  // "no particular workspace" exactly as the old home screen did.
  const chatTask = activeTask && activeTask.id !== scratchId ? activeTask : null

  return (
    <div className="assistant-panel jarvis-panel">
      <div className="assistant-panel-head">
        <span className="assistant-scope">
          <button
            className={`scope-btn ${scope === 'agent' ? 'scope-btn-on' : ''}`}
            title="The agent: works across every workspace and can drive the app (Ctrl+J)"
            onClick={() => setScope('agent')}
          >
            Agent
          </button>
          <button
            className={`scope-btn ${scope === 'quick' ? 'scope-btn-on' : ''}`}
            title="Quick answers: fastest model, read-only (Ctrl+K)"
            onClick={() => setScope('quick')}
          >
            Quick
          </button>
        </span>
        {scope === 'agent' && (
          <button
            className={`voice-btn voice-${voiceState}`}
            title={
              voiceState === 'listening'
                ? 'Listening — pause to send, click to cancel (Ctrl+Space)'
                : voiceState === 'download'
                  ? `Downloading voice models… ${downloadPct ?? 0}%`
                  : voiceState === 'speaking'
                    ? 'Speaking — click to interrupt and talk'
                    : 'Talk to the agent (Ctrl+Space) — first use downloads ~130MB of local speech models'
            }
            onClick={() => void toggleVoice()}
          >
            {voiceState === 'listening'
              ? '●'
              : voiceState === 'thinking'
                ? '⋯'
                : voiceState === 'speaking'
                  ? '◈'
                  : voiceState === 'download'
                    ? `${downloadPct ?? 0}%`
                    : '◉'}
          </button>
        )}
        {lastCost !== null && <span className="assistant-cost">{fmtCost(lastCost)}</span>}
        {chatTask && !chatTask.aiDisabled && (
          <button
            className="btn btn-ghost"
            title={`Open the "${chatTask.title}" workspace chat — the agent scoped to just that workspace`}
            onClick={() => {
              setOpen(false)
              useStore.setState({ chatOpen: true })
            }}
          >
            ▭
          </button>
        )}
        {scope === 'agent' && (
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
        )}
        <button
          className="btn btn-ghost"
          title="Past conversations"
          onClick={async () => {
            if (!showHistory) setHistory(await window.asit.assistant.history(40))
            setShowHistory((v) => !v)
          }}
        >
          ⌄
        </button>
        <button className="btn btn-ghost" title="Close (Esc)" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      {showHistory && (
        <div className="jarvis-history">
          {history.length === 0 && <p className="quick-chats-empty">Nothing yet.</p>}
          {history.map((h) => (
            <button
              key={h.id}
              className="quick-chat-item"
              title={h.prompt}
              onClick={() => {
                setExchanges((prev) => [
                  ...prev,
                  { prompt: h.prompt, reply: h.reply, done: true, source: 'typed' as const }
                ])
                setShowHistory(false)
              }}
            >
              {h.prompt.replace(/\s+/g, ' ').slice(0, 60)}
            </button>
          ))}
        </div>
      )}
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
            {scope === 'agent' ? (
              <>
                The agent that works <b>across</b> your workspaces and can drive the app — "add
                the syllabus link to CS 1331", "what's due this week anywhere?". It sees your
                open tabs and acts through the same tools your workspace chats use.
              </>
            ) : (
              <>
                Fast, read-only answers about anything in your workspaces — or <code>?g</code> to
                search, <code>?otp</code> for a code, <code>?keywords</code> to grep your mail.
              </>
            )}
          </p>
        )}
        {exchanges.map((ex, i) => (
          <div key={i} className="assistant-exchange">
            <div className="assistant-q">{ex.prompt}</div>
            <div className="assistant-a">
              {ex.reply ? (
                <Markdown text={ex.reply} />
              ) : !ex.done ? (
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
          placeholder={
            scope === 'agent'
              ? 'Tell the agent…  ( ?g search · ?otp · > name: msg )'
              : 'Ask anything…  ( ?g search · ?otp · > name: msg )'
          }
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
            if (e.key === 'Enter') void ask()
          }}
        />
        {busy ? (
          <button className="assistant-send" title="Stop" onClick={stop}>
            ◼
          </button>
        ) : (
          <button className="assistant-send" title="Go" onClick={() => void ask()} disabled={!input.trim()}>
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
