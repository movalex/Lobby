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
 * And the dev checks (`devChecks()`): in vitest and the Vite dev server (never in a production build, the
 * e2e build included) the core deep-freezes its confirmed copies, so an in-place write to one throws where it
 * happens (N1-2: Excalidraw mutates scene elements in place; a confirmed copy must never be one of them).
 *
 * NODE-SAFE (CONTRACTS.md): no DOM, no `import.meta.env` (the board session reports the Vite mode through
 * `setDevChecks`).
 */

export const WORKER_DECODE = true
export const DIFF_APPLY = true
export const CHUNKED_APPLY = true
export const SIZE_AWARE_LOD = true

/** A cold open's snapshot is chunked above this many elements (CHUNKED_APPLY). */
export const CHUNK_THRESHOLD = 2_000
/** About this many elements per chunk (a container and its labels are never split). */
export const CHUNK_SIZE = 1_000

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
