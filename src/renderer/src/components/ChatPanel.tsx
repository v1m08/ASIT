import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import type { ChatMessage, ChatSession, Task } from '@shared/types'
import { fmtCost, fmtTokens } from '../utils/fmt'
import { useSnippets } from '../hooks/useSnippets'
import Markdown from './Markdown'

interface StreamPayload {
  chatSessionId: string
  delta?: string
  text?: string
  message?: string
  status?: string
  outputTokens?: number
  usage?: { inputTokens: number; outputTokens: number; costUsd: number }
}

const MODELS = [
  { value: 'default', label: 'Default model' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

// "/file" mentions reference task files; "./skill" mentions inline a saved
// procedure. Both render as chips and become explicit context in the prompt.
interface FileRef {
  label: string
  line: string
}

interface Chip {
  kind: 'file' | 'skill'
  label: string
  line?: string
  content?: string
}

export default function ChatPanel({ task }: { task: Task }): JSX.Element {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // Full enumeration of the agent's tool calls this turn (step trail).
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [model, setModel] = useState('default')
  const [liveTokens, setLiveTokens] = useState(0)
  const [taskFiles, setTaskFiles] = useState<FileRef[]>([])
  const [skillList, setSkillList] = useState<{ name: string; content: string }[]>([])
  const [refs, setRefs] = useState<Chip[]>([])
  const [mentionFilter, setMentionFilter] = useState<string | null>(null)
  const [mentionKind, setMentionKind] = useState<'file' | 'skill'>('file')
  const [mentionIndex, setMentionIndex] = useState(0)
  // Message queue: send while a reply is streaming → queued, auto-sent in
  // order when the turn finishes. Stop pauses the queue.
  const [queue, setQueue] = useState<string[]>([])
  const [queuePaused, setQueuePaused] = useState(false)
  const queueRef = useRef<string[]>([])
  queueRef.current = queue
  const queuePausedRef = useRef(false)
  queuePausedRef.current = queuePaused
  const busyRef = useRef(false)
  busyRef.current = busy
  const sendOutgoingRef = useRef<(outgoing: string) => Promise<void>>()
  const [lastTurn, setLastTurn] = useState<{ tokens: number; costUsd: number } | null>(null)
  const [taskCost, setTaskCost] = useState(0)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Stick-to-bottom: auto-scroll only while the user is already at the bottom;
  // scrolling up to read must never be fought by incoming stream chunks.
  const pinnedRef = useRef(true)
  const sessionIdRef = useRef<string | null>(null)
  const taskIdRef = useRef(task.id)
  taskIdRef.current = task.id
  const pumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  sessionIdRef.current = sessionId
  const expand = useSnippets()

  function handleScroll(): void {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  // Audit fix: switching tasks must fully reset chat state — without this the
  // previous task's session id leaked into the new task's panel.
  useEffect(() => {
    setSessionId(null)
    setSessions([])
    setMessages([])
    setStreaming('')
    setError(null)
    setBusy(false)
    setSteps([])
    setQueue([])
    setQueuePaused(false)
  }, [task.id])

  const loadSessions = useCallback(async (): Promise<void> => {
    const forTask = task.id
    const list = await window.asit.chat.listSessions(forTask)
    // A task switch may have happened while we awaited — applying the old
    // task's sessions here was exactly the cross-task leak the reset effect
    // above exists to prevent.
    if (taskIdRef.current !== forTask) return
    setSessions(list)
    if (list.length > 0) {
      setSessionId((prev) => prev ?? list[0].id)
    }
  }, [task.id])

  // Referencable files for "/" mentions.
  useEffect(() => {
    setRefs([])
    window.asit.resources.list(task.id).then((rs) => {
      const files: FileRef[] = [{ label: 'notes.md', line: '`notes.md` — the task notes' }]
      for (const r of rs) {
        if (r.filePath) {
          const name = r.filePath.split(/[\\/]/).pop()!
          const dir = r.kind === 'pdf' ? 'pdfs/' : /[\\/]files[\\/]/.test(r.filePath) ? 'files/' : ''
          files.push({
            label: r.title,
            line:
              r.kind === 'pdf'
                ? `\`${dir}${name}\` — "${r.title}" (prefer the plain-text copy \`${dir}${name.replace(/\.pdf$/i, '.txt')}\` if present)`
                : `\`${dir}${name}\` — "${r.title}"`
          })
        } else if (r.kind === 'url' && r.url) {
          const cleanUrl = r.url.split(/[?#]/)[0]
          if (/\.pdf$/i.test(cleanUrl)) {
            const webName = ('web-' + (cleanUrl.split('/').pop() || 'document.pdf')).replace(
              /[^\w.-]/g,
              '_'
            )
            files.push({
              label: r.title,
              line: `the PDF "${r.title}" (${r.url}) — its FULL TEXT is extracted at \`pdfs/${webName.replace(/\.pdf$/i, '.txt')}\` (if missing, open the pane and it extracts on the next message)`
            })
          } else {
            files.push({
              label: r.title,
              line: `the web page "${r.title}" (${r.url}) — its snapshot is in \`.asit/pages/\``
            })
          }
        }
      }
      setTaskFiles(files)
    })
  }, [task.id])

  const mentionMatches: Chip[] =
    mentionFilter === null
      ? []
      : mentionKind === 'skill'
        ? skillList
            .filter((s) => s.name.toLowerCase().includes(mentionFilter.toLowerCase()))
            .slice(0, 6)
            .map((s) => ({ kind: 'skill' as const, label: s.name, content: s.content }))
        : taskFiles
            .filter((f) => f.label.toLowerCase().includes(mentionFilter.toLowerCase()))
            .slice(0, 6)
            .map((f) => ({ kind: 'file' as const, label: f.label, line: f.line }))

  function detectMention(value: string): void {
    const m = value.match(/(?:^|\s)(\.\/|\/)([^\s]*)$/)
    if (m) {
      const kind = m[1] === './' ? 'skill' : 'file'
      setMentionKind(kind)
      setMentionFilter(m[2])
      if (kind === 'skill') window.asit.skills.list().then(setSkillList) // always fresh
    } else {
      setMentionFilter(null)
    }
    setMentionIndex(0)
  }

  function selectMention(c: Chip): void {
    setInput((prev) => prev.replace(/(^|\s)\.?\/[^\s]*$/, '$1'))
    setRefs((prev) => (prev.some((r) => r.label === c.label && r.kind === c.kind) ? prev : [...prev, c]))
    setMentionFilter(null)
  }

  useEffect(() => {
    loadSessions()
    // Coding tasks carry their own model preference (defaults to Fable 5).
    window.asit.settings.get().then((s) => setModel(task.coding ? s.codingModel : s.chatModel))
    window.asit.usage.task(task.id).then((u) => setTaskCost(u.costUsd))
    const offUsage = window.asit.on(IPC.USAGE_UPDATED, () => {
      window.asit.usage.task(task.id).then((u) => setTaskCost(u.costUsd))
    })
    return offUsage
  }, [loadSessions, task.id])

  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      return
    }
    window.asit.chat.history(sessionId).then(setMessages)
    setStreaming('')
    setError(null)
    setStatus(null)
    setBusy(false)
    // A reply may still be running from before we left this task — pick the
    // busy/Stop state back up so the turn stays controllable.
    window.asit.chat.running().then((ids) => {
      if (ids.includes(sessionId)) {
        setBusy(true)
        setStatus('Reply in progress…')
      }
    })
  }, [sessionId])

  useEffect(() => {
    const offStream = window.asit.on(IPC.CHAT_STREAM, (...args: unknown[]) => {
      const p = args[0] as StreamPayload
      if (p.chatSessionId !== sessionIdRef.current) return
      setStatus(null)
      setStreaming((prev) => prev + (p.delta ?? ''))
    })
    const offStatus = window.asit.on(IPC.CHAT_STATUS, (...args: unknown[]) => {
      const p = args[0] as StreamPayload
      if (p.chatSessionId !== sessionIdRef.current) return
      setStatus(p.status ?? null)
      if (p.status) {
        setSteps((prev) => (prev[prev.length - 1] === p.status ? prev : [...prev, p.status!]))
      }
    })
    const offUsageTick = window.asit.on(IPC.CHAT_USAGE, (...args: unknown[]) => {
      const p = args[0] as StreamPayload
      if (p.chatSessionId !== sessionIdRef.current) return
      setLiveTokens(p.outputTokens ?? 0)
    })
    const offDone = window.asit.on(IPC.CHAT_DONE, (...args: unknown[]) => {
      const p = args[0] as StreamPayload
      if (p.chatSessionId !== sessionIdRef.current) return
      setStreaming('')
      setStatus(null)
      setSteps([])
      setBusy(false)
      setLiveTokens(0)
      if (p.usage) {
        setLastTurn({
          tokens: p.usage.inputTokens + p.usage.outputTokens,
          costUsd: p.usage.costUsd
        })
      }
      window.asit.chat.history(p.chatSessionId).then(setMessages)
      // Refresh the session list so the auto-title (first message) shows up.
      loadSessions().catch(() => undefined)
      // Turn finished → send the next queued message (unless paused).
      if (pumpTimerRef.current) clearTimeout(pumpTimerRef.current)
      pumpTimerRef.current = setTimeout(() => pumpRef.current?.(), 80)
    })
    const offError = window.asit.on(IPC.CHAT_ERROR, (...args: unknown[]) => {
      const p = args[0] as StreamPayload
      if (p.chatSessionId !== sessionIdRef.current) return
      setStreaming('')
      setStatus(null)
      setSteps([])
      setBusy(false)
      setError(p.message ?? 'Something went wrong.')
      // Don't march through the queue against a failing chat — pause it.
      if (queueRef.current.length > 0) setQueuePaused(true)
    })
    return () => {
      offStream()
      offStatus()
      offUsageTick()
      offDone()
      offError()
      if (pumpTimerRef.current) clearTimeout(pumpTimerRef.current) // no pump after unmount
    }
  }, [loadSessions])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming, busy, status])

  // Elapsed-time ticker while a reply is in flight.
  useEffect(() => {
    if (!busy) {
      setElapsedSec(0)
      return
    }
    const startedAt = Date.now()
    const t = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [busy])

  function copyMessage(id: string, content: string): void {
    navigator.clipboard.writeText(content)
    setCopiedId(id)
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1200)
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId
    const s = await window.asit.chat.newSession(task.id)
    setSessions((prev) => [s, ...prev])
    setSessionId(s.id)
    return s.id
  }

  async function sendOutgoing(outgoing: string): Promise<void> {
    setBusy(true)
    setError(null)
    setSteps([])
    setStatus('Starting Claude…')
    pinnedRef.current = true // sending always snaps back to the bottom
    let sid: string
    try {
      sid = await ensureSession()
    } catch (err) {
      setBusy(false)
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Could not start a chat session.')
      return
    }
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        chatSessionId: sid,
        role: 'user',
        content: outgoing,
        createdAt: new Date().toISOString()
      }
    ])
    // Optimistic title so the dropdown never shows "Untitled chat" after use.
    setSessions((prev) =>
      prev.map((s) => (s.id === sid && !s.title ? { ...s, title: outgoing.slice(0, 60) } : s))
    )
    try {
      await window.asit.chat.send(sid, outgoing)
    } catch (err) {
      setBusy(false)
      setStatus(null)
      setError(err instanceof Error ? err.message : 'Failed to send message.')
    }
  }
  sendOutgoingRef.current = sendOutgoing

  function pumpQueue(): void {
    if (queuePausedRef.current || busyRef.current) return
    const [next, ...rest] = queueRef.current
    if (next === undefined) return
    setQueue(rest)
    void sendOutgoingRef.current?.(next)
  }
  const pumpRef = useRef<() => void>()
  pumpRef.current = pumpQueue

  async function handleSend(): Promise<void> {
    const text = input.trim()
    if (!text && refs.length === 0) return
    const busyAtEntry = busyRef.current
    const fileChips = refs.filter((r) => r.kind === 'file')
    const skillChips = refs.filter((r) => r.kind === 'skill')
    // Auto-flow skills replay INSTANTLY in the app — no model, no tokens.
    const autoSkills = skillChips.filter((s) => s.content?.includes('```asit-flow'))
    const narrativeSkills = skillChips.filter((s) => !s.content?.includes('```asit-flow'))

    setRefs([])
    setMentionFilter(null)
    setInput('')

    // Auto-skills execute immediately, even while a reply is streaming — they
    // drive the panes, not the conversation.
    const ranAuto: string[] = []
    for (const s of autoSkills) {
      if (!busyAtEntry) setStatus(` Running ./${s.label}…`)
      const result = await window.asit.skills.run(task.id, s.label)
      ranAuto.push(s.label)
      setMessages((prev) => [
        ...prev,
        {
          id: `local-skill-${Date.now()}-${s.label}`,
          chatSessionId: sessionId ?? 'local',
          role: 'assistant',
          content: ` Ran **./${s.label}** — ${result.log.length} steps:\n${result.log.map((l) => `- ${l}`).join('\n')}`,
          createdAt: new Date().toISOString()
        }
      ])
    }
    if (!busyAtEntry) setStatus(null)

    const parts: string[] = []
    if (fileChips.length > 0) {
      parts.push(
        `Referenced files (read these first):\n${fileChips.map((r) => `- ${r.line}`).join('\n')}`
      )
    }
    for (const s of narrativeSkills) {
      parts.push(
        [
          `EXECUTE the saved skill "./${s.label}" RIGHT NOW by DISPATCHING app actions (append to .asit/actions.ndjson, then verify via actions-result.md — the act→verify loop).`,
          'The steps below DESCRIBE the flow — perform them with actions, do not narrate them back or merely restate them.',
          'NEVER claim to be waiting: you cannot wait. For pauses ≤10s use {"action":"wait","ms":…} between actions; for anything longer (boots, videos, dialogs populating) arm a {"action":"watch",…} and end your turn.',
          'If the flow succeeds end-to-end, immediately save_skill an AUTO-FLOW version (```asit-flow block, label targeting) so future ./ invocations run instantly without you.',
          '',
          s.content ?? ''
        ].join('\n')
      )
    }
    if (ranAuto.length > 0 && (text || narrativeSkills.length > 0)) {
      parts.push(
        `The skill(s) ${ranAuto.map((n) => `"./${n}"`).join(', ')} were just EXECUTED automatically. Fresh page snapshots of the result are in .asit/pages/ — read them before answering.`
      )
    }
    if (text || narrativeSkills.length > 0 || fileChips.length > 0) {
      parts.push(
        text || (narrativeSkills.length > 0 ? 'Run the skill(s) above.' : 'Use the referenced files.')
      )
    } else {
      return // pure auto-skill invocation: done, no model turn at all
    }
    const outgoing = parts.join('\n\n')

    if (busyAtEntry) {
      setQueue((prev) => [...prev, outgoing]) // reply in flight → queue it
      return
    }
    await sendOutgoing(outgoing)
  }

  async function handleNewChat(): Promise<void> {
    const s = await window.asit.chat.newSession(task.id)
    setSessions((prev) => [s, ...prev])
    setSessionId(s.id)
  }

  function handleCancel(): void {
    if (sessionId) window.asit.chat.cancel(sessionId)
    setBusy(false)
    setStreaming('')
    setStatus(null)
    // Stop means stop: pause the queue too (resume/clear from the queue bar).
    if (queueRef.current.length > 0) setQueuePaused(true)
  }

  function resumeQueue(): void {
    setQueuePaused(false)
    queuePausedRef.current = false
    setTimeout(() => pumpRef.current?.(), 0)
  }

  async function handleModelChange(value: string): Promise<void> {
    setModel(value)
    await window.asit.settings.set(task.coding ? { codingModel: value } : { chatModel: value })
  }

  return (
    <div className="chat-panel" data-focus-zone="Chat">
      <div className="chat-header">
        <select
          value={sessionId ?? ''}
          onChange={(e) => setSessionId(e.target.value || null)}
          className="chat-session-select"
        >
          {sessions.length === 0 && <option value="">New chat</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title ?? 'New chat'}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost" title="New chat" onClick={handleNewChat}>
          +
        </button>
      </div>

      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && !busy && (
          <div className="chat-empty">
            <p>
              {task.coding
                ? 'Coding agent ready — it can run commands, edit files, and iterate in this task folder. Try “set up a python script that pulls the Kaggle dataset”.'
                : 'Ask anything about this task. Claude already has your notes, PDFs, and task context — no need to explain.'}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg-wrap chat-wrap-${m.role}`}>
            <div className={`chat-msg chat-${m.role}`}>
              {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
            </div>
            <button
              className="msg-copy"
              title="Copy message"
              onClick={() => copyMessage(m.id, m.content)}
            >
              {copiedId === m.id ? '✓' : '⧉'}
            </button>
          </div>
        ))}
        {streaming && (
          <div className="chat-msg chat-assistant">
            <Markdown text={streaming} />
          </div>
        )}
        {busy && (
          <div className="agent-steps">
            {steps.length > 8 && (
              <div className="agent-step agent-step-done">… {steps.length - 8} earlier steps</div>
            )}
            {steps.slice(-8).map((s, i, arr) => (
              <div
                key={`${i}-${s}`}
                className={`agent-step ${i === arr.length - 1 && !streaming ? 'agent-step-live' : 'agent-step-done'}`}
              >
                {i === arr.length - 1 && !streaming ? (
                  <span className="working-dot" />
                ) : (
                  <span className="agent-step-check">✓</span>
                )}
                {s}
              </div>
            ))}
            {(steps.length === 0 || streaming) && (
              <div className="agent-step agent-step-live">
                <span className="working-dot" />
                {streaming ? 'Writing reply…' : 'Thinking…'}
              </div>
            )}
            <div className="agent-steps-meta">
              {elapsedSec > 0 && `${elapsedSec}s`}
              {liveTokens > 0 && ` · ${fmtTokens(liveTokens)} tok`}
            </div>
          </div>
        )}
        {error && <div className="chat-msg chat-error">{error}</div>}
      </div>

      <div className="chat-input-row">
        {queue.length > 0 && (
          <div className="queue-bar">
            <span className="queue-count">
              {queue.length} queued{queuePaused ? ' · paused' : ''}
            </span>
            <div className="queue-items">
              {queue.map((q, i) => (
                <span key={i} className="queue-item" title={q}>
                  {q.replace(/\s+/g, ' ').slice(0, 40)}
                  <button
                    onClick={() => setQueue((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {queuePaused && (
              <button className="btn btn-ghost queue-btn" onClick={resumeQueue}>
                ▶ Resume
              </button>
            )}
            <button
              className="btn btn-ghost queue-btn"
              onClick={() => {
                setQueue([])
                setQueuePaused(false)
              }}
            > Clear
            </button>
          </div>
        )}
        {mentionFilter !== null && (mentionMatches.length > 0 || mentionKind === 'skill') && (
          <div className="mention-popup">
            <div className="mention-hint">
              {mentionKind === 'skill' ? ' Invoke a skill' : 'Reference a file'}
            </div>
            {mentionMatches.length === 0 && mentionKind === 'skill' && (
              <div className="mention-empty"> No skills yet — ask the chat to “save this flow as a skill” after it works
                something out.
              </div>
            )}
            {mentionMatches.map((c, i) => (
              <button
                key={`${c.kind}-${c.label}`}
                className={`mention-item ${i === mentionIndex ? 'mention-active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectMention(c)
                }}
              >
                {c.kind === 'skill'
                  ? c.content?.includes('```asit-flow')
                    ? ''
                    : ''
                  : '▤'}{' '}
                {c.label}
                {c.kind === 'skill' && !c.content?.includes('```asit-flow') && (
                  <span className="mention-tag">agent-run</span>
                )}
                {c.kind === 'skill' && (
                  <span
                    className="mention-delete"
                    title="Delete skill"
                    onMouseDown={async (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      await window.asit.skills.delete(c.label)
                      setSkillList(await window.asit.skills.list())
                    }}
                  >
                    🗑
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {refs.length > 0 && (
          <div className="ref-chips">
            {refs.map((r) => (
              <span
                key={`${r.kind}-${r.label}`}
                className={`ref-chip ${r.kind === 'skill' ? 'ref-chip-skill' : ''}`}
                title={
                  r.kind === 'skill' && !r.content?.includes('```asit-flow')
                    ? 'Narrative skill — executed BY the agent (ask it to save an auto-flow version for instant replay)'
                    : undefined
                }
              >
                {r.kind === 'skill' ? (r.content?.includes('```asit-flow') ? '' : '') : '▥'}{' '}
                {r.label}
                <button
                  onClick={() =>
                    setRefs((prev) => prev.filter((x) => !(x.label === r.label && x.kind === r.kind)))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-input-box">
          <textarea
            data-focus-target
            placeholder="Ask about this task… ( / to reference a file )"
            value={input}
            rows={2}
            onChange={(e) => {
              const v = expand(e.target.value)
              setInput(v)
              detectMention(v)
            }}
            onKeyDown={(e) => {
              if (mentionMatches.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIndex((i) => (i + 1) % mentionMatches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  selectMention(mentionMatches[mentionIndex])
                  return
                }
                if (e.key === 'Escape') {
                  setMentionFilter(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          {busy ? (
            <button className="assistant-send chat-send" title="Stop" onClick={handleCancel}>
              ◼
            </button>
          ) : (
            <button
              className="assistant-send chat-send"
              title="Send"
              onClick={handleSend}
              disabled={!input.trim() && refs.length === 0}
            >
              ➤
            </button>
          )}
        </div>
      </div>
      <div className="chat-footer">
        {task.coding && (
          <span className="coding-agent-label" title="Coding task: command execution enabled, 15-min turns">
            ⌗ Coding agent
          </span>
        )}
        <select
          className="chat-model-select"
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}
          title={task.coding ? 'Model for this coding agent (saved for all coding tasks)' : 'Model used for chat replies'}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="chat-usage" title="Last turn · this task's total AI usage (API-equivalent value; covered by your subscription)">
          {lastTurn && `${fmtTokens(lastTurn.tokens)} tok · ${fmtCost(lastTurn.costUsd)} — `}
          task {fmtCost(taskCost)}
        </span>
      </div>
    </div>
  )
}
