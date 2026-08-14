import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { join } from 'path'
import { IPC } from '@shared/ipc-contract'
import { askJarvis } from './jarvis'

// Voice: ears and a mouth on the SAME Jarvis core the panel and phone use.
// Design for "lightweight + fast":
//   ears   silero VAD (2MB) + Moonshine-tiny int8 (~130MB total, one-time
//          download) via sherpa-onnx — fully local, decodes an utterance in
//          a few hundred ms on CPU. You talk; ~0.7s of silence finalizes.
//   mouth  the Windows speech engine (zero download, starts speaking
//          instantly). A premium local voice (Kokoro) can slot in later —
//          it's one config object away, same pipeline.
//   brain  askJarvis() — bounded session, full app control, unchanged.
//
// The heavy native module loads lazily on first use: voice OFF costs zero
// RAM/startup time.

const MODEL_BASE = 'https://huggingface.co/csukuangfj'
const MODELS: { name: string; url: string; minBytes: number }[] = [
  {
    name: 'silero_vad.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    minBytes: 500_000
  },
  {
    name: 'preprocess.onnx',
    url: `${MODEL_BASE}/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/preprocess.onnx`,
    minBytes: 100_000
  },
  {
    name: 'encode.int8.onnx',
    url: `${MODEL_BASE}/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/encode.int8.onnx`,
    minBytes: 1_000_000
  },
  {
    name: 'uncached_decode.int8.onnx',
    url: `${MODEL_BASE}/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/uncached_decode.int8.onnx`,
    minBytes: 1_000_000
  },
  {
    name: 'cached_decode.int8.onnx',
    url: `${MODEL_BASE}/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/cached_decode.int8.onnx`,
    minBytes: 1_000_000
  },
  {
    name: 'tokens.txt',
    url: `${MODEL_BASE}/sherpa-onnx-moonshine-tiny-en-int8/resolve/main/tokens.txt`,
    minBytes: 10_000
  }
]

function modelsDir(): string {
  return join(app.getPath('userData'), 'voice-models')
}

export function voiceModelsReady(): boolean {
  return MODELS.every((m) => {
    const p = join(modelsDir(), m.name)
    return existsSync(p) && statSync(p).size >= m.minBytes
  })
}

let downloading = false

export async function downloadVoiceModels(
  onProgress: (pct: number, file: string) => void
): Promise<void> {
  if (downloading) throw new Error('already downloading')
  downloading = true
  try {
    mkdirSync(modelsDir(), { recursive: true })
    for (let i = 0; i < MODELS.length; i++) {
      const m = MODELS[i]
      const dest = join(modelsDir(), m.name)
      if (existsSync(dest) && statSync(dest).size >= m.minBytes) continue
      onProgress(Math.round((i / MODELS.length) * 100), m.name)
      const res = await fetch(m.url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`${m.name}: HTTP ${res.status}`)
      // Download to a .part file, verify, then rename. A crash mid-file must
      // never leave a truncated model under its final name — voiceModelsReady
      // would accept it and every voiceStart would fail forever with no
      // re-download offered. pipeline() handles stream errors + backpressure.
      const part = dest + '.part'
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part))
      const expected = Number(res.headers.get('content-length') ?? 0)
      const actual = statSync(part).size
      if (actual < m.minBytes || (expected > 0 && actual !== expected))
        throw new Error(`${m.name}: truncated download (${actual}/${expected || '?'} bytes)`)
      renameSync(part, dest)
    }
    onProgress(100, 'done')
  } finally {
    downloading = false
  }
}

// ---------------------------------------------------------------------------
// Recognition pipeline (lazy-loaded)
// ---------------------------------------------------------------------------

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  isDetected(): boolean
  pop(): void
  front(enableExternalBuffer: boolean): { samples: Float32Array; start: number }
  flush(): void
  reset(): void
}

interface SherpaRecognizer {
  createStream(): {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
  }
  decode(stream: unknown): void
  getResult(stream: unknown): { text: string }
}

let vad: SherpaVad | null = null
let recognizer: SherpaRecognizer | null = null
let engineInit: Promise<void> | null = null

// Single-flight: two rapid Ctrl+Space presses must not construct the native
// engine twice (the wrapper exposes no free() — a duplicate pair would leak
// the whole model's RAM).
function ensureEngine(): Promise<void> {
  if (vad && recognizer) return Promise.resolve()
  if (engineInit) return engineInit
  engineInit = buildEngine().finally(() => {
    engineInit = null
  })
  return engineInit
}

