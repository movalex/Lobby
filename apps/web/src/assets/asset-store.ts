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
import type { AssetMetaStore } from './meta-store.ts'
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

export async function resolveImageOrVideoUrl(
  boardId: string,
  metaStore: AssetMetaStore,
  asset: TLAsset,
  ctx: TLAssetContext,
): Promise<string | null> {
  const ref = parseFileRef(asset.props.src)
  // Only our own stable refs resolve. Anything else (foreign URLs pasted from other apps, data:
  // URLs) is not fetched: an arbitrary image URL would leak every viewer's IP to that host.
  if (!ref) return null
  const original = originalUrl(boardId, ref.assetId, ref.versionId)
  if (asset.type === 'video' || ctx.shouldResolveToOriginal) return original
  const { meta, missing } = await metaStore.load(boardId, ref.assetId, ref.versionId)
  if (missing || meta?.status === 'failed') return null
  if (meta?.status !== 'ready') return original // previews not generated yet: the original is a valid image
  const nativeWidth = asset.type === 'image' ? asset.props.w : 0
  const d = pickImageDerivative(meta, nativeWidth, ctx)
  return d ? derivativeUrl(boardId, ref.assetId, ref.versionId, d.id) : original
}

export interface AssetStoreOptions {
  boardId: string
  devUser: string
  metaStore: AssetMetaStore
  /** Called in the uploading tab only, once the server has accepted the bytes. */
  onUploaded?: (assetId: TLAssetId, meta: AssetVersionMeta) => void
}

export function createAssetStore({
  boardId,
  devUser,
  metaStore,
  onUploaded,
}: AssetStoreOptions): TLAssetStore {
  return {
    async upload(asset, file, abortSignal) {
      const meta = await uploadFile({ boardId, devUser, file, signal: abortSignal })
      onUploaded?.(asset.id, meta)
      // Only stable ids go into the synced record; URLs are derived per render in resolve().
      return {
        src: stableFileRef(meta.assetId, meta.versionId),
        meta: { assetId: meta.assetId, versionId: meta.versionId },
      }
    },
    resolve(asset, ctx) {
      return resolveImageOrVideoUrl(boardId, metaStore, asset, ctx)
    },
    // No remove(): undo or another collaborator can bring the shape back; bytes are GC'd server-side.
  }
}
