import type { TLAsset, TLAssetContext, TLAssetId, TLAssetStore } from 'tldraw'
import { exportCertainOnBoard } from '../features/sharing/export-policy.ts'
import {
  type AssetVersionMeta,
  type DerivativeRecord,
  derivativeUrl,
  isId,
  originalUrl,
  pageRenderings,
  stableFileRef,
  usableDerivatives,
} from './contract.ts'
import { type AssetMetaStore, isTerminal, waitForTerminalMeta } from './meta-store.ts'
import './pending-image.css'
import { whilePending } from './pending-images.ts'
import { uploadFile } from './upload.ts'

// Moved to the tldraw-free contract module (the Excalidraw board page's file cards use it too).
export { pageRenderings }

const FILE_REF_RE = /^\/files\/([^/]+)\/([^/]+)\/original$/

/** Parses the durable, host-less reference stored in `asset.props.src` (contract §5). */
export function parseFileRef(src: unknown): { assetId: string; versionId: string } | null {
  if (typeof src !== 'string') return null
  const m = FILE_REF_RE.exec(src)
  if (!m?.[1] || !m[2] || !isId('ast', m[1]) || !isId('ver', m[2])) return null
  return { assetId: m[1], versionId: m[2] }
}

const SLOW_NETWORKS = new Set(['slow-2g', '2g'])

/**
 * Picks the smallest derivative that is still sharp at the current on-screen size. `screenScale`
 * is on-screen CSS px per native image px, so the device-pixel width the shape needs is
 * `nativeWidth * steppedScreenScale * dpr` (stepped so zooming does not refetch every frame).
 */
export function pickImageDerivative(
  meta: AssetVersionMeta,
  nativeWidth: number,
  ctx: Pick<TLAssetContext, 'steppedScreenScale' | 'dpr' | 'networkEffectiveType'>,
): DerivativeRecord | null {
  const all = usableDerivatives(meta)
  const thumb = all.find((d) => d.role === 'thumb') ?? null
  const display = all.find((d) => d.role === 'display') ?? null
  const width = nativeWidth > 0 ? nativeWidth : (meta.probe.width ?? display?.width ?? 0)
  const needed = width * ctx.steppedScreenScale * ctx.dpr
  if (thumb && (needed <= thumb.width || SLOW_NETWORKS.has(ctx.networkEffectiveType ?? ''))) return thumb
  return display ?? thumb
}

// ---- PDF pages placed on the board (FIL-04) --------------------------------------------------------

/**
 * Asset `meta` key that makes an image asset show one page of an uploaded PDF. Such an asset keeps
 * the PDF version's own stable ref in `props.src` (`/files/ast_…/ver_…/original`, the only durable
 * file reference history, duplicate and import carry over), and resolve() turns it into that page's
 * derivative, never into the PDF itself. The page number, not a derivative id, is what is stored: a
 * re-rendered version gets new derivative ids, its page numbers stay.
 */
export const PDF_PAGE_META_KEY = 'drPdfPage'

/** The 1-based PDF page an image asset shows, or null for an ordinary image. */
export function pdfPageOf(asset: Pick<TLAsset, 'meta'>): number | null {
  const page = (asset.meta as Record<string, unknown> | undefined)?.[PDF_PAGE_META_KEY]
  return typeof page === 'number' && Number.isInteger(page) && page >= 1 ? page : null
}

/**
 * The rendering of a PDF page to show: the smallest one that is still sharp at the on-screen size
 * (the largest when none is); the largest for export/copy (`shouldResolveToOriginal`: the page image
 * is the best there is, the PDF original is not an image); the smallest on very slow networks.
 */
export function pickPageDerivative(
  meta: AssetVersionMeta,
  page: number,
  nativeWidth: number,
  ctx: Pick<
    TLAssetContext,
    'steppedScreenScale' | 'dpr' | 'networkEffectiveType' | 'shouldResolveToOriginal'
  >,
): DerivativeRecord | null {
  const all = pageRenderings(meta, page)
  const largest = all[all.length - 1] ?? null
  if (!largest || ctx.shouldResolveToOriginal) return largest
  if (SLOW_NETWORKS.has(ctx.networkEffectiveType ?? '')) return all[0] ?? null
  const width = nativeWidth > 0 ? nativeWidth : largest.width
  const needed = width * ctx.steppedScreenScale * ctx.dpr
  return all.find((d) => d.width >= needed) ?? largest
}

