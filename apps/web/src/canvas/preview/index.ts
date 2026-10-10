// OWNER: 3h (docs/EXCALIDRAW-CONTRACTS.md §7.2 "canvas/preview/**"). The checkpoint preview as ported
// feature code sees it (features/history/ported/CheckpointPreview.tsx reaches it through
// `canvas/api/index.ts` `loadCheckpointPreview`, change request CR-3H-1): a read-only bitmap of a
// checkpoint's elements on a plain <canvas>, with Lobby's own pan and zoom (./CheckpointPreview.ts,
// spike check A11), never a second <Excalidraw> (plan §4.6).
//
// The checkpoint's images load through Lobby's own loader (../files/loader.ts) and the board's resolver
// (../files/resolve.ts: the api's file routes with `?board=`, the same access rules as on the canvas)
// into a preview-only files map: never `api.addFiles` on the live board, never stored or synced. Images
// still loading after `filesTimeoutMs` are drawn as Excalidraw's placeholders. Nothing here writes an
// element, the live board's undo stack or its sync.
//
// Wave L (L7-1, W7, the time-travel scrubber): a mount may start from a camera (the previous tick's, so the
// view stays put while the checkpoints swap), leave out ids (hidden mind-map branches), share its images with
// the other mounts of one scrubbing session (`session`: an opaque key; `releaseFiles` frees them), paint
// outlines over the bitmap (`setOutlines`) and report clicks with the element under them (`onPick`).
import { getElementBounds } from '@excalidraw/element'
import type { ElementsMap, ExcalidrawElement } from '@excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import { AssetMetaStore } from '../../assets/meta-store.ts'
import type { Bounds } from '../api/lobby-canvas.ts'
import { CANVAS_DARK, CANVAS_LIGHT } from '../engine/theme.ts'
import { ImageLoader } from '../files/loader.ts'
import { FileUrlResolver } from '../files/resolve.ts'
import {
  CheckpointPreview,
  type PreviewCamera,
  type PreviewOutline,
  type PreviewStats,
} from './CheckpointPreview.ts'

export type { PreviewCamera, PreviewOutline }

export interface CheckpointPreviewInput {
  /** The checkpoint's elements (`CheckpointContent.elements` of a v2 body); deleted ones are skipped. */
  readonly elements: readonly unknown[]
  /** The board the checkpoint belongs to: its files resolve in that board's scope. */
  readonly boardId: string
  readonly theme?: 'light' | 'dark'
  /** Longest wait for the checkpoint's images before the first paint (default 8 s). */
  readonly filesTimeoutMs?: number
  readonly signal?: AbortSignal
  /** the camera to start from (default: fit everything) */
  readonly camera?: PreviewCamera
  /** ids to leave out of the drawing and the picking (a collapsed mind-map branch) */
  readonly hidden?: ReadonlySet<string>
  /**
   * An opaque key shared by the mounts of one session (the scrubber): their images load once into one files
   * map. The caller frees them with `releaseFiles` on any handle of the session when it is done.
   */
  readonly session?: object
  /** A click on the view (not a drag): the element under it (a label's container), or null; `additive` with Shift/Ctrl/Cmd. */
  readonly onPick?: (id: string | null, additive: boolean) => void
}

export interface CheckpointPreviewHandle {
  /** Scene bounds of the checkpoint's content, or null when it is empty. */
  readonly bounds: Bounds | null
  /** The view's camera: the scene point at its top-left and the zoom (CSS px per scene unit). */
  camera(): PreviewCamera
  /** Everything in view, never magnified past `maxZoom` (default 1: a single note is not a magnifier). */
  fit(opts?: { readonly maxZoom?: number; readonly padding?: number }): void
  /** `bounds` in view with `inset` CSS px around it, at most `maxZoom`. */
  zoomTo(bounds: Bounds, opts?: { readonly maxZoom?: number; readonly inset?: number }): void
  /** The view's CSS size. */
  viewSize(): { readonly width: number; readonly height: number }
  /** The scene point under a view point (CSS px from the view's top-left). */
  viewToScene(x: number, y: number): { readonly x: number; readonly y: number }
  readonly stats: PreviewStats & { readonly images: number; readonly imagesLoaded: number }
  /** Moves the camera (the next tick's preview starts where this one was). */
  setCamera(camera: PreviewCamera): void
  /** Outlines over the bitmap (scene boxes), from the next paint on. */
  setOutlines(outlines: readonly PreviewOutline[]): void
  /** The element under a view point (CSS px from the view's top-left), or null. */
  pick(x: number, y: number): string | null
  dispose(): void
  /** Frees the images of this handle's session (no-op without one). */
  releaseFiles(): void
}

const DEFAULT_FILES_TIMEOUT_MS = 8_000

