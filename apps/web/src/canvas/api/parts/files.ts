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
 * On creation the part also provides the page's upload tracker to the media feature (Saved waits for
 * uploads, canvas/board/uploads.ts) and installs the derivative swap on the board page's engine
 * (canvas/files/swap.ts, §2.10.3).
 */
import { derivativeUrl, isId, originalUrl } from '@draftroom/dev-assets/shared'
// @excalidraw/element, not @excalidraw/excalidraw: ../impl.ts (and this part) stay importable in Node
import { CaptureUpdateAction, newElementWith } from '@excalidraw/element'
import { inserterOf, provideUploadTracker } from '../../../assets/board-media.ts'
import { trackUpload } from '../../board/uploads.ts'
import { boardFilesOf } from '../../files/board.ts'
import { parseFileKey } from '../../files/loader.ts'
import { installDerivativeSwap } from '../../files/swap.ts'
import { boardEngineOf, onBoardEngine } from '../../overrides.ts'
import type { LobbyFiles } from '../lobby-canvas.ts'
import type { PartDeps } from './types.ts'

export type FilesPart = Pick<LobbyFiles, 'urlOf' | 'insert'>

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
  }
}

/** One derivative swap per board page engine (a re-mounted host brings a new API and a new canvas). */
const swapped = new WeakSet<object>()

function installSwap(deps: PartDeps): void {
  onBoardEngine(deps.registries, (engine) => {
    const api = engine.api
    if (swapped.has(api)) return
    swapped.add(api)
    installDerivativeSwap({
      api,
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