// ---- animated images (FIL-08) -------------------------------------------------------------------------

/**
 * Derivatives are single-frame WebP (the worker decodes the first frame only), so an animated GIF
 * (or an animated WebP) plays only from its original. The original is shown only while it is cheap
 * enough and big enough on screen to be worth it; otherwise the static preview stays (FIL-02).
 */
export const ANIMATED_ORIGINAL_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxPixels: 25_000_000,
  /** The image's longer side on screen (CSS px) from which it plays; below that it is a still. */
  minScreenPx: 160,
} as const

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * True when resolve() should hand out the animated original instead of the static preview: a ready
 * version whose content the worker confirmed as GIF (or WebP the uploading client flagged as
 * animated), within the byte and pixel limits, on screen at a readable size, no reduced-motion
 * preference and no very slow network.
 */
export function playsAnimatedOriginal(
  meta: AssetVersionMeta,
  asset: { w: number; h: number; isAnimated?: boolean },
  ctx: Pick<TLAssetContext, 'screenScale' | 'networkEffectiveType'>,
  reducedMotion: boolean,
): boolean {
  if (meta.status !== 'ready' || meta.kind !== 'image' || reducedMotion) return false
  const animatedType =
    meta.mimeType === 'image/gif' || (meta.mimeType === 'image/webp' && asset.isAnimated === true)
  if (!animatedType) return false
  const L = ANIMATED_ORIGINAL_LIMITS
  if (!(meta.sizeBytes > 0 && meta.sizeBytes <= L.maxBytes)) return false
  const w = meta.probe.width ?? asset.w
  const h = meta.probe.height ?? asset.h
  if (!(w > 0 && h > 0) || w * h > L.maxPixels) return false
  if (SLOW_NETWORKS.has(ctx.networkEffectiveType ?? '')) return false
  // screenScale is CSS px per asset px, so this is the longer side's size on screen.
  const onScreen = Math.max(asset.w, asset.h) * ctx.screenScale
  return Number.isFinite(onScreen) && onScreen >= L.minScreenPx
}

/**
 * Static tiles (apps/web/public/img) shown instead of an image that has no usable preview. They are
 * only ever returned by resolve(), never written into a record, so the synced asset keeps its stable
 * reference and "Download original" / export still get the original bytes.
 */
export const IMAGE_UNAVAILABLE_URL = '/img/image-unavailable.svg'
export const IMAGE_PROCESSING_URL = '/img/image-processing.svg'

/** How long resolve() waits for the worker's previews before giving up on this resolve. */
export const PREVIEW_WAIT_MS = 60_000
/** After that wait, originals up to this size are shown as they are; bigger ones keep the tile. */
export const SMALL_ORIGINAL_BYTES = 1.5 * 1024 * 1024

export interface ResolveOptions {
  previewWaitMs?: number
  /** Whether animated images should stay still (default: the prefers-reduced-motion media query). */
  reducedMotion?: () => boolean
}

