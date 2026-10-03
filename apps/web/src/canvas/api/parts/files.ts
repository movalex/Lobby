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
 * first; so a crop is always made on, and drawn from, the thumb. The swap itself (CR-W5-3G-2,
 * canvas/files/swap.ts) never upgrades a cropped image or the one being cropped, and puts such an image
 * back on its thumb locally (like its own switches: no push, no undo step); `crop` makes that switch at
 * once (`toThumb`), before the editor opens.
 *
 * After a switch, the engine is asked to cache the newly used file at once (`addFiles([])`: Excalidraw
 * caches only the files an element uses, and otherwise only on its throttled 500 ms image refresh, so a
 * just-upgraded image showed its placeholder meanwhile).
 */
import { derivativeUrl, isId, originalUrl } from '@draftroom/dev-assets/shared'
// @excalidraw/element, not @excalidraw/excalidraw: ../impl.ts (and this part) stay importable in Node
import { CaptureUpdateAction, newElementWith } from '@excalidraw/element'
import { inserterOf, provideUploadTracker } from '../../../assets/board-media.ts'
import { trackUpload } from '../../board/uploads.ts'
import { boardFilesOf } from '../../files/board.ts'
import { parseFileKey } from '../../files/loader.ts'
import { type DerivativeSwap, installDerivativeSwap } from '../../files/swap.ts'
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
      swaps.get(engine.api)?.toThumb([id])
      engine.api.updateScene({
        appState: { selectedElementIds: { [id]: true }, croppingElementId: id, isCropping: false } as never,
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      return true
    },
  }
}

type SceneApi = BoardEngineApi

/** Switches the scene's local fileIds (the swap's `apply`): local only, no push, no undo step. */
function switchLocal(api: SceneApi, switches: readonly { id: string; fileId: string }[]): void {
  const byId = new Map(switches.map((s) => [s.id, s.fileId]))
  let changed = false
  const next = api.getSceneElementsIncludingDeleted().map((el) => {
    const to = byId.get(el.id)
    if (!to || el.type !== 'image' || (el as { fileId?: string | null }).fileId === to) return el
    changed = true
    return newElementWith(el, { fileId: to as never })
  })
  if (!changed) return
  // local only: the sync core and undo compare fileIds without the suffix (E9), so this is no push and no
  // undo step; the core keeps the suffix across its rebuilds (CR-W5-3G-3)
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
  // Excalidraw caches only files an element uses: now that one does, cache it at once (see the header)
  if (typeof api.addFiles === 'function') api.addFiles([])
}

/** One derivative swap per board page engine (a re-mounted host brings a new API and a new canvas). */
const swaps = new WeakMap<object, DerivativeSwap>()

function installSwap(deps: PartDeps): void {
  onBoardEngine(deps.registries, (engine) => {
    const api = engine.api
    if (swaps.has(api)) return
    swaps.set(
      api,
      installDerivativeSwap({
        api,
        loader: () => boardFilesOf(deps.registries)?.loader ?? null,
        apply: (switches) => switchLocal(api, switches),
      }),
    )
  })
}

// `derivativeUrl` stays importable from here for the part's callers that build a card's cover URL.
export { derivativeUrl }
