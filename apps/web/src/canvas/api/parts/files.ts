/**
 * OWNER: 3g (media). URLs for an element's file (a derivative or the original, through the api's
 * authorised routes, never a stored URL) and inserting files like a drop (upload, place with the card
 * facts). `files.status` (the loader's state) stays 2C's in ../impl.ts.
 *
 * - `urlOf(id)`: the same-origin path of what the canvas shows for the element (its current local
 *   derivative: `thumb`, `display` after the derivative swap, a placed PDF page's rendering, a card's
 *   cover or poster), or with `{original: true}` the version's original (export, copy, Download
 *   original; the api answers 403 while the board's export policy refuses it), for a placed PDF page
 *   its largest rendering (never the whole PDF). Null for an element
 *   without a Lobby file, before the board page's engine is there, or while nothing can be loaded yet.
 *   Reads the page's image loader resolver (canvas/files/board.ts), so the ids come from the scene's
 *   `customData.lobby.file` and the api's meta, never from a stored URL.
 * - `insert(files, at)`: the media feature's drop flow (file-card/ported, mounted per board page),
 *   reached through ../../../assets/board-media.ts. Rejects while the media feature is not mounted.
 *
 * - `crop(id)` (CR-W5-3G-1, W5-13): opens Excalidraw's crop editor on an image or placed page (its
 *   corner handles; Escape or a click elsewhere finishes), selecting it.
 *
 * On creation the part also provides the page's upload tracker to the media feature (Saved waits for
 * uploads, canvas/board/uploads.ts) and installs the derivative swap on the board page's engine
 * (canvas/files/swap.ts, §2.10.3).
 *
 * A crop lives in the pixels of the file the engine has loaded, and every tab loads an image's thumb
 * first; so a crop is always made on, and drawn from, the thumb. The swap here never sees a cropped
 * image or the one being cropped (it would upgrade it, or keep an earlier upgrade, to the 2,048 px
 * rendering: the crop would then show the wrong part), and such an image is put back on its thumb
 * locally (like the swap's own switches: no push, no undo step). CR-W5-3G-2 asks 2C for the same rule
 * inside canvas/files/swap.ts.
 */
import { derivativeUrl, isId, originalUrl } from '@draftroom/dev-assets/shared'
// @excalidraw/element, not @excalidraw/excalidraw: ../impl.ts (and this part) stay importable in Node
import { CaptureUpdateAction, newElementWith } from '@excalidraw/element'
import { inserterOf, provideUploadTracker } from '../../../assets/board-media.ts'
import { trackUpload } from '../../board/uploads.ts'
import { boardFilesOf } from '../../files/board.ts'
import { parseFileKey, wireFileId } from '../../files/loader.ts'
import { installDerivativeSwap } from '../../files/swap.ts'
import { boardEngineOf, onBoardEngine } from '../../overrides.ts'

type BoardEngineApi = NonNullable<ReturnType<typeof boardEngineOf>>['api']

import type { LobbyFiles } from '../lobby-canvas.ts'
import type { PartDeps } from './types.ts'

export type FilesPart = Pick<LobbyFiles, 'urlOf' | 'insert' | 'crop'>

/** The file facts of an element (canvas-schema custom-data.ts `file`), when they are well formed. */
function fileOf(el: unknown): { assetId: string; versionId: string } | null {
  const e = el as { type?: string; fileId?: unknown; customData?: { lobby?: { file?: unknown } } } | undefined
  if (e?.type !== 'image') return null
  const f = e.customData?.lobby?.file as { assetId?: unknown; versionId?: unknown } | undefined
  if (!isId('ast', f?.assetId) || !isId('ver', f?.versionId)) return null
  return { assetId: f.assetId, versionId: f.versionId }
}

