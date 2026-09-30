// OWNER: 3g. The pure model of files on the Excalidraw canvas (docs/EXCALIDRAW-MIGRATION.md §2.10, §4.1):
// which image elements are file cards, plain images or placed PDF pages; what a card shows from its
// stable facts (customData.lobby.file) and the api's live meta; the pixel size of an uploaded image read
// from its header; the crop that centre-fills a template slot. No DOM, no canvas: unit-tested.
//
// On the new canvas every file is an `image` element: `fileId` is the Lobby version id (`ver_…`, a placed
// PDF page `ver_….p<n>`, optionally a local `@thumb`/`@display` suffix), `customData.lobby.file` holds the
// card's stable facts (canonicalized by the server from the file-refs answer), and live facts (status,
// pages, duration, derivatives) come from the api at runtime (assets/meta-store.ts), never from the
// element. So nothing writes an element when the worker finishes (the tldraw card's hint props are gone).
import type { AssetKind, AssetStatus, AssetVersionMeta } from '../../assets/contract.ts'
import { isId } from '../../assets/contract.ts'
import type { MetaSnapshot } from '../../assets/meta-store.ts'
import type { CanvasElement } from '../../canvas/api/index.ts'

/** canvas-schema custom-data.ts `file`. */
export interface FileFacts {
  readonly assetId: string
  readonly versionId: string
  readonly kind: AssetKind
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
}

const KINDS: ReadonlySet<string> = new Set(['image', 'pdf', 'video', 'other'])

/** The element's file facts, when it is an image element with well-formed `customData.lobby.file`. */
export function factsOf(el: Pick<CanvasElement, 'type'> & { customData?: unknown }): FileFacts | null {
  if (el.type !== 'image') return null
  const f = (el.customData as { lobby?: { file?: Partial<FileFacts> } } | null | undefined)?.lobby?.file
  if (!f || !isId('ast', f.assetId) || !isId('ver', f.versionId) || !KINDS.has(String(f.kind))) return null
  return {
    assetId: f.assetId,
    versionId: f.versionId,
    kind: f.kind as AssetKind,
    name: typeof f.name === 'string' ? f.name : '',
    mimeType: typeof f.mimeType === 'string' ? f.mimeType : 'application/octet-stream',
    sizeBytes: typeof f.sizeBytes === 'number' && f.sizeBytes >= 0 ? f.sizeBytes : 0,
  }
}

const PAGE_RE = /^ver_[0-9A-Za-z]{10,40}\.p([1-9][0-9]{0,3})(?:@\w+)?$/

/** The PDF page a placed page shows (`ver_….p<n>`), else null. */
export function pageOfFileId(fileId: string | null | undefined): number | null {
  const m = fileId ? PAGE_RE.exec(fileId) : null
  return m?.[1] ? Number(m[1]) : null
}

export type FileItemKind = 'card' | 'image' | 'page'

/**
 * How the media feature draws an element: `card` (a PDF, video or other file: Lobby's card face over
 * it), `image` (a raster or SVG image the loader shows), `page` (a placed PDF page, an image), or null.
 */
export function fileItemKind(el: CanvasElement): FileItemKind | null {
  const f = factsOf(el)
  if (!f) return null
  const fileId = (el as { fileId?: string | null }).fileId
  if (pageOfFileId(fileId) !== null) return 'page'
  return f.kind === 'image' ? 'image' : 'card'
}

/** What a card's status line and face say. `loading`: the api's meta has not answered yet. */
export type CardStatus = AssetStatus | 'loading'

export interface CardView {
  readonly status: CardStatus
  readonly kind: AssetKind
  readonly name: string
  readonly sizeBytes: number
  readonly pageCount: number | null
  readonly durationMs: number | null
  readonly errorMessage: string | null
  /** the api says this version is not on this board (or its ids are malformed) */
  readonly missing: boolean
}

const nonNegInt = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

/** What a card shows: the api's meta once it answered, the stable facts before (file-card/card-model.ts's cardView). */
export function cardViewOf(facts: FileFacts, snap: MetaSnapshot): CardView {
  const meta: AssetVersionMeta | null = snap.meta
  if (!meta) {
    return {
      status: 'loading',
      kind: facts.kind,
      name: facts.name,
      sizeBytes: facts.sizeBytes,
      pageCount: null,
      durationMs: null,
      errorMessage: null,
      missing: snap.missing,
    }
  }
  return {
    status: meta.status,
    kind: meta.kind,
    name: meta.name || facts.name,
    sizeBytes: meta.sizeBytes,
    pageCount: nonNegInt(meta.probe?.pageCount),
    durationMs: nonNegInt(meta.probe?.durationMs),
    errorMessage:
      meta.status === 'failed' ? String(meta.error?.message || 'Preview failed.').slice(0, 300) : null,
    missing: snap.missing,
  }
}