async function buildEngine(): Promise<void> {
  if (!voiceModelsReady()) throw new Error('voice models not downloaded')
  // CJS interop: rollup wraps the module — the classes live on .default.
  const mod = (await import('sherpa-onnx-node')) as unknown as Record<string, unknown>
  const sherpa = (mod.default ?? mod) as typeof import('sherpa-onnx-node')
  const dir = modelsDir()
  // Recognizer FIRST: if a corrupt model makes it throw, we must not leak a
  // freshly-built Vad on every retry (no free() in the wrapper).
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      moonshine: {
        preprocessor: join(dir, 'preprocess.onnx'),
        encoder: join(dir, 'encode.int8.onnx'),
        uncachedDecoder: join(dir, 'uncached_decode.int8.onnx'),
        cachedDecoder: join(dir, 'cached_decode.int8.onnx')
      },
      tokens: join(dir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu'
    }
  }) as SherpaRecognizer
  vad = new sherpa.Vad(
    {
      sileroVad: {
        model: join(dir, 'silero_vad.onnx'),
        threshold: 0.5,
        minSilenceDuration: 0.7, // your pause IS the send button
        minSpeechDuration: 0.2,
        maxSpeechDuration: 30,
        windowSize: 512
      },
      sampleRate: 16000,
      numThreads: 1
    },
    60
  ) as SherpaVad
}

// Smoke-test hook: run samples through the EXACT ingest path a live mic uses
// (chunked acceptAudioChunk → VAD windows → front(false) → transcribe). The
// first voice crash in the field was in a VAD call the ASR-only smoke never
// touched — this closes that gap permanently.
export async function transcribeViaVadPath(samples: Float32Array): Promise<string> {
  await ensureEngine()
  vad!.reset()
  const texts: string[] = []
  const collect = async (): Promise<void> => {
    while (!vad!.isEmpty()) {
      const segment = vad!.front(false)
      vad!.pop()
      texts.push(await transcribeSamples(segment.samples))
    }
  }
  // Feed like the renderer does: irregular ~2048-sample chunks.
  let pendingLocal = new Float32Array(0)
  for (let i = 0; i < samples.length; i += 2048) {
    const chunk = samples.subarray(i, Math.min(i + 2048, samples.length))
    const merged = new Float32Array(pendingLocal.length + chunk.length)
    merged.set(pendingLocal)
    merged.set(chunk, pendingLocal.length)
    let offset = 0
    while (offset + 512 <= merged.length) {
      vad!.acceptWaveform(merged.subarray(offset, offset + 512))
      offset += 512
    }
    pendingLocal = merged.slice(offset)
    await collect()
  }
  vad!.flush()
  await collect()
  return texts.join(' ').trim()
}

export async function transcribeSamples(samples: Float32Array): Promise<string> {
  await ensureEngine()
  const stream = recognizer!.createStream()
  stream.acceptWaveform({ samples, sampleRate: 16000 })
  recognizer!.decode(stream)
  return recognizer!.getResult(stream).text.trim()
}

// ---------------------------------------------------------------------------
// Session: renderer streams 16k mono Float32 chunks; VAD segments; a finished
// segment is decoded and handed to Jarvis; the reply is spoken + streamed to
// the panel. States pushed to the renderer: idle|listening|thinking|speaking.
// ---------------------------------------------------------------------------

let getWindow: (() => BrowserWindow | null) | null = null
let listening = false
let pending = new Float32Array(0)
// Epoch token: every start/stop bumps it, and in-flight utterances carry the
// epoch they were born under. A stale utterance's transcript/reply/speech is
// dropped instead of corrupting a newer session (re-toggling during
// "thinking" used to brick the state machine).
let epoch = 0

export function initVoice(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
}

function pushState(state: string, detail?: string): void {
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.VOICE_STATE, { state, detail })
}

export async function voiceStart(): Promise<void> {
  await ensureEngine()
  stopSpeaking() // barge-in: starting to talk silences the reply
  epoch++
  listening = true
  pending = new Float32Array(0)
  vad!.reset()
  pushState('listening')
}

export function voiceStop(): void {
  epoch++
  listening = false
  pushState('idle')
}

export function voiceListening(): boolean {
  return listening
}

