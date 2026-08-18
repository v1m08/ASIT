import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-contract'
import { useStore } from '../store/useStore'
import { openMicGate, warmMic } from '../lib/micCapture'

// Dictate into whatever has focus.
//
// The old voice feature had exactly one shape: say a thing, Jarvis answers,
// Jarvis speaks. Useful, but it is not what you want 90% of the time — most of
// the time you just want the words you said to appear in the box you are
// looking at. This is that.
//
// Where the words go is decided HERE rather than in main, because only the
// renderer knows whether one of its own fields has focus. If none does, the
// focus is inside an embedded page — those pixels belong to a WebContentsView
// and app DOM cannot reach into it, so main types it in for us.

/** Insert at the caret, preserving undo, in the field that has focus. */
function insertIntoFocusedField(el: HTMLElement, text: string): boolean {
  const input = el as HTMLInputElement | HTMLTextAreaElement
  const isTextBox =
    (el.tagName === 'INPUT' && /^(text|search|url|email|tel|password|number|)$/i.test(input.type)) ||
    el.tagName === 'TEXTAREA'
  if (!isTextBox && !el.isContentEditable) return false

  // execCommand is deprecated but it is the ONLY way to insert text that
  // lands on the browser's own undo stack. Setting .value directly makes the
  // text un-undoable and blows away CodeMirror's document state.
  if (document.execCommand('insertText', false, text)) return true

  if (isTextBox) {
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const next = input.value.slice(0, start) + text + input.value.slice(end)
    if (setter) setter.call(input, next)
    else input.value = next
    input.setSelectionRange(start + text.length, start + text.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  return false
}

/**
 * Space between phrases, but not before punctuation and not at the start of a
 * line — otherwise a dictated paragraph comes out as " Hello , world ."
 */
function joinWith(previousChar: string, text: string): string {
  if (!previousChar || /[\s(\n]$/.test(previousChar)) return text
  if (/^[,.;:!?)]/.test(text) || text.startsWith('\n')) return text
  return ' ' + text
}

export default function Dictation(): JSX.Element | null {
  const [on, setOn] = useState(false)
  const tick = useStore((s) => s.dictateTick)
  const seen = useRef(tick)
  const closeGate = useRef<(() => void) | null>(null)

  const stop = useCallback((): void => {
    closeGate.current?.()
    closeGate.current = null
    setOn(false)
    void window.asit.voice.dictateStop()
  }, [])

  const start = useCallback(async (): Promise<void> => {
    const status = await window.asit.voice.status()
    if (!status.modelsReady) {
      useStore
        .getState()
        .pushNotice('Speech models are not downloaded yet — Settings → Voice.', 'error')
      return
    }
    await warmMic()
    await window.asit.voice.dictateStart()
    closeGate.current?.()
    closeGate.current = openMicGate()
    setOn(true)
  }, [])

  // Ctrl+Shift+Space bumps a counter in the store (the key may have been
  // pressed inside a page, in which case it reaches main first and comes back
  // as an app event) — same pattern the Jarvis mic toggle uses.
  useEffect(() => {
    if (tick === seen.current) return
    seen.current = tick
    if (on) stop()
    else void start()
  }, [tick, on, start, stop])

  // This lives in the header, which is remounted when you move between Home
  // and a workspace. Without this the gate ref goes with it and audio keeps
  // streaming to main forever.
  useEffect(() => {
    return () => {
      closeGate.current?.()
      closeGate.current = null
      void window.asit.voice.dictateStop()
    }
  }, [])

  useEffect(() => {
    return window.asit.on(IPC.VOICE_DICTATE_TEXT, (...args: unknown[]) => {
      const { text } = args[0] as { text: string }
      if (!text) return
      const el = document.activeElement as HTMLElement | null
      const target =
        el && el !== document.body && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName))
          ? el
          : null

      if (target) {
        const before =
          target.isContentEditable
            ? (window.getSelection()?.anchorNode?.textContent ?? '').slice(-1)
            : (target as HTMLInputElement).value.slice(
                Math.max(0, ((target as HTMLInputElement).selectionStart ?? 1) - 1),
                (target as HTMLInputElement).selectionStart ?? 0
              )
        if (insertIntoFocusedField(target, joinWith(before, text))) return
      }
      // Nothing of ours has focus, so a page does. Main can type into it.
      void window.asit.panes.insertText(joinWith(' ', text).trimStart() + ' ')
    })
  }, [])

  // Stop dictating if the window loses focus — otherwise you go to another
  // app, keep talking, and come back to a paragraph you didn't mean to write.
  useEffect(() => {
    if (!on) return
    const onBlur = (): void => stop()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') stop()
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKey)
    }
  }, [on, stop])

  if (!on) return null

  return (
    <button className="dictating-pill" onClick={stop} title="Stop dictating (Ctrl+Shift+Space)">
      <span className="working-dot" />
      Dictating… <span className="dictating-hint">Esc or click to stop</span>
    </button>
  )
}
