// `resolveUrl` for Lobby's image loader on a real board (docs/EXCALIDRAW-MIGRATION.md §2.10.3 "URLs",
// §2.10.4 file cards; spike checks A7 and B7).
//
// The byte routes need more than the element holds: `GET /files/<ast>/<ver>/d/<drv>?board=<bid>`
// (apps/api/src/files/serve.ts: the asset id in the path, the derivative id, and the board the caller may
// view). The element holds only `fileId` (`ver_…`, or `ver_….p<n>` for a placed PDF page) and
// `customData.lobby.file` (`assetId`, `versionId`, canonicalized by the server from the A1 file-refs
// answer, §3.3 class 4). So the resolver:
//   - learns version → asset from the scene's `customData.lobby.file` (`learn`), or from an upload
//     (`learnRef`);
//   - reads the version's metadata once through the api's meta route (`meta-store`, cached; a version
//     still processing is asked again on the loader's next retry);
//   - picks the derivative: an image's `thumb` (512 px) or `display` (2,048 px); a placed PDF page's
//     rendering of that page; a PDF card's cover (page 1); a video card's poster; never the original of a
//     raster image (§2.10.3: "the original is never loaded on the canvas");
//   - SVG: its raster derivative; with none (a terminal version without one), its original, which the
//     loader hands the engine as a runtime-only data: URL (never blob:, never stored or synced).
// Returns null while nothing can be loaded yet (the loader counts that as a failed attempt and retries).
import {
  type AssetVersionMeta,
  type DerivativeRecord,
  derivativeUrl,
  isId,
  originalUrl,
} from '@draftroom/dev-assets/shared'
import type { Derivative, FileKey } from './loader.ts'

/** The slice of `apps/web/src/assets/meta-store.ts` AssetMetaStore the resolver uses (tests fake it). */
export interface FileMetaSource {
  load(
    boardId: string,
    assetId: string,
    versionId: string,
  ): Promise<{ meta: AssetVersionMeta | null; missing: boolean; error: boolean }>
}

/** Derivatives whose ids are safe to put in a URL path (meta comes from the network: never trust it). */
const usable = (meta: AssetVersionMeta): DerivativeRecord[] =>
  Array.isArray(meta.derivatives)
    ? meta.derivatives.filter((d) => isId('drv', d?.id) && d.width > 0 && d.height > 0)
    : []

/** The on-screen size each local derivative stands for (§2.10.3 "Derivatives by zoom"). */
export const DERIVATIVE_TARGET_PX: Readonly<Record<Derivative, number>> = { thumb: 512, display: 2048 }

/** The smallest rendering at least `target` wide (by its longer side), else the largest. */
function atLeast(list: DerivativeRecord[], target: number): DerivativeRecord | null {
  const sorted = [...list].sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height))
  return sorted.find((d) => Math.max(d.width, d.height) >= target) ?? sorted[sorted.length - 1] ?? null
}

export type FilePick =
  | { readonly kind: 'derivative'; readonly derivative: DerivativeRecord }
  | { readonly kind: 'original' }
  | null

const terminal = (meta: AssetVersionMeta) => meta.status === 'ready' || meta.status === 'failed'

/**
 * What to load for `file` from `meta` (see the header), or null when nothing can be loaded (yet).
 * Pure: unit-tested with the api's own meta shapes.
 */
export function pickFor(meta: AssetVersionMeta, file: Pick<FileKey, 'derivative' | 'page'>): FilePick {
  const all = usable(meta)
  const target = DERIVATIVE_TARGET_PX[file.derivative]
  if (file.page !== null) {
    // A placed PDF page: its page rendering (the cover's thumb counts for page 1).
    if (meta.kind !== 'pdf') return null
    const pages = all.filter((d) => (d.role === 'page' || d.role === 'thumb') && d.page === file.page)
    const d = atLeast(pages, target)
    return d ? { kind: 'derivative', derivative: d } : null
  }
  if (meta.kind === 'image') {
    const thumb = all.find((d) => d.role === 'thumb') ?? null
    const display = all.find((d) => d.role === 'display') ?? null
    const d = file.derivative === 'display' ? (display ?? thumb) : (thumb ?? display)
    if (d) return { kind: 'derivative', derivative: d }
    // SVG with no raster derivative: its original, as a runtime-only data: URL (loader.ts).
    if (meta.mimeType === 'image/svg+xml' && terminal(meta)) return { kind: 'original' }
    return null
  }
  if (meta.kind === 'pdf') {
    // A file card's face: the cover (page 1, or the thumb the worker made of it).
    const cover = all.filter((d) => d.role === 'thumb' || (d.role === 'page' && (d.page ?? 1) === 1))
    const d = atLeast(cover, target)
    return d ? { kind: 'derivative', derivative: d } : null
  }
  if (meta.kind === 'video') {
    const d = all.find((x) => x.role === 'poster') ?? all.find((x) => x.role === 'thumb') ?? null
    return d ? { kind: 'derivative', derivative: d } : null
  }
  const d = all.find((x) => x.role === 'thumb') ?? null
  return d ? { kind: 'derivative', derivative: d } : null
}

/** The `customData.lobby.file` slice the resolver reads. */
interface FileRefLike {
  readonly assetId?: unknown
  readonly versionId?: unknown
}

export interface FileUrlResolverOptions {
  boardId: string
  meta: FileMetaSource
}

export class FileUrlResolver {
  private readonly boardId: string
  private readonly meta: FileMetaSource
  private readonly assets = new Map<string, string>()

  constructor(opts: FileUrlResolverOptions) {
    this.boardId = opts.boardId
    this.meta = opts.meta
  }

  /** Learns version → asset from image elements' `customData.lobby.file` (the server's canonical copy). */
  learn(
    elements: Iterable<{
      type: string
      fileId?: string | null
      customData?: { lobby?: Readonly<Record<string, unknown>> } | null
    }>,
  ): void {
    for (const el of elements) {
      if (el.type !== 'image') continue
      const f = el.customData?.lobby?.file as FileRefLike | undefined
      if (typeof f?.assetId === 'string' && typeof f.versionId === 'string')
        this.learnRef(f.versionId, f.assetId)
    }
  }

  /** One version's asset (an upload's answer, a paste). Malformed ids are ignored. */
  learnRef(versionId: string, assetId: string): void {
    if (isId('ver', versionId) && isId('ast', assetId)) this.assets.set(versionId, assetId)
  }

  assetOf(versionId: string): string | null {
    return this.assets.get(versionId) ?? null
  }

  /** ImageLoader's `resolveUrl`: a same-origin path, or null to retry later. */
  readonly resolveUrl = async (
    versionId: string,
    derivative: Derivative,
    file: FileKey,
  ): Promise<string | null> => {
    const assetId = this.assets.get(versionId)
    if (!assetId) return null
    const snap = await this.meta.load(this.boardId, assetId, versionId)
    if (!snap.meta || snap.missing) return null
    const pick = pickFor(snap.meta, { derivative, page: file.page })
    if (!pick) return null
    return pick.kind === 'original'
      ? originalUrl(this.boardId, assetId, versionId)
      : derivativeUrl(this.boardId, assetId, versionId, pick.derivative.id)
  }
}
