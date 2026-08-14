declare module 'sherpa-onnx-node' {
  // Minimal surface ASIT uses; the package ships no types.
  export class Vad {
    constructor(config: Record<string, unknown>, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    isDetected(): boolean
    pop(): void
    front(enableExternalBuffer?: boolean): { samples: Float32Array; start: number }
    flush(): void
    reset(): void
  }
  export class OfflineRecognizer {
    constructor(config: Record<string, unknown>)
    createStream(): { acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void }
    decode(stream: unknown): void
    getResult(stream: unknown): { text: string }
  }
  export class OfflineTts {
    constructor(config: Record<string, unknown>)
    sampleRate: number
    numSpeakers: number
    generate(obj: { text: string; sid: number; speed: number }): { samples: Float32Array }
  }
}