const KIND_LABEL: Readonly<Record<AssetKind, string>> = {
  pdf: 'PDF',
  video: 'Video',
  image: 'Image',
  other: 'File',
}

/**
 * What a card tells screen readers it is (FileCardShapeUtil.getAriaDescriptor on tldraw): an Office
 * document is previewed through a PDF conversion, but it is not a PDF file.
 */
export function cardDescriptor(view: Pick<CardView, 'kind' | 'name'>, officeLabel: string | null): string {
  return officeLabel ? `${officeLabel}: ${view.name}` : `${KIND_LABEL[view.kind]} file: ${view.name}`
}

// ---- image headers (the native size of a dropped image, without decoding it) --------------------------

export interface PixelSize {
  readonly w: number
  readonly h: number
}

const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, o: number) => u16le(b, o) | ((b[o + 2] ?? 0) << 16)
const u32be = (b: Uint8Array, o: number) => u16be(b, o) * 65536 + u16be(b, o + 2)
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))

/**
 * The pixel size in a PNG, JPEG, GIF or WebP header (the first 64 KiB are plenty), or null. Read from
 * the header so a decompression bomb (a 12,000 × 12,000 PNG) is never decoded in the tab; the api's
 * worker refuses it later and the canvas shows the "couldn't process" tile.
 */
export function imageSizeFromHeader(b: Uint8Array): PixelSize | null {
  if (b.length >= 24 && u32be(b, 0) === 0x89504e47 && ascii(b, 12, 4) === 'IHDR') {
    return sane(u32be(b, 16), u32be(b, 20))
  }
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') return sane(u16le(b, 6), u16le(b, 8))
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8X') return sane(u24le(b, 24) + 1, u24le(b, 27) + 1)
    if (chunk === 'VP8 ') return sane(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
    if (chunk === 'VP8L') {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
      return sane((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null
      const marker = b[o + 1] ?? 0
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2
        continue
      }
      const len = u16be(b, o + 2)
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sane(u16be(b, o + 7), u16be(b, o + 5))
      }
      if (len < 2) return null
      o += 2 + len
    }
    return null
  }
  return null
}

function sane(w: number, h: number): PixelSize | null {
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null
}

/** The worker's preview edges (apps/worker/src/config.ts): fit inside, never enlarged. */
export const THUMB_EDGE = 512

/** The size of the `thumb` the worker makes of an image of `size` (sharp `fit: 'inside'`, no enlargement). */
export function thumbSizeOf(size: PixelSize, edge = THUMB_EDGE): PixelSize {
  const s = Math.min(1, edge / Math.max(size.w, size.h))
  return { w: Math.max(1, Math.round(size.w * s)), h: Math.max(1, Math.round(size.h * s)) }
}

/** The normalized crop assets/drop-layout.ts `coverSlot` returns. */
export interface NormalizedCrop {
  readonly topLeft: { readonly x: number; readonly y: number }
  readonly bottomRight: { readonly x: number; readonly y: number }
}

/**
 * Excalidraw's `crop` for a normalized centre crop. Excalidraw crops in the pixels of the file it has
 * loaded (drawImage with the crop's x/y/width/height as they are), so the crop is in the pixels of the
 * `thumb` every tab loads; a cropped image never switches to `display` (canvas/files/swap.ts skips it).
 */
export function excalidrawCrop(
  crop: NormalizedCrop,
  natural: PixelSize,
): { x: number; y: number; width: number; height: number; naturalWidth: number; naturalHeight: number } {
  const t = thumbSizeOf(natural)
  const x = Math.round(crop.topLeft.x * t.w)
  const y = Math.round(crop.topLeft.y * t.h)
  return {
    x,
    y,
    width: Math.max(1, Math.round(crop.bottomRight.x * t.w) - x),
    height: Math.max(1, Math.round(crop.bottomRight.y * t.h) - y),
    naturalWidth: t.w,
    naturalHeight: t.h,
  }
}
