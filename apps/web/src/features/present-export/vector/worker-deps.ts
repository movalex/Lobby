// What a vector page needs from the browser (wave N, N6-3/N6-4), in the PDF worker or (without workers) on the page:
//  - Lobby's font files, fetched same-origin from /excalidraw-assets/fonts/ only (text-layout.ts FACE_URL): no
//    request ever leaves Lobby's origin, whatever the SVG's face table says;
//  - images pdf-lib cannot embed (the 2,048 px WebP previews, file-card faces, GIFs) re-encoded as JPEG, or as PNG
//    when they have transparency, through createImageBitmap and OffscreenCanvas;
//  - characters none of Lobby's fonts has (emoji) drawn as small pictures with the system's fonts, as the board
//    shows them.
// Each answers null where the environment cannot (no OffscreenCanvas): the page then falls back to an image page.

import { FACE_URL, familyList } from './text-layout.ts'
import type { GlyphPicture, VectorDeps } from './vector-page.ts'

/** Pixels per text unit a glyph picture is drawn at (sharp when the PDF is zoomed in). */
const GLYPH_SCALE = 4
/** A picture no larger than this per side (a pathological font size). */
const GLYPH_MAX_SIDE = 2048
/** Images above this many pixels are not re-encoded here (the page falls back; the raster page is capped too). */
const TRANSCODE_MAX_PIXELS = 40_000_000

const EMOJI_FONTS = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif'

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math|fangsong)$/

/**
 * A picture's CSS font list: the line's own families first (as the board draws the character: in the worker Lobby's
 * faces are not loaded, so the browser falls through to the next family, as the board does for a glyph its face
 * lacks), then the emoji fonts. Names are quoted; generic families are not.
 */
export function pictureFonts(families: string | undefined): string {
  const own = familyList(families)
    .map((f) => f.replace(/["\\]/g, ''))
    .filter(Boolean)
    .map((f) => (GENERIC.test(f) ? f : `"${f}"`))
  return own.length ? `${own.join(', ')}, ${EMOJI_FONTS}` : EMOJI_FONTS
}

type Offscreen = {
  new (
    w: number,
    h: number,
  ): {
    width: number
    height: number
    getContext(kind: '2d'): OffscreenCanvasRenderingContext2D | null
    convertToBlob(opts?: { type?: string; quality?: number }): Promise<Blob>
  }
}

const offscreen = (): Offscreen | null =>
  ((globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as Offscreen | undefined) ?? null

export async function fetchFace(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (!FACE_URL.test(url)) return null
  try {
    const res = await fetchImpl(url, { credentials: 'same-origin' })
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

export async function transcodeImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; type: 'png' | 'jpeg' } | null> {
  const Canvas = offscreen()
  const make = (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap
  if (!Canvas || !make) return null
  let bitmap: ImageBitmap
  try {
    bitmap = await make(new Blob([bytes as BlobPart], { type: mime }))
  } catch {
    return null
  }
  try {
    if (bitmap.width * bitmap.height > TRANSCODE_MAX_PIXELS) return null
    const c = new Canvas(bitmap.width, bitmap.height)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    let opaque = true
    for (let i = 3; i < data.length; i += 4)
      if ((data[i] as number) < 255) {
        opaque = false
        break
      }
    const blob = await c.convertToBlob(opaque ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' })
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: opaque ? 'jpeg' : 'png' }
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

export async function drawGlyphs(
  text: string,
  sizePx: number,
  bold: boolean,
  color: string,
  families?: string,
): Promise<GlyphPicture | null> {
  const Canvas = offscreen()
  if (!Canvas) return null
  const px = Math.max(1, Math.min(sizePx * GLYPH_SCALE, 512))
  const k = px / sizePx
  try {
    const probe = new Canvas(1, 1).getContext('2d')
    if (!probe) return null
    const font = `${bold ? '700 ' : ''}${px}px ${pictureFonts(families)}`
    probe.font = font
    const m = probe.measureText(text)
    const ascent = Math.max(m.fontBoundingBoxAscent || 0, m.actualBoundingBoxAscent || 0, px * 0.8)
    const descent = Math.max(m.fontBoundingBoxDescent || 0, m.actualBoundingBoxDescent || 0, px * 0.2)
    const w = Math.ceil(m.width)
    const h = Math.ceil(ascent + descent)
    if (w <= 0 || h <= 0 || w > GLYPH_MAX_SIDE || h > GLYPH_MAX_SIDE) return null
    const c = new Canvas(w, h)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.font = font
    ctx.fillStyle = color
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, 0, ascent)
    const blob = await c.convertToBlob({ type: 'image/png' })
    return {
      png: new Uint8Array(await blob.arrayBuffer()),
      width: m.width / k,
      ascent: ascent / k,
      descent: descent / k,
    }
  } catch {
    return null
  }
}

/** The browser's deps for vector pages (the worker's own fetch, OffscreenCanvas where there is one). */
export function browserVectorDeps(): VectorDeps {
  return { fetchFace: (url) => fetchFace(url), transcode: transcodeImage, glyphs: drawGlyphs }
}
