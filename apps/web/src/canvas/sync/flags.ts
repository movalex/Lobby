/**
 * Wave N, WS1 (big boards): the kill switches of the client receive path's four speed parts. Each part is
 * independent, so a regression is a web-only redeploy with that one flag false (docs/DEPLOY.md hold rules):
 *
 *  - WORKER_DECODE: the reset welcome's gzip snapshot is decoded (gunzip, JSON.parse, the zod parse) in a
 *    module Worker (transport/snapshot.worker.ts), not on the main thread. Off: socket.ts decodes it in the
 *    page, as before wave N.
 *  - DIFF_APPLY: a reset welcome over a scene that already shows a copy (a warm open's painted cache, a
 *    reconnect's reset) keeps every scene element the snapshot row equals (id, version, versionNonce,
 *    isDeleted) instead of replacing it with a copy, so Excalidraw's per-element shape cache stays warm. Off:
 *    every element is replaced, as before.
 *  - CHUNKED_APPLY: a cold open's reset snapshot of more than CHUNK_THRESHOLD elements is installed in chunks
 *    of about CHUNK_SIZE, one per animation frame (frames and the elements in view first), the canvas
 *    read-only until the last chunk. Off: one updateScene, as before.
 *  - SIZE_AWARE_LOD: the level-of-detail pass turns on below zoom 0.35 on boards of more than 1,500 live
 *    elements (or with more than 3,000 in view), keeps its bitmaps per zoom bucket under a memory cap, and
 *    draws loose elements as grid tiles (lod/model.ts). Off: below zoom 0.2 only, frames only, as before.
 *
 * Each is on at merge only once its gate passes (the wave N brief). WORKER_DECODE's has (no main-thread long task over
 * 200 ms in the decode, the enforced CSP). Wave N.1: CHUNKED_APPLY's has: a 10k cold open at CPU 4x, the longest task
 * from the snapshot to editable 149 ms and the first content 229 ms after the decode (medians of 9 opens; targets 200 ms
 * and 1.2 s), with the n1-*, sync durability, collab, warm-open and workshops specs passing with it on, and since your
 * last visit on the 10k board (n1-since-visit-10k). The other two are off: their correctness gates pass, their speed
 * targets do not (wave N.1, CPU 4x, medians of 9: a 10k warm open painted 1.64 s and editable 5.8 s against 1.5 s and
 * 3.5 s, its longest task after the paint 548 ms against 250 ms; the editable time is the 392 KB reset snapshot over
 * Chrome's Fast 4G emulation, whose WebSocket frames arrive at about 100 KB/s, 3 to 5 s after the welcome; the 4x pan
 * 6 to 10 fps against 30, mostly the engine's own per-frame work). Off, each path is the one before wave N exactly.
 * A dev-auth build (the e2e build, local dev; never a production bundle: DEV_AUTH_ENABLED) may turn one on or off for
 * its page (`speedFlag`, `setSpeedFlagOverrides`: the board session reads them from localStorage
 * SPEED_FLAGS_KEY), so the N1 specs measure and gate a part that ships off.
 *
 * And the dev checks (`devChecks()`): in vitest and the Vite dev server (never in a production build, the
 * e2e build included) the core deep-freezes its confirmed copies, so an in-place write to one throws where it
 * happens (N1-2: Excalidraw mutates scene elements in place; a confirmed copy must never be one of them).
 *
 * NODE-SAFE (CONTRACTS.md): no DOM, no `import.meta.env` (the board session reports the Vite mode through
 * `setDevChecks`).
 */

export const WORKER_DECODE = true
export const DIFF_APPLY = false
export const CHUNKED_APPLY = true
export const SIZE_AWARE_LOD = false

/** The four parts by name (what a dev-auth page's override names). */
export const SPEED_FLAGS = { WORKER_DECODE, DIFF_APPLY, CHUNKED_APPLY, SIZE_AWARE_LOD } as const
export type SpeedFlag = keyof typeof SPEED_FLAGS

/** The localStorage key a dev-auth page reads its overrides from: JSON, e.g. `{"DIFF_APPLY":true}`. */
export const SPEED_FLAGS_KEY = 'lobby.speedFlags'

let overrides: Partial<Record<SpeedFlag, boolean>> = {}

/** A part's switch for this page: its override (dev-auth builds only), else the shipped value above. */
export function speedFlag(name: SpeedFlag): boolean {
  return overrides[name] ?? SPEED_FLAGS[name]
}

/**
 * Sets this page's overrides (the board session, in a dev-auth build only; a production page never calls it). Unknown
 * names and non-boolean values are ignored. Returns what was taken.
 */
export function setSpeedFlagOverrides(raw: unknown): Partial<Record<SpeedFlag, boolean>> {
  const out: Partial<Record<SpeedFlag, boolean>> = {}
  if (raw && typeof raw === 'object')
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (Object.hasOwn(SPEED_FLAGS, k) && typeof v === 'boolean') out[k as SpeedFlag] = v
  overrides = out
  return out
}

/** A cold open's snapshot is chunked above this many elements (CHUNKED_APPLY). */
export const CHUNK_THRESHOLD = 2_000
/**
 * About this many elements per chunk (a container and its labels are never split). Wave N.1: 600, was 1,000. A late
 * chunk's work is the engine's pass over every element installed so far plus its own new elements' (their shapes, the
 * engine's store copies, the core's copies): at CPU 4x on the 10k board the late chunks of 1,000 took about 200 ms.
 */
export const CHUNK_SIZE = 600

const vitest = (): boolean => {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    return !!env && (env.VITEST === 'true' || env.VITEST === '1' || env.NODE_ENV === 'test')
  } catch {
    return false
  }
}

let dev: boolean | null = null

/** Whether the dev-only checks run (vitest, or a page that said so: the Vite dev server). */
export function devChecks(): boolean {
  if (dev === null) dev = vitest()
  return dev
}

/** The board session's `import.meta.env.DEV` (a production build, the e2e build included, says false). */
export function setDevChecks(on: boolean): void {
  dev = on || vitest()
}
