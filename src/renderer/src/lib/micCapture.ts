// The microphone, owned in ONE place.
//
// Capture used to live inside JarvisPanel, which tied the mic to that panel's
// lifetime and meant anything else wanting audio would have to build a second
// getUserMedia + AudioContext. Two AudioContexts on one device is not a
// theoretical problem: they fight over the input, and whichever loses simply
// records silence.
//
// The mic is acquired once and kept warm; audio only leaves for main while a
// gate is open. That is what makes activation instant — no device negotiation,
// no context build — which is what stops the first word of an utterance from
// being swallowed.

let capture: { ctx: AudioContext; stream: MediaStream } | null = null
let warming: Promise<void> | null = null
let gateCount = 0

/** Acquire the device (idempotent, single-flight). Safe to call eagerly. */
export async function warmMic(): Promise<void> {
  if (capture) return
  if (warming) return warming
  warming = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    if (capture) {
      stream.getTracks().forEach((t) => t.stop()) // lost a race
      return
    }
    const ctx = new AudioContext({ sampleRate: 16000 })
    const source = ctx.createMediaStreamSource(stream)
    const proc = ctx.createScriptProcessor(2048, 1, 1)
    proc.onaudioprocess = (e) => {
      if (gateCount <= 0) return // warm, but nobody is listening
      window.asit.voice.chunk(e.inputBuffer.getChannelData(0).slice().buffer)
    }
    source.connect(proc)
    proc.connect(ctx.destination)
    capture = { ctx, stream }
  })().finally(() => {
    warming = null
  })
  return warming
}

/**
 * Open the gate while you need audio; call the returned function to close it.
 * Counted rather than boolean, so Jarvis and dictation closing independently
 * can't cut each other off.
 */
export function openMicGate(): () => void {
  gateCount++
  let closed = false
  return () => {
    if (closed) return
    closed = true
    gateCount = Math.max(0, gateCount - 1)
  }
}

export function micIsOpen(): boolean {
  return gateCount > 0
}

export function releaseMic(): void {
  gateCount = 0
  const c = capture
  capture = null
  if (c) {
    c.stream.getTracks().forEach((t) => t.stop())
    void c.ctx.close()
  }
}
