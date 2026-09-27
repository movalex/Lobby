import type { TLAsset, TLAssetContext, TLAssetId, TLAssetStore } from 'tldraw'
import {
  type AssetVersionMeta,
  type DerivativeRecord,
  derivativeUrl,
  isId,
  originalUrl,
  stableFileRef,
  usableDerivatives,
} from './contract.ts'
import { type AssetMetaStore, isTerminal, waitForTerminalMeta } from './meta-store.ts'
import './pending-image.css'
import { uploadFile } from './upload.ts'

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
    // or the loading tile everywhere else.
    snap = await waitForTerminalMeta(
      metaStore,
      boardId,
      ref.assetId,
      ref.versionId,
      opts.previewWaitMs ?? PREVIEW_WAIT_MS,
    )
  }
  const { meta, missing } = snap
  if (missing || meta?.status === 'failed') return IMAGE_UNAVAILABLE_URL
  if (meta?.status !== 'ready') {
    // Still not ready after the wait: a small original is cheap enough to show as it is.
    const size = meta?.sizeBytes ?? (asset.type === 'image' ? asset.props.fileSize : undefined)
    return typeof size === 'number' && size <= SMALL_ORIGINAL_BYTES ? original : IMAGE_PROCESSING_URL
  }
  const nativeWidth = asset.type === 'image' ? asset.props.w : 0
  const d = pickImageDerivative(meta, nativeWidth, ctx)
  return d ? derivativeUrl(boardId, ref.assetId, ref.versionId, d.id) : original
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
      return resolveImageOrVideoUrl(boardId, metaStore, asset, ctx, { previewWaitMs })
    },
    // No remove(): undo or another collaborator can bring the shape back; bytes are GC'd server-side.
  }
}
