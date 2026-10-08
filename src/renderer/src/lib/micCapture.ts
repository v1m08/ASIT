// The microphone, owned in ONE place.
//
// Capture used to live inside JarvisPanel, which tied the mic to that panel's
// lifetime and meant anything else wanting audio would have to build a second
// getUserMedia + AudioContext. Two AudioContexts on one device is not a
// theoretical problem: they fight over the input, and whichever loses simply
// records silence.
//
// The device is held ONLY while someone is listening. It used to be kept warm
// whenever the assistant panel was open, and on macOS that is not free: the
// orange mic indicator stays lit the whole time, and Bluetooth headsets
// (AirPods) are forced out of A2DP into the low-quality call profile — music
// turns to mush just because a panel is open. getUserMedia on a Mac takes well
// under 100ms, so acquiring per activation costs almost nothing.
//
// Callers hold a counted lease (Jarvis and dictation can overlap); the last
// release stops the tracks and closes the context.
//
// Audio is pulled through an AudioWorklet on the audio thread — the old
// ScriptProcessorNode is deprecated and ran on the UI thread, where any long
// React render dropped frames (= lost syllables). The worklet is inlined as a
// blob: module (CSP allows blob: for scripts for exactly this) because a
// worklet fetched from file:// fails the CORS fetch worklets require.

const WORKLET_SRC = `
class AsitMicTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(1024)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      let i = 0
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n)
        this.buf.set(ch.subarray(i, i + take), this.n)
        this.n += take
        i += take
        if (this.n === this.buf.length) {
          const out = this.buf
          this.port.postMessage(out.buffer, [out.buffer])
          this.buf = new Float32Array(1024)
          this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('asit-mic-tap', AsitMicTap)
`

let workletUrl: string | null = null
function getWorkletUrl(): string {
  if (!workletUrl)
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
  return workletUrl
}

let capture: { ctx: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null = null
let acquiring: Promise<void> | null = null
let leases = 0

function teardown(): void {
  const c = capture
  capture = null
  if (!c) return
  c.node.port.onmessage = null
  try {
    c.node.disconnect()
  } catch {
    // already gone
  }
  c.stream.getTracks().forEach((t) => t.stop())
  void c.ctx.close().catch(() => undefined)
}

async function open(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  let ctx: AudioContext | null = null
  try {
    // Chromium resamples the device to the context rate, so main receives
    // 16kHz mono — what the VAD and recognizer want — with no JS resampler.
    ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.audioWorklet.addModule(getWorkletUrl())
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'asit-mic-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit'
    })
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (leases > 0) window.asit.voice.chunk(e.data)
    }
    source.connect(node)
    // Outputs silence; connecting to the destination is what guarantees the
    // graph is pulled and process() keeps running.
    node.connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume()
    capture = { ctx, stream, node }
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop())
    if (ctx) void ctx.close().catch(() => undefined)
    throw err
  }
}

/**
 * Start capturing and streaming 16kHz Float32 chunks to main. Resolves once
 * audio is flowing; call the returned function to release. The device is
 * released as soon as the last holder lets go.
 */
export async function acquireMic(): Promise<() => void> {
  leases++
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    leases = Math.max(0, leases - 1)
    if (leases === 0 && !acquiring) teardown()
  }
  try {
    if (!capture) {
      if (!acquiring)
        acquiring = open().finally(() => {
          acquiring = null
        })
      await acquiring
    }
  } catch (err) {
    release()
    throw new Error(describeMicError(err))
  }
  // Every holder let go while the device was opening — don't keep it.
  if (leases === 0) teardown()
  return release
}

export function micIsOpen(): boolean {
  return leases > 0
}

/** Drop every lease and the device. */
export function releaseMic(): void {
  leases = 0
  teardown()
}

function describeMicError(err: unknown): string {
  const name = (err as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return navigator.platform.startsWith('Mac')
      ? 'Microphone access is off for ASIT — allow it in System Settings → Privacy & Security → Microphone.'
      : 'Microphone access was refused — allow it in Windows Settings → Privacy → Microphone.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.'
  if (name === 'NotReadableError') return 'The microphone is in use by another app or unavailable.'
  return err instanceof Error ? err.message : String(err)
}

/** An error from a voice IPC call, minus Electron's "Error invoking remote method" wrapper. */
export function voiceErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
