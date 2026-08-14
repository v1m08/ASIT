import { app, BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
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
      const out = createWriteStream(dest)
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        out.write(value)
      }
      await new Promise((r) => out.end(r))
      if (statSync(dest).size < m.minBytes) throw new Error(`${m.name}: truncated download`)
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
  front(): { samples: Float32Array; start: number }
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

async function ensureEngine(): Promise<void> {
  if (vad && recognizer) return
  if (!voiceModelsReady()) throw new Error('voice models not downloaded')
  // CJS interop: rollup wraps the module — the classes live on .default.
  const mod = (await import('sherpa-onnx-node')) as unknown as Record<string, unknown>
  const sherpa = (mod.default ?? mod) as typeof import('sherpa-onnx-node')
  const dir = modelsDir()
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
  listening = true
  pending = new Float32Array(0)
  vad!.reset()
  pushState('listening')
}

export function voiceStop(): void {
  listening = false
  pushState('idle')
}

export function voiceListening(): boolean {
  return listening
}

export function acceptAudioChunk(chunk: Float32Array): void {
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
    const segment = vad.front()
    vad.pop()
    void handleUtterance(segment.samples)
  }
}

async function handleUtterance(samples: Float32Array): Promise<void> {
  if (!listening) return
  listening = false // one utterance per activation; predictable + cheap
  pushState('thinking')
  try {
    const text = await transcribeSamples(samples)
    if (!text || text.length < 2) {
      pushState('idle')
      return
    }
    const win = getWindow?.()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.VOICE_TRANSCRIPT, { text })
    askJarvis(text, {
      onDelta: () => undefined, // panel already renders the stream via jarvis IPC? no — voice path pushes only final
      onStatus: (status) => pushState('thinking', status),
      onDone: (reply) => {
        pushState('speaking')
        speak(reply, () => pushState('idle'))
        const w = getWindow?.()
        if (w && !w.isDestroyed()) w.webContents.send(IPC.VOICE_REPLY, { text: reply })
      },
      onError: (message) => {
        pushState('idle')
        const w = getWindow?.()
        if (w && !w.isDestroyed()) w.webContents.send(IPC.VOICE_REPLY, { text: `⚠️ ${message}` })
      }
    })
  } catch (err) {
    pushState('idle')
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
  if (tts && !tts.killed) tts.stdin?.write('STOP\n')
  ttsDoneCb = null
}

export function shutdownVoice(): void {
  listening = false
  if (tts && !tts.killed) tts.kill()
  tts = null
}
