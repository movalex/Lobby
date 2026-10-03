/**
 * Plan §6.5 probe: `addFiles` keeps the first entry for an id (excalidraw `dist/dev/index.js` App.addMissingFiles:
 * `if (nextFiles[fileData.id]) continue`; the method's own comment: "if file already exists in editor state, the
 * file data is not updated").
 *
 * Why Lobby depends on it (docs/EXCALIDRAW-MIGRATION.md §2.10.3; canvas/files/loader.ts, files/swap.ts):
 *   - an image that failed to load stays in the cache and `addFiles` never replaces its id, which is why the loader
 *     only ever hands over bytes it has already decoded;
 *   - the thumb -> display swap therefore cannot re-use a file id: it switches the element's local fileId to a
 *     different key (`ver_x@thumb` -> `ver_x@display`) and the engine holds both entries;
 *   - `addFiles([])` after a switch only asks the engine to cache what is now used (canvas/api/parts/files.ts), so it
 *     must add nothing and change nothing.
 * A bump that made `addFiles` replace an existing entry would silently change what a swapped or retried image shows.
 *
 * `checkAddFiles` touches only the three API methods it names, so it runs against the real mounted engine (the probe
 * page) and, in `add-files.test.ts`, against fakes that do and do not keep the first entry.
 */

export interface AddFilesApi {
  addFiles(files: ProbeFile[]): void
  getFiles(): Record<string, ProbeFile>
}

export interface ProbeFile {
  id: string
  mimeType: string
  dataURL: string
  created: number
}

/** Two different, valid 1x1 PNGs: what a "first" and a "second" entry for one id carry. */
export const RED_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
export const BLUE_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'

export interface AddFilesReport {
  /** the first `addFiles` stored the entry */
  firstStored: boolean
  /** a second `addFiles` for the same id with other bytes left the first entry's bytes in place */
  firstEntryKept: boolean
  /** ... and left the first entry object itself in place (its `created` too) */
  firstEntryObjectKept: boolean
  /** a different id (the swap's `@display` key) is added next to the first */
  otherIdAdded: boolean
  /** `addFiles([])` changes nothing */
  emptyCallNoop: boolean
}

const file = (id: string, dataURL: string, created: number): ProbeFile => ({
  id,
  mimeType: 'image/png',
  dataURL,
  created,
})

/** Runs the probe against `api` and reports each fact; `ok` is every fact together. */
export function checkAddFiles(api: AddFilesApi): AddFilesReport & { ok: boolean } {
  const id = 'ver_probeProbe01@thumb'
  const display = 'ver_probeProbe01@display'
  api.addFiles([file(id, RED_PIXEL, 1)])
  const first = api.getFiles()[id]
  const firstStored = first?.dataURL === RED_PIXEL

  api.addFiles([file(id, BLUE_PIXEL, 2)])
  const afterSecond = api.getFiles()[id]
  const firstEntryKept = afterSecond?.dataURL === RED_PIXEL
  const firstEntryObjectKept = afterSecond === first && afterSecond?.created === 1

  api.addFiles([file(display, BLUE_PIXEL, 3)])
  const files = api.getFiles()
  const otherIdAdded = files[display]?.dataURL === BLUE_PIXEL && files[id]?.dataURL === RED_PIXEL

  const keysBefore = Object.keys(api.getFiles()).sort().join()
  api.addFiles([])
  const emptyCallNoop =
    Object.keys(api.getFiles()).sort().join() === keysBefore && api.getFiles()[id]?.dataURL === RED_PIXEL

  const report = { firstStored, firstEntryKept, firstEntryObjectKept, otherIdAdded, emptyCallNoop }
  return { ...report, ok: Object.values(report).every(Boolean) }
}
