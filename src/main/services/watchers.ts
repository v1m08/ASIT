import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { getDb, newId } from '../db'
import { paneManager } from './panes'
import { clearActivity, reportActivity } from './activity'
import * as chat from './chat'
import { listSkills, extractFlow } from './skills'
import { runFlow, appendResultNote } from './actions'

// The agent's "pick it up later" primitive. A model turn ENDS when it replies
// — it cannot keep watching anything. Instead it registers a watch: the APP
// polls the open pages locally (no model, no tokens) and, when the condition
// is met, either starts a new chat turn with a prompt or replays a skill.
//
// Conditions:  label (enabled element appears) · text (page text appears)
//              gone_label / gone_text (fires when it DISAPPEARS)

interface WatchOpts {
  label?: string
  text?: string
  gone_label?: string
  gone_text?: string
  page?: number
  prompt?: string
  skill?: string
  timeout_min?: number
}

interface Watcher {
  id: string
  taskId: string
  describe: string
  opts: WatchOpts
  interval: NodeJS.Timeout
  expiresAt: number
}

let getWindow: (() => BrowserWindow | null) | null = null
const watchers = new Map<string, Watcher>()
const MAX_WATCHERS = 3

export function initWatchers(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
}

function toast(text: string): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.APP_EVENT, { type: 'toast', text })
}

function latestChatSessionId(taskId: string): string | null {
  const row = getDb()
    .prepare(
      'SELECT id FROM chat_sessions WHERE task_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 1'
    )
    .get(taskId) as { id: string } | undefined
  return row?.id ?? null
}

// The condition may hit while a turn is still streaming — keep retrying for
// 15 minutes so the resume is never silently dropped.
function sendWhenFree(sessionId: string, prompt: string, attempts = 90): void {
  const win = getWindow?.()
  if (!win || win.isDestroyed()) return
  if (chat.runningSessionIds().includes(sessionId)) {
    if (attempts > 0) setTimeout(() => sendWhenFree(sessionId, prompt, attempts - 1), 10000)
    else toast('👁 Watch fired but the chat stayed busy for 15 minutes — resume dropped')
    return
  }
  void chat.sendChat(sessionId, prompt, win.webContents)
}

async function conditionMet(opts: WatchOpts): Promise<boolean> {
  if (opts.label || opts.text) {
    return paneManager.existsCondition({ label: opts.label, text: opts.text }, opts.page)
  }
  if (opts.gone_label || opts.gone_text) {
    const present = await paneManager.existsCondition(
      { label: opts.gone_label, text: opts.gone_text },
      opts.page
    )
    return !present
  }
  return false
}

function describeCondition(opts: WatchOpts): string {
  if (opts.label) return `"${opts.label}" becomes clickable`
  if (opts.text) return `text "${opts.text}" appears`
  if (opts.gone_label) return `"${opts.gone_label}" disappears`
  if (opts.gone_text) return `text "${opts.gone_text}" disappears`
  return 'condition'
}

function stopWatch(id: string): void {
  const w = watchers.get(id)
  if (!w) return
  clearInterval(w.interval)
  watchers.delete(id)
  clearActivity(id)
}

export async function startWatch(taskId: string, opts: WatchOpts): Promise<string> {
  const conditionCount = [opts.label, opts.text, opts.gone_label, opts.gone_text].filter(
    Boolean
  ).length
  if (conditionCount !== 1)
    return 'watch: provide exactly ONE condition — label | text | gone_label | gone_text'
  if (!opts.prompt && !opts.skill) return 'watch: provide "prompt" or "skill" to run when it fires'

  const describe = describeCondition(opts)

  // Arm-time sanity: a condition that's ALREADY met would fire instantly —
  // that's always a mis-chosen condition for a "wait" (e.g. Continue exists
  // but you meant "when the quiz appears"). Reject with guidance instead.
  if (await conditionMet(opts)) {
    return `watch REJECTED: the condition (${describe}) is ALREADY met right now — it would fire immediately. Pick something that only becomes true when the wait is over: the text that appears AFTER the video (quiz heading, "completed"), or gone_label of the player's current control.`
  }

  for (const [id, w] of watchers) {
    if (w.taskId === taskId && w.describe === describe) stopWatch(id)
  }
  if (watchers.size >= MAX_WATCHERS) return `watch: already watching ${MAX_WATCHERS} things — too many`

  const id = `watch-${newId()}`
  const timeoutMin = Math.min(120, Math.max(1, opts.timeout_min ?? 30))
  const expiresAt = Date.now() + timeoutMin * 60000

  const interval = setInterval(async () => {
    const w = watchers.get(id)
    if (!w) return
    if (Date.now() > w.expiresAt) {
      stopWatch(id)
      toast(`👁 Watch expired: ${describe} never happened`)
      appendResultNote(taskId, `WATCH EXPIRED after ${timeoutMin}m: ${describe} never happened.`)
      return
    }
    let met = false
    try {
      met = await conditionMet(opts)
    } catch {
      met = false
    }
    if (!met) return

    stopWatch(id)
    appendResultNote(taskId, `WATCH FIRED: ${describe}.`)
    if (opts.skill) {
      const skill = listSkills().find((s) => s.name === opts.skill)
      const flow = skill ? extractFlow(skill.content) : null
      if (flow) {
        toast(`👁 ${describe} — running ./${opts.skill}`)
        await runFlow(taskId, flow as never)
      } else {
        toast(`👁 ${describe}, but skill "./${opts.skill}" has no auto-flow`)
        appendResultNote(taskId, `WATCH: skill "./${opts.skill}" had no auto-flow block — nothing ran.`)
      }
      return
    }
    const sessionId = latestChatSessionId(taskId)
    if (sessionId && opts.prompt) {
      toast(`👁 ${describe} — resuming the agent`)
      sendWhenFree(sessionId, opts.prompt)
    }
  }, 4000)

  watchers.set(id, { id, taskId, describe, opts, interval, expiresAt })
  reportActivity(id, {
    kind: 'watch',
    taskId,
    label: `👁 ${(opts.label ?? opts.text ?? opts.gone_label ?? opts.gone_text ?? '').slice(0, 30)}`,
    detail: `Waiting until ${describe} (up to ${timeoutMin}m) — then ${opts.skill ? `run ./${opts.skill}` : 'resume the agent'}`
  })
  return `watch ARMED: when ${describe}, ${opts.skill ? `./${opts.skill} runs` : 'the agent resumes'} (expires in ${timeoutMin}m)`
}
