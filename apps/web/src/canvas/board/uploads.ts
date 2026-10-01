/**
 * Uploads in flight on the Excalidraw board page (docs/EXCALIDRAW-MIGRATION.md §2.5.7: "Saved" needs no
 * upload in flight; the tldraw page's sync-quality/uploads.ts). Whoever uploads a file for this board
 * (3g's `files.insert`, a paste or drop handler) wraps the upload in `trackUpload(registries, promise)`;
 * the board page counts them for the save indicator and the leave guard. Keyed by the page's
 * registries, so a part (canvas/api/parts/files.ts) needs nothing else from the page.
 *
 * Pure (Node-tested).
 */
import type { CanvasRegistries } from '../registries.ts'

interface Uploads {
  count: number
  readonly listeners: Set<() => void>
}

const byBoard = new WeakMap<CanvasRegistries, Uploads>()

function uploadsOf(registries: CanvasRegistries): Uploads {
  let u = byBoard.get(registries)
  if (!u) {
    u = { count: 0, listeners: new Set() }
    byBoard.set(registries, u)
  }
  return u
}

const changed = (u: Uploads) => {
  for (const l of [...u.listeners]) l()
}

/** Counts `upload` as in flight until it settles; returns it unchanged. */
export function trackUpload<T>(registries: CanvasRegistries, upload: Promise<T>): Promise<T> {
  const u = uploadsOf(registries)
  u.count++
  changed(u)
  const done = () => {
    u.count--
    changed(u)
  }
  upload.then(done, done)
  return upload
}

/** This board page's uploads in flight. */
export const uploadsInFlight = (registries: CanvasRegistries): number => byBoard.get(registries)?.count ?? 0

/** Calls `listener` when the count changes; returns the unsubscribe. */
export function onUploads(registries: CanvasRegistries, listener: () => void): () => void {
  const u = uploadsOf(registries)
  u.listeners.add(listener)
  return () => u.listeners.delete(listener)
}