export function createFilesPart(deps: PartDeps): FilesPart {
  provideUploadTracker(deps.registries, (upload) => trackUpload(deps.registries, upload))
  installSwap(deps)
  return {
    async urlOf(id, opts) {
      const el = deps.port.get(id) as { fileId?: string | null } | undefined
      const file = fileOf(el)
      const boardId = boardEngineOf(deps.registries)?.boardId ?? null
      if (!file || !boardId) return null
      const key = el?.fileId ? parseFileKey(el.fileId) : null
      // a placed PDF page's "original" is its largest rendering, never the whole PDF
      if (opts?.original && key?.page == null) return originalUrl(boardId, file.assetId, file.versionId)
      const files = boardFilesOf(deps.registries)
      if (!key || !files) return null
      files.resolver.learnRef(file.versionId, file.assetId)
      const derivative = opts?.original ? 'display' : key.derivative
      // null: nothing to load yet (still processing); a derivative-less answer is never an original
      return (await files.resolver.resolveUrl(key.versionId, derivative, key)) ?? null
    },
    insert(files, at) {
      const insert = inserterOf(deps.registries)
      if (!insert) return Promise.reject(new Error('files.insert: the media feature is not mounted'))
      return insert(files, at)
    },
    crop(id) {
      const engine = boardEngineOf(deps.registries)
      const el = deps.port.get(id) as
        | {
            type?: string
            isDeleted?: boolean
            locked?: boolean
            fileId?: string | null
            customData?: unknown
          }
        | undefined
      const file = fileOf(el)
      const key = el?.fileId ? parseFileKey(el.fileId) : null
      if (!engine || !el || el.isDeleted || !file || !key) return false
      const kind = (el.customData as { lobby?: { file?: { kind?: string } } } | undefined)?.lobby?.file?.kind
      // a card's face is its cover: cropping it would hide its file's name and controls
      if (kind !== 'image' && key.page == null) return false
      const canvas = deps.self()
      if (canvas.readOnly() || canvas.isLocked(id)) return false
      keepOnThumb(engine.api, [id])
      engine.api.updateScene({
        appState: { selectedElementIds: { [id]: true }, croppingElementId: id, isCropping: false } as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      return true
    },
  }
}

type SceneApi = BoardEngineApi

const thumbOnlyCache = new WeakMap<object, { elements: unknown; cropping: string | null; ids: Set<string> }>()

/**
 * The images that must stay on their thumb: cropped ones, and the one being cropped. Recomputed only
 * when the scene's elements or the cropped id changed (the engine keeps its element array between
 * changes), so a camera move costs nothing.
 */
function onThumbOnly(api: SceneApi): Set<string> {
  const cropping = (api.getAppState() as { croppingElementId?: string | null }).croppingElementId ?? null
  const elements = api.getSceneElements()
  const hit = thumbOnlyCache.get(api)
  if (hit && hit.elements === elements && hit.cropping === cropping) return hit.ids
  const ids = new Set<string>()
  for (const el of elements) {
    if (el.type !== 'image') continue
    if ((el as { crop?: unknown }).crop || el.id === cropping) ids.add(el.id)
  }
  thumbOnlyCache.set(api, { elements, cropping, ids })
  return ids
}

/** Puts `ids` back on their thumb where they show a larger rendering (local only). */
function keepOnThumb(api: SceneApi, ids: Iterable<string>): void {
  const want = new Set(ids)
  let changed = false
  const next = api.getSceneElementsIncludingDeleted().map((el) => {
    if (el.type !== 'image' || !want.has(el.id)) return el
    const fileId = (el as { fileId?: string | null }).fileId
    const key = fileId ? parseFileKey(fileId) : null
    if (!fileId || !key || key.derivative === 'thumb') return el
    const thumb = wireFileId(fileId)
    if (!thumb) return el
    changed = true
    return newElementWith(el, { fileId: thumb as never })
  })
  if (changed) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
}

/** One derivative swap per board page engine (a re-mounted host brings a new API and a new canvas). */
const swapped = new WeakSet<object>()

function installSwap(deps: PartDeps): void {
  onBoardEngine(deps.registries, (engine) => {
    const api = engine.api
    if (swapped.has(api)) return
    swapped.add(api)
    // the swap never sees an image that must stay on its thumb (see the header)
    const swapView = {
      getSceneElements: () => {
        const keep = onThumbOnly(api)
        const all = api.getSceneElements()
        return keep.size ? all.filter((el) => !keep.has(el.id)) : all
      },
      getAppState: () => api.getAppState(),
      onChange: (fn: Parameters<typeof api.onChange>[0]) => api.onChange(fn),
    } as unknown as typeof api
    let queued = false
    api.onChange(() => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        const keep = onThumbOnly(api)
        if (keep.size) keepOnThumb(api, keep)
      })
    })
    installDerivativeSwap({
      api: swapView,
      loader: () => boardFilesOf(deps.registries)?.loader ?? null,
      apply(switches) {
        const byId = new Map(switches.map((s) => [s.id, s.fileId]))
        const next = api.getSceneElementsIncludingDeleted().map((el) => {
          const to = byId.get(el.id)
          return to && el.type === 'image' ? newElementWith(el, { fileId: to as never }) : el
        })
        // local only: the sync core and undo compare fileIds without the suffix (E9), so this is no push
        // and no undo step
        api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
      },
    })
  })
}

// `derivativeUrl` stays importable from here for the part's callers that build a card's cover URL.
export { derivativeUrl }