export function acceptAudioChunk(chunk: Float32Array): void {
  // NEVER throw out of here: this runs inside an ipcMain.on handler ~8×/sec
  // while listening, and an uncaught exception in main kills the whole app
  // (it did, once — Electron's V8 memory cage rejects sherpa's default
  // external buffers, hence front(false) below).
  try {
    if (!listening || !vad) return
    // VAD wants fixed windows; buffer the remainder between chunks.
    const merged = new Float32Array(pending.length + chunk.length)
    merged.set(pending)
    merged.set(chunk, pending.length)
    let offset = 0
    while (offset + 512 <= merged.length) {
      vad.acceptWaveform(merged.subarray(offset, offset + 512))
      offset += 512
    }
    pending = merged.slice(offset)

    while (!vad.isEmpty()) {
      // enableExternalBuffer=false is REQUIRED under Electron — the default
      // path hands V8 an externally-owned buffer, which the memory cage
      // forbids ("External buffers are not allowed").
      const segment = vad.front(false)
      vad.pop()
      void handleUtterance(segment.samples)
    }
  } catch (err) {
    console.error('voice chunk failed:', err)
    listening = false
    pushState('idle')
  }
}

async function handleUtterance(samples: Float32Array): Promise<void> {
  if (!listening) return
  listening = false // one utterance per activation; predictable + cheap
  const myEpoch = epoch
  const live = (): boolean => epoch === myEpoch
  pushState('thinking')
  try {
    const text = await transcribeSamples(samples)
    if (!live()) return // user re-toggled — this utterance is history
    if (!text || text.length < 2) {
      pushState('idle')
      return
    }
    const win = getWindow?.()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.VOICE_TRANSCRIPT, { text })
    askJarvis(text, {
      onDelta: () => undefined,
      onStatus: (status) => {
        if (live()) pushState('thinking', status)
      },
      onDone: (reply) => {
        if (!live()) return // stale reply: don't speak over a newer session
        pushState('speaking')
        speak(reply, () => {
          if (live()) pushState('idle')
        })
        const w = getWindow?.()
        if (w && !w.isDestroyed()) w.webContents.send(IPC.VOICE_REPLY, { text: reply })
      },
      onError: (message) => {
        if (!live()) return
        pushState('idle')
        const w = getWindow?.()
        if (w && !w.isDestroyed()) w.webContents.send(IPC.VOICE_REPLY, { text: `⚠️ ${message}` })
      }
    })
  } catch (err) {
    if (live()) pushState('idle')
    console.error('voice utterance failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Mouth: a persistent PowerShell SpeechSynthesizer — zero downloads, speaks
// within ~100ms. Reads one JSON line per utterance; "STOP" cancels.
// ---------------------------------------------------------------------------

let tts: ChildProcess | null = null
let ttsDoneCb: (() => void) | null = null

function ensureTts(): ChildProcess {
  if (tts && !tts.killed) return tts
  tts = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Speech
$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sp.Rate = 1
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'STOP') { $sp.SpeakAsyncCancelAll(); continue }
  try {
    $text = $line | ConvertFrom-Json
    $sp.SpeakAsyncCancelAll()
    $sp.Speak($text)
    [Console]::Out.WriteLine('DONE')
  } catch { [Console]::Out.WriteLine('DONE') }
}`
    ],
    { windowsHide: true }
  )
  tts.stdout?.on('data', (d: Buffer) => {
    if (d.toString().includes('DONE')) {
      const cb = ttsDoneCb
      ttsDoneCb = null
      cb?.()
    }
  })
  tts.on('exit', () => {
    tts = null
    // If it died mid-utterance, the state machine must not stick at
    // "speaking" waiting for a DONE that will never come.
    const cb = ttsDoneCb
    ttsDoneCb = null
    cb?.()
  })
  // Spawn failure emits 'error' — without a listener that's an uncaught
  // main-process exception (the crash class this file must never produce).
  tts.on('error', (err) => {
    console.error('tts spawn failed:', err)
    tts = null
    const cb = ttsDoneCb
    ttsDoneCb = null
    cb?.() // never leave the voice state machine stuck in "speaking"
  })
  tts.stdin?.on('error', () => undefined)
  return tts
}

function stripForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200) // a voice reply should be a reply, not an essay
}

export function speak(text: string, onDone?: () => void): void {
  const clean = stripForSpeech(text)
  if (!clean) {
    onDone?.()
    return
  }
  const proc = ensureTts()
  ttsDoneCb = onDone ?? null
  proc.stdin?.write(JSON.stringify(clean) + '\n')
}

export function stopSpeaking(): void {
  // The synthesizer Speak() call is synchronous inside the helper, so it is
  // NOT reading stdin mid-utterance — a "STOP" line would queue until the
  // speech finished (i.e. barge-in that can't barge). Killing the process is
  // the only true interrupt; the next speak() respawns it (~200ms).
  ttsDoneCb = null // detach BEFORE kill so the exit handler can't double-fire state
  if (tts && !tts.killed) tts.kill()
  tts = null
}

export function shutdownVoice(): void {
  listening = false
  if (tts && !tts.killed) tts.kill()
  tts = null
}
