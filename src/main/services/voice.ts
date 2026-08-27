import { app, BrowserWindow } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
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

function ttsDir(): string {
  return join(app.getPath('userData'), 'voice-tts', 'kokoro-en-v0_19')
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
// Kokoro TTS (optional upgrade over the built-in Windows voice). Downloaded on
// demand as one .tar.bz2 (Windows' bundled bsdtar extracts it — the espeak
// data is 355 tiny files, impractical to fetch individually). Generation runs
// in main; samples are streamed to the renderer for playback so barge-in is a
// clean node stop.
// ---------------------------------------------------------------------------

const KOKORO_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2'

export function ttsReady(): boolean {
  const d = ttsDir()
  return (
    existsSync(join(d, 'model.onnx')) &&
    existsSync(join(d, 'voices.bin')) &&
    existsSync(join(d, 'tokens.txt')) &&
    existsSync(join(d, 'espeak-ng-data'))
  )
}

let ttsDownloading = false

export async function downloadTts(onProgress: (pct: number, file: string) => void): Promise<void> {
  if (ttsDownloading) throw new Error('already downloading')
  if (ttsReady()) {
    onProgress(100, 'done')
    return
  }
  ttsDownloading = true
  try {
    const base = join(app.getPath('userData'), 'voice-tts')
    mkdirSync(base, { recursive: true })
    const archive = join(base, 'kokoro.tar.bz2')
    onProgress(5, 'downloading voice (~370MB)')
    const res = await fetch(KOKORO_URL, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`kokoro: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    let got = 0
    const out = createWriteStream(archive)
    await new Promise<void>((resolve, reject) => {
      out.on('error', reject)
      out.on('finish', resolve)
      const reader = res.body!.getReader()
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) return void out.end()
            got += value.length
            if (total) onProgress(5 + Math.round((got / total) * 80), 'downloading voice')
            out.write(value)
            pump()
          })
          .catch(reject)
      }
      pump()
    })
    onProgress(88, 'extracting')
    // Windows System32 bsdtar handles .tar.bz2 natively; the release extracts
    // to a top-level kokoro-en-v0_19/ folder alongside the archive.
    await new Promise<void>((resolve, reject) => {
      execFile(
        'tar.exe',
        ['-xf', archive, '-C', base],
        { windowsHide: true, maxBuffer: 1 << 24 },
        (err) => (err ? reject(err) : resolve())
      )
    })
    try {
      const { rmSync } = await import('fs')
      rmSync(archive, { force: true })
    } catch {
      // leftover archive is harmless
    }
    if (!ttsReady()) throw new Error('extraction did not produce the expected files')
    onProgress(100, 'done')
  } finally {
    ttsDownloading = false
  }
}

interface SherpaTts {
  sampleRate: number
  generate(obj: {
    text: string
    sid: number
    speed: number
    enableExternalBuffer: boolean
  }): { samples: Float32Array }
}

// enableExternalBuffer:false is REQUIRED under Electron's memory cage (same
// class of crash the VAD hit) — the default hands V8 an external buffer.
function ttsGenerate(tts: SherpaTts, text: string): { samples: Float32Array } {
  return tts.generate({ text, sid: 0, speed: 1.0, enableExternalBuffer: false })
}

let kokoro: SherpaTts | null = null
let kokoroInit: Promise<void> | null = null

async function ensureKokoro(): Promise<SherpaTts | null> {
  if (kokoro) return kokoro
  if (!ttsReady()) return null
  if (!kokoroInit) {
    kokoroInit = (async () => {
      const mod = (await import('sherpa-onnx-node')) as unknown as Record<string, unknown>
      const sherpa = (mod.default ?? mod) as { OfflineTts: new (c: unknown) => SherpaTts }
      const d = ttsDir()
      kokoro = new sherpa.OfflineTts({
        model: {
          kokoro: {
            model: join(d, 'model.onnx'),
            voices: join(d, 'voices.bin'),
            tokens: join(d, 'tokens.txt'),
            dataDir: join(d, 'espeak-ng-data')
          },
          numThreads: 2,
          provider: 'cpu'
        }
      })
    })().finally(() => {
      kokoroInit = null
    })
  }
  await kokoroInit
  return kokoro
}

// Voice replies should be SHORT — speak a one-line summary, not the essay.
// The full text still renders in the panel.
function summarizeForSpeech(markdown: string): string {
  const clean = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[\s>*+\-#]+/gm, '')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return ''
  // First sentence; if that's tiny (a lead-in like "Done."), take two.
  const sentences = clean.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [clean]
  let out = sentences[0].trim()
  if (out.length < 25 && sentences[1]) out += ' ' + sentences[1].trim()
  return out.slice(0, 240)
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

// Smoke hook: generate a clip synchronously (bypasses the renderer path).
export async function synthesizeForSmoke(
  text: string
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const tts = await ensureKokoro()
  if (!tts) throw new Error('kokoro not ready')
  const out = ttsGenerate(tts, text)
  return { samples: out.samples, sampleRate: tts.sampleRate }
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
// 'command' — one utterance, answered by Jarvis and spoken back.
// 'dictate' — keep listening and emit each finished phrase as TEXT for
// whatever field has focus. The difference is deliberately at THIS layer:
// mic, VAD and decoder are identical, so dictation costs nothing extra and
// cannot drift from the thing that already worked.
let mode: 'command' | 'dictate' = 'command'
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

// Warm the STT engine ahead of the first Ctrl+Space so recording starts with
// no model-load stall — the delay that was eating the start of utterances.
export function prewarmVoice(): void {
  if (voiceModelsReady()) void ensureEngine().catch(() => undefined)
  if (ttsReady()) void ensureKokoro().catch(() => undefined)
}

export async function voiceStart(): Promise<void> {
  await ensureEngine()
  stopSpeaking() // barge-in: starting to talk silences the reply
  epoch++
  mode = 'command'
  listening = true
  pending = new Float32Array(0)
  vad!.reset()
  pushState('listening')
}

/**
 * Dictation. Speak into whatever field has focus; each pause flushes a phrase
 * and recording CONTINUES, so a long paragraph is one activation rather than
 * one activation per sentence.
 */
export async function dictateStart(): Promise<void> {
  await ensureEngine()
  stopSpeaking()
  epoch++
  mode = 'dictate'
  listening = true
  pending = new Float32Array(0)
  vad!.reset()
  pushState('dictating')
}

export function dictateStop(): void {
  epoch++
  mode = 'command'
  listening = false
  pushState('idle')
}

export function dictating(): boolean {
  return listening && mode === 'dictate'
}

/**
 * Turn a raw transcript into something you would have typed.
 *
 * Moonshine returns bare lowercase words with no punctuation, so dictated
 * text arrived as one long run-on. This is deliberately DETERMINISTIC rather
 * than a model pass: a cleanup that takes a second to run defeats the point
 * of dictation, and a model rewriting your words is not transcription.
 */
export function formatDictation(raw: string, atSentenceStart: boolean): string {
  let t = raw.trim()
  if (!t) return ''

  // Spoken punctuation, the way every dictation tool handles it.
  const spoken: [RegExp, string][] = [
    [/\bnew paragraph\b/gi, '\n\n'],
    [/\b(new line|newline)\b/gi, '\n'],
    [/\bcomma\b/gi, ','],
    [/\b(full stop|period)\b/gi, '.'],
    [/\bquestion mark\b/gi, '?'],
    [/\bexclamation (mark|point)\b/gi, '!'],
    [/\bcolon\b/gi, ':'],
    [/\bsemicolon\b/gi, ';'],
    [/\bopen paren(thesis)?\b/gi, '('],
    [/\bclose paren(thesis)?\b/gi, ')']
  ]
  for (const [re, ch] of spoken) t = t.replace(re, ch)

  // The replacements leave " ," and " ." behind.
  t = t.replace(/\s+([,.;:!?)])/g, '$1').replace(/([(])\s+/g, '$1')
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
  if (!t) return ''

  // Capitalise after a sentence end, and at the very start of one.
  if (atSentenceStart) t = t.charAt(0).toUpperCase() + t.slice(1)
  t = t.replace(/([.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())
  t = t.replace(/(\n+)([a-z])/g, (_m, p, c) => p + c.toUpperCase())
  t = t.replace(/\bi\b/g, 'I')
  return t
}

export function voiceStop(): void {
  epoch++
  mode = 'command'
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

// Whether the next phrase begins a sentence, so capitalisation is right
// across the pauses that split one spoken paragraph into several phrases.
let dictationAtStart = true

async function handleUtterance(samples: Float32Array): Promise<void> {
  if (!listening) return
  const myEpoch = epoch
  const live = (): boolean => epoch === myEpoch

  if (mode === 'dictate') {
    // Keep listening: a pause is a phrase break, not the end of dictation.
    try {
      const raw = await transcribeSamples(samples)
      if (!live() || !raw || raw.trim().length < 2) return
      const text = formatDictation(raw, dictationAtStart)
      if (!text) return
      dictationAtStart = /[.!?\n]$/.test(text)
      const win = getWindow?.()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.VOICE_DICTATE_TEXT, { text })
    } catch (err) {
      console.error('dictation failed:', err)
    }
    return
  }

  listening = false // one utterance per activation; predictable + cheap
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
    void askJarvis(text, {
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
// Mouth: the operating system's own speech engine — zero downloads, speaks
// within ~100ms. A long-lived helper reads one JSON line per utterance and
// prints DONE when it finishes; "STOP" cancels. Windows uses a PowerShell
// SpeechSynthesizer, macOS the `say` command; the protocol between them and
// this file is identical, so nothing above here changes per platform.
// (Kokoro, when downloaded, replaces this entirely with a nicer voice.)
// ---------------------------------------------------------------------------

let tts: ChildProcess | null = null
let ttsDoneCb: (() => void) | null = null

/** The helper process, per platform. Same stdin/stdout contract either way. */
function spawnTtsHelper(): ChildProcess {
  if (process.platform === 'win32') {
    return spawn(
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
  }
  // macOS: `say` is built in. node reads the same line protocol and shells out
  // per utterance, killing any in-flight one so barge-in still works.
  return spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('child_process')
let cur = null
require('readline')
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (cur) { try { cur.kill('SIGKILL') } catch {} cur = null }
    if (line === 'STOP') return
    let text = ''
    try { text = JSON.parse(line) } catch { console.log('DONE'); return }
    cur = spawn('say', [String(text)])
    cur.on('exit', () => { cur = null; console.log('DONE') })
    cur.on('error', () => { cur = null; console.log('DONE') })
  })`
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  )
}

function ensureTts(): ChildProcess {
  if (tts && !tts.killed) return tts
  tts = spawnTtsHelper()
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

// Every spoken utterance carries an id so a stale barge-in can't cancel a
// newer one, and the renderer can match audio to its stop.
let speakSeq = 0

export function speak(text: string, onDone?: () => void): void {
  const summary = summarizeForSpeech(text)
  if (!summary) {
    onDone?.()
    return
  }
  const id = ++speakSeq

  // Kokoro path: generate samples in main, play in the renderer (clean
  // barge-in via node stop). Falls back to the built-in Windows voice while
  // Kokoro isn't downloaded, so voice always works.
  void ensureKokoro()
    .then((tts) => {
      if (id !== speakSeq) return // superseded before generation finished
      if (!tts) {
        speakSapi(summary, id, onDone)
        return
      }
      const audio = ttsGenerate(tts, summary)
      if (id !== speakSeq) return
      const win = getWindow?.()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.VOICE_AUDIO, {
          id,
          sampleRate: tts.sampleRate,
          samples: Buffer.from(audio.samples.buffer, audio.samples.byteOffset, audio.samples.byteLength)
        })
      }
      ttsDoneCb = onDone ?? null // renderer signals completion via VOICE_AUDIO_DONE
    })
    .catch((err) => {
      console.error('kokoro tts failed, falling back:', err)
      if (id === speakSeq) speakSapi(summary, id, onDone)
    })
}

// Built-in Windows voice fallback (instant, no download).
function speakSapi(text: string, id: number, onDone?: () => void): void {
  const proc = ensureTts()
  ttsDoneCb = () => {
    if (id === speakSeq) onDone?.()
  }
  proc.stdin?.write(JSON.stringify(text) + '\n')
}

// Renderer reports Kokoro playback finished.
export function onAudioDone(): void {
  const cb = ttsDoneCb
  ttsDoneCb = null
  cb?.()
}

export function stopSpeaking(): void {
  speakSeq++ // invalidate any in-flight generation
  ttsDoneCb = null
  // Stop the SAPI fallback (kill = only true interrupt; sync Speak ignores a
  // queued STOP line) and any renderer playback.
  if (tts && !tts.killed) tts.kill()
  tts = null
  const win = getWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.VOICE_AUDIO_STOP)
}

export function shutdownVoice(): void {
  listening = false
  if (tts && !tts.killed) tts.kill()
  tts = null
}
