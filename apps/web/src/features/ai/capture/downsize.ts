// OWNER: WS5 (wave N, N5-2). A photo made ready to send: decoded by the browser (its EXIF orientation applied), drawn
// at most CAPTURE_CLIENT_MAX_SIDE px on its longest side (never enlarged, the aspect ratio kept) on a white
// background, and encoded as a JPEG of CAPTURE_CLIENT_JPEG_QUALITY. A canvas re-encode carries no EXIF, GPS or other
// metadata; stripJpegMetadata takes out every APPn (but the JFIF APP0) and COM segment of the result all the same, so
// what leaves the device is pixels and nothing else, whichever browser encoded it.
//
// The browser parts (createImageBitmap, a canvas) are behind DownsizeEnv, so the size rules and the marker walk are
// unit-tested in Node and the real encode is checked in Chromium by the e2e (n5-capture-photo.spec.ts).

import { CAPTURE_CLIENT_JPEG_QUALITY, CAPTURE_CLIENT_MAX_SIDE } from '@draftroom/contracts'

/** The photo could not be decoded (a format this browser cannot read, or a broken file). */
export class PhotoUnreadableError extends Error {
  constructor() {
    super('unreadable')
    this.name = 'PhotoUnreadableError'
  }
}

/** The size to draw `width` × `height` at so its longest side is at most `max` (never larger; at least 1 px). */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const scale = Math.min(1, max / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

export interface JpegSegment {
  /** the marker's second byte (0xE1 is APP1, EXIF and XMP; 0xFE a comment) */
  readonly marker: number
  readonly offset: number
  /** the whole segment, marker included */
  readonly length: number
}

/** The marker segments of a JPEG from SOI up to the start of scan (SOS included; its data is not walked). */
export function jpegSegments(bytes: Uint8Array): JpegSegment[] {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG')
  const out: JpegSegment[] = [{ marker: 0xd8, offset: 0, length: 2 }]
  let o = 2
  while (o + 4 <= bytes.length) {
    if (bytes[o] !== 0xff) throw new Error('bad JPEG marker')
    const marker = bytes[o + 1] ?? 0
    if (marker === 0xff) {
      o++
      continue
    }
    const length = ((bytes[o + 2] ?? 0) << 8) | (bytes[o + 3] ?? 0)
    out.push({ marker, offset: o, length: length + 2 })
    if (marker === 0xda) break
    o += 2 + length
  }
  return out
}

const isMetadata = (marker: number) => (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe

/** The JPEG without its metadata segments (APP1 to APP15 and COM: EXIF, GPS, XMP, ICC, maker notes, comments). */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const segs = jpegSegments(bytes)
  const sos = segs.at(-1)
  if (sos?.marker !== 0xda) return bytes
  const keep = segs.filter((s) => !isMetadata(s.marker))
  const head = keep.reduce((n, s) => n + (s.marker === 0xda ? 0 : s.length), 0)
  const tail = bytes.length - sos.offset
  const out = new Uint8Array(head + tail)
  let at = 0
  for (const s of keep) {
    if (s.marker === 0xda) break
    out.set(bytes.subarray(s.offset, s.offset + s.length), at)
    at += s.length
  }
  out.set(bytes.subarray(sos.offset), at)
  return out
}

/** Whether a JPEG still carries any metadata segment (what the tests and the e2e check). */
export const jpegHasMetadata = (bytes: Uint8Array): boolean =>
  jpegSegments(bytes).some((s) => isMetadata(s.marker))

/** The browser parts: decode a file, and a canvas to draw on and encode from. */
export interface DownsizeEnv {
  decode(file: Blob): Promise<{ width: number; height: number; source: CanvasImageSource; close(): void }>
  encode(
    source: CanvasImageSource,
    size: { width: number; height: number },
    quality: number,
  ): Promise<Uint8Array>
}

/** The browser's: createImageBitmap (orientation from the image), an OffscreenCanvas or a canvas element. */
export const browserDownsizeEnv: DownsizeEnv = {
  async decode(file) {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      throw new PhotoUnreadableError()
    }
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
  },
  async encode(source, size, quality) {
    const draw = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, size.width, size.height)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(source, 0, 0, size.width, size.height)
    }
    let blob: Blob | null
    if (typeof OffscreenCanvas === 'function') {
      const c = new OffscreenCanvas(size.width, size.height)
      const ctx = c.getContext('2d')
      if (!ctx) throw new PhotoUnreadableError()
      draw(ctx)
      blob = await c.convertToBlob({ type: 'image/jpeg', quality })
    } else {
      const c = document.createElement('canvas')
      c.width = size.width
      c.height = size.height
      const ctx = c.getContext('2d')
      if (!ctx) throw new PhotoUnreadableError()
      draw(ctx)
      blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', quality))
    }
    if (!blob) throw new PhotoUnreadableError()
    return new Uint8Array(await blob.arrayBuffer())
  },
}

export interface DownsizedPhoto {
  readonly blob: Blob
  readonly width: number
  readonly height: number
}

/** The photo ready to send (see the header). Rejects PhotoUnreadableError when it cannot be decoded. */
export async function downsizePhoto(
  file: Blob,
  env: DownsizeEnv = browserDownsizeEnv,
  opts: { maxSide?: number; quality?: number } = {},
): Promise<DownsizedPhoto> {
  const img = await env.decode(file)
  try {
    const size = fitWithin(img.width, img.height, opts.maxSide ?? CAPTURE_CLIENT_MAX_SIDE)
    const jpeg = await env.encode(img.source, size, opts.quality ?? CAPTURE_CLIENT_JPEG_QUALITY)
    let clean: Uint8Array
    try {
      clean = stripJpegMetadata(jpeg)
    } catch {
      throw new PhotoUnreadableError()
    }
    return { blob: new Blob([clean as BlobPart], { type: 'image/jpeg' }), ...size }
  } finally {
    img.close()
  }
}