export async function resolveImageOrVideoUrl(
  boardId: string,
  metaStore: AssetMetaStore,
  asset: TLAsset,
  ctx: TLAssetContext,
  opts: ResolveOptions = {},
): Promise<string | null> {
  const ref = parseFileRef(asset.props.src)
  // Only our own stable refs resolve. Anything else (foreign URLs pasted from other apps, data:
  // URLs) is not fetched: an arbitrary image URL would leak every viewer's IP to that host.
  if (!ref) return null
  const page = asset.type === 'image' ? pdfPageOf(asset) : null
  if (page !== null) return resolvePdfPageUrl(boardId, metaStore, asset, ref, page, ctx, opts)
  const original = originalUrl(boardId, ref.assetId, ref.versionId)
  if (asset.type === 'video' || ctx.shouldResolveToOriginal) return original
  let snap = await metaStore.load(boardId, ref.assetId, ref.versionId)
  // The meta route stayed unreachable through load()'s retries. Never fall back to the original
  // for that (a fetch storm would turn into an original storm): show nothing yet; the next resolve
  // (zoom, pan, the asset record changing) asks again.
  if (snap.error && !snap.meta && !isTerminal(snap)) return null
  if (!isTerminal(snap)) {
    // Queued or processing: wait for the previews instead of downloading the full original. tldraw
    // keeps what it showed before while this is pending: the uploading tab's local preview (blob),
    // or the loading tile everywhere else (F8: animated, with the file name; pending-images.ts).
    snap = await whilePending(
      asset.id,
      waitForTerminalMeta(
        metaStore,
        boardId,
        ref.assetId,
        ref.versionId,
        opts.previewWaitMs ?? PREVIEW_WAIT_MS,
      ),
    )
  }
  const { meta, missing } = snap
  if (missing || meta?.status === 'failed') return IMAGE_UNAVAILABLE_URL
  if (meta?.status !== 'ready') {
    // Still not ready after the wait: a small original is cheap enough to show as it is.
    const size = meta?.sizeBytes ?? (asset.type === 'image' ? asset.props.fileSize : undefined)
    return typeof size === 'number' && size <= SMALL_ORIGINAL_BYTES ? original : IMAGE_PROCESSING_URL
  }
  if (
    asset.type === 'image' &&
    playsAnimatedOriginal(meta, asset.props, ctx, (opts.reducedMotion ?? prefersReducedMotion)()) &&
    // export-control (SEAM-10): the api cannot tell an animated WebP from a still one with a preview,
    // so it keeps that original from viewers the board limits; their canvas shows the preview.
    (meta.mimeType !== 'image/webp' || exportCertainOnBoard(boardId))
  ) {
    return original
  }
  const nativeWidth = asset.type === 'image' ? asset.props.w : 0
  const d = pickImageDerivative(meta, nativeWidth, ctx)
  return d ? derivativeUrl(boardId, ref.assetId, ref.versionId, d.id) : original
}

/**
 * An image asset showing one page of a PDF version: that page's derivative, or the unavailable tile
 * when the version is gone, failed, or has no rendering of that page (only the first
 * LIMITS.eagerPdfPages pages are rendered). Never the PDF original, not even for export.
 */
async function resolvePdfPageUrl(
  boardId: string,
  metaStore: AssetMetaStore,
  asset: TLAsset,
  ref: { assetId: string; versionId: string },
  page: number,
  ctx: TLAssetContext,
  opts: ResolveOptions,
): Promise<string | null> {
  let snap = await metaStore.load(boardId, ref.assetId, ref.versionId)
  if (snap.error && !snap.meta && !isTerminal(snap)) return null
  if (!isTerminal(snap)) {
    // Pages are only placed from a ready version, so this is a re-rendered or restored one.
    snap = await waitForTerminalMeta(
      metaStore,
      boardId,
      ref.assetId,
      ref.versionId,
      opts.previewWaitMs ?? PREVIEW_WAIT_MS,
    )
  }
  const { meta } = snap
  if (snap.missing || !meta || meta.status === 'failed') return IMAGE_UNAVAILABLE_URL
  if (meta.status !== 'ready') return IMAGE_PROCESSING_URL
  const nativeWidth = asset.type === 'image' ? asset.props.w : 0
  const d = pickPageDerivative(meta, page, nativeWidth, ctx)
  return d ? derivativeUrl(boardId, ref.assetId, ref.versionId, d.id) : IMAGE_UNAVAILABLE_URL
}

export interface AssetStoreOptions extends ResolveOptions {
  boardId: string
  metaStore: AssetMetaStore
  /** Called in the uploading tab only, once the server has accepted the bytes. */
  onUploaded?: (assetId: TLAssetId, meta: AssetVersionMeta) => void
}

export function createAssetStore({
  boardId,
  metaStore,
  onUploaded,
  previewWaitMs,
  reducedMotion,
}: AssetStoreOptions): TLAssetStore {
  return {
    async upload(asset, file, abortSignal) {
      const meta = await uploadFile({ boardId, file, signal: abortSignal })
      onUploaded?.(asset.id, meta)
      // Only stable ids go into the synced record; URLs are derived per render in resolve().
      return {
        src: stableFileRef(meta.assetId, meta.versionId),
        meta: { assetId: meta.assetId, versionId: meta.versionId },
      }
    },
    resolve(asset, ctx) {
      return resolveImageOrVideoUrl(boardId, metaStore, asset, ctx, { previewWaitMs, reducedMotion })
    },
    // No remove(): undo, "Recently deleted" or another collaborator can bring the shape back. Deleting
    // a shape never deletes its file. The api's collector (apps/api/src/files/gc.ts) marks files nothing
    // references and, by default, only reports them; it deletes a file only with DRAFTROOM_ASSET_GC=delete,
    // 30 days after the last reference is gone.
  }
}
