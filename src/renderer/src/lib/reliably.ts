// Startup loads must never fail silently.
//
// Every panel on Home renders "you have nothing yet" from an empty array, and
// an IPC call that rejects leaves exactly that empty array behind. The result
// is an app that looks WIPED — no workspaces, no to-dos, no history — while
// the database is perfectly intact, with no error anywhere and no way back
// except relaunching. That shipped once; this is the guard.
//
// Rules: retry (main may still be busy with its own startup work), and if it
// truly can't load, say so loudly instead of rendering a lie.

const RETRY_DELAYS = [150, 400, 900, 1800, 3500]

let onFailure: (label: string, detail: string) => void = () => {}
let onRecovered: () => void = () => {}

/** Wired by the store so this module stays dependency-free (no import cycle). */
export function setLoadFailureSink(
  fail: (label: string, detail: string) => void,
  recover: () => void
): void {
  onFailure = fail
  onRecovered = recover
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run a load, retrying transient failures. Resolves to `undefined` ONLY when
 * every attempt failed — callers must leave their state untouched in that case
 * so stale-but-true data beats a fabricated empty state.
 */
export async function reliably<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await fn()
      if (attempt > 0) onRecovered()
      return value
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (attempt >= RETRY_DELAYS.length) {
        console.error(`[load] ${label} failed after ${attempt + 1} attempts:`, err)
        onFailure(label, detail)
        return undefined
      }
      await sleep(RETRY_DELAYS[attempt])
    }
  }
}

/** Same contract, for the `.then(setState)` one-liners: only sets on success. */
export function reliablyInto<T>(
  label: string,
  fn: () => Promise<T>,
  apply: (value: T) => void
): void {
  void reliably(label, fn).then((value) => {
    if (value !== undefined) apply(value)
  })
}