interface ImageLike {
  readonly type: string
  readonly isDeleted?: boolean
  readonly fileId?: string | null
  readonly customData?: { lobby?: Readonly<Record<string, unknown>> } | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface PreviewFiles {
  readonly boardId: string
  readonly files: BinaryFiles
  readonly resolver: FileUrlResolver
  readonly loader: ImageLoader
}
const sessions = new WeakMap<object, PreviewFiles>()
function newFiles(boardId: string): PreviewFiles {
  const files: BinaryFiles = {}
  const resolver = new FileUrlResolver({ boardId, meta: new AssetMetaStore() })
  const loader = new ImageLoader({
    addFiles: (list) => {
      for (const f of list) files[f.id] = f
    },
    resolveUrl: resolver.resolveUrl,
  })
  return { boardId, files, resolver, loader }
}
function filesFor(input: CheckpointPreviewInput): { shared: PreviewFiles; owned: boolean } {
  if (!input.session) return { shared: newFiles(input.boardId), owned: true }
  let shared = sessions.get(input.session)
  if (!shared || shared.boardId !== input.boardId) {
    shared?.loader.dispose()
    shared = newFiles(input.boardId)
    sessions.set(input.session, shared)
  }
  return { shared, owned: false }
}
const isLabel = (e: ExcalidrawElement) =>
  e.type === 'text' && typeof (e as { containerId?: unknown }).containerId === 'string'

/**
 * Draws `input.elements` into `view` (a <canvas> the caller sized with CSS) and wires drag-to-pan and
 * wheel/pinch zoom on it. Resolves once the overview is painted and fitted.
 */
export async function mountCheckpointPreview(
  view: HTMLCanvasElement,
  input: CheckpointPreviewInput,
): Promise<CheckpointPreviewHandle> {
  const elements = input.elements.filter(
    (e): e is ExcalidrawElement =>
      typeof e === 'object' &&
      e !== null &&
      (e as { isDeleted?: unknown }).isDeleted !== true &&
      !input.hidden?.has((e as { id?: string }).id ?? ''),
  )
  const images = (elements as unknown as ImageLike[]).filter((e) => e.type === 'image' && !!e.fileId)
  const { shared, owned } = filesFor(input)
  const { files, resolver, loader } = shared
  resolver.learn(images)
  const dispose = () => {
    if (owned) loader.dispose()
  }
  const releaseFiles = () => {
    if (!input.session || sessions.get(input.session) !== shared) return
    sessions.delete(input.session)
    loader.dispose()
  }
  try {
    if (images.length) {
      loader.syncScene(images)
      const until = Date.now() + (input.filesTimeoutMs ?? DEFAULT_FILES_TIMEOUT_MS)
      for (;;) {
        if (input.signal?.aborted) break
        const s = loader.states()
        if (s.queued + s.loading === 0 || Date.now() > until) break
        await sleep(50)
      }
    }
    if (input.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const dark = input.theme === 'dark'
    const preview = new CheckpointPreview(view, {
      elements,
      files,
      dark,
      // one background for the whole view (wave M, M2-4): the dark bitmap's page is the live canvas's own dark
      // (Lobby's dark table draws CANVAS_LIGHT as CANVAS_DARK), and the view's fill around it is the same colour
      background: dark ? CANVAS_LIGHT : '#ffffff',
      fill: dark ? CANVAS_DARK : '#ffffff',
    })
    await preview.init()
    if (input.signal?.aborted) {
      preview.dispose()
      throw new DOMException('aborted', 'AbortError')
    }
    const map = new Map(elements.map((e) => [e.id, e])) as unknown as ElementsMap
    const pick = (vx: number, vy: number): string | null => {
      const at = preview.viewToScene(vx, vy)
      const slack = 4 / Math.max(0.01, preview.camera.zoom)
      let best: { id: string; area: number } | null = null
      for (const e of elements) {
        if (isLabel(e)) continue
        let b: readonly [number, number, number, number]
        try {
          b = getElementBounds(e, map) as unknown as readonly [number, number, number, number]
        } catch {
          continue
        }
        const [x1, y1, x2, y2] = b
        if (at.x < x1 - slack || at.x > x2 + slack || at.y < y1 - slack || at.y > y2 + slack) continue
        const area = Math.max(1, (x2 - x1) * (y2 - y1))
        if (!best || area < best.area) best = { id: e.id, area }
      }
      return best?.id ?? null
    }
    const onPick = input.onPick
    preview.attachInteraction(onPick ? (x, y, additive) => onPick(pick(x, y), additive) : undefined)
    const [minX, minY, maxX, maxY] = preview.bounds
    const bounds: Bounds | null = elements.length
      ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      : null
    const viewSize = () => {
      const r = view.getBoundingClientRect()
      return { width: Math.max(1, r.width), height: Math.max(1, r.height) }
    }
    const zoomTo = (b: Bounds, opts: { maxZoom?: number; inset?: number } = {}) => {
      const { width, height } = viewSize()
      const inset = opts.inset ?? 24
      const fitZoom = Math.min(
        (width - 2 * inset) / Math.max(1, b.width),
        (height - 2 * inset) / Math.max(1, b.height),
      )
      const zoom = Math.max(0.01, Math.min(opts.maxZoom ?? 1, fitZoom))
      preview.setCamera({
        x: b.x + b.width / 2 - width / zoom / 2,
        y: b.y + b.height / 2 - height / zoom / 2,
        zoom,
      })
    }
    const loaded = loader.states().loaded
    const handle: CheckpointPreviewHandle = {
      bounds,
      camera: () => preview.camera,
      fit: (opts = {}) => {
        if (bounds) zoomTo(bounds, { maxZoom: opts.maxZoom ?? 1, inset: opts.padding ?? 24 })
      },
      zoomTo,
      viewSize,
      viewToScene: (x, y) => preview.viewToScene(x, y),
      get stats() {
        return { ...preview.stats, images: images.length, imagesLoaded: loaded }
      },
      setCamera: (camera) => preview.setCamera(camera),
      setOutlines: (outlines) => preview.setOutlines(outlines),
      pick,
      dispose() {
        preview.dispose()
        dispose()
      },
      releaseFiles,
    }
    if (input.camera) preview.setCamera(input.camera)
    else handle.fit()
    preview.draw()
    return handle
  } catch (e) {
    dispose()
    throw e
  }
}
