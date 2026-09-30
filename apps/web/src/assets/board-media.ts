// The seam between the Excalidraw canvas's files part (canvas/api/parts/files.ts) and the ported media
// feature (file-card/ported/**), both 3g's (docs/EXCALIDRAW-CONTRACTS.md §2.3, §7.2).
//
// Two things cross it, per board page (keyed by the page's feature registries):
//   - the upload tracker. The board page counts uploads in flight so "Saved" waits for them
//     (canvas/board/uploads.ts `trackUpload`, docs/EXCALIDRAW-MIGRATION.md §2.5.7). Ported code may not
//     import canvas modules, so the files part (canvas side) provides the tracker here and the media
//     feature's uploads go through `trackBoardUpload`;
//   - the inserter. `LobbyCanvas.files.insert(files, at)` (tldraw's putExternalContent({type: 'files'}))
//     is the same flow as a drop, which needs the feature context (notices, the role); the media
//     feature provides it here when it mounts, and the files part calls it.
//
// Pure and engine-free (Node-tested).

import type { ScenePoint } from '../canvas/api/index.ts'

type Key = object

/** Counts an upload as in flight until it settles; returns it unchanged. */
export type UploadTracker = <T>(upload: Promise<T>) => Promise<T>
/** Uploads and places `files` like a drop at `at` (the viewport centre when absent); the new element ids. */
export type FileInserter = (files: readonly File[], at?: ScenePoint) => Promise<readonly string[]>

const trackers = new WeakMap<Key, UploadTracker>()
const inserters = new WeakMap<Key, FileInserter>()

/** The files part: `fn` counts this board page's uploads. Returns the withdrawal. */
export function provideUploadTracker(key: Key, fn: UploadTracker): () => void {
  trackers.set(key, fn)
  return () => {
    if (trackers.get(key) === fn) trackers.delete(key)
  }
}

/** Every upload of the media feature goes through here, so the page's save indicator waits for it. */
export function trackBoardUpload<T>(key: Key, upload: Promise<T>): Promise<T> {
  const t = trackers.get(key)
  return t ? t(upload) : upload
}

/** The media feature (on mount): how this board page inserts files. Returns the withdrawal. */
export function provideInserter(key: Key, fn: FileInserter): () => void {
  inserters.set(key, fn)
  return () => {
    if (inserters.get(key) === fn) inserters.delete(key)
  }
}

export function inserterOf(key: Key): FileInserter | null {
  return inserters.get(key) ?? null
}
