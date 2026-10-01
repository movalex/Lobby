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
import type { ExcalidrawElement } from '@excalidraw/element/types'
import type { BinaryFiles } from '@excalidraw/excalidraw/types'
import { AssetMetaStore } from '../../assets/meta-store.ts'
import type { Bounds } from '../api/lobby-canvas.ts'
import { ImageLoader } from '../files/loader.ts'
import { FileUrlResolver } from '../files/resolve.ts'
import { CheckpointPreview, type PreviewCamera, type PreviewStats } from './CheckpointPreview.ts'

export interface CheckpointPreviewInput {
  /** The checkpoint's elements (`CheckpointContent.elements` of a v2 body); deleted ones are skipped. */
  readonly elements: readonly unknown[]
  /** The board the checkpoint belongs to: its files resolve in that board's scope. */
  readonly boardId: string
  readonly theme?: 'light' | 'dark'
  /** Longest wait for the checkpoint's images before the first paint (default 8 s). */
  readonly filesTimeoutMs?: number
  readonly signal?: AbortSignal
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
  dispose(): void
}

const DEFAULT_FILES_TIMEOUT_MS = 8_000

interface ImageLike {
  readonly type: string
  readonly isDeleted?: boolean
  readonly fileId?: string | null
  readonly customData?: { lobby?: Readonly<Record<string, unknown>> } | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
      typeof e === 'object' && e !== null && (e as { isDeleted?: unknown }).isDeleted !== true,
  )
  const images = (elements as unknown as ImageLike[]).filter((e) => e.type === 'image' && !!e.fileId)
  const files: BinaryFiles = {}
  const resolver = new FileUrlResolver({ boardId: input.boardId, meta: new AssetMetaStore() })
  resolver.learn(images)
  const loader = new ImageLoader({
    addFiles: (list) => {
      for (const f of list) files[f.id] = f
    },
    resolveUrl: resolver.resolveUrl,
  })
  const dispose = () => loader.dispose()
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
      // the board's own background; the dark theme is the engine's export filter over it, so only the
      // view's fill around the bitmaps changes
      background: '#ffffff',
      fill: dark ? '#121212' : '#ffffff',
    })
    await preview.init()
    if (input.signal?.aborted) {
      preview.dispose()
      throw new DOMException('aborted', 'AbortError')
    }
    preview.attachInteraction()
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
      dispose() {
        preview.dispose()
        dispose()
      },
    }
    handle.fit()
    preview.draw()
    return handle
  } catch (e) {
    dispose()
    throw e
  }
}
