// PNG pixel density (the pHYs chunk) for image exports: a PNG exported at N× says "N × 72 dpi", so apps
// that honour it show it at board size, N× sharper.
//
// Why not tldraw's `PngHelpers.setPhysChunk` (5.4.2): it always inserts a new pHYs before the first
// IDAT (its "replace the existing chunk" branch is overwritten by the IDAT lookup), and tldraw's
// rasterizer has already written one at its own pixel ratio. Calling it again leaves TWO pHYs chunks —
// invalid PNG (at most one is allowed) — and decoders keep the first (libpng ignores the duplicate), so a
// 4× export read as 2× and a 1× export as 2×. This removes every pHYs and writes exactly one.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

let crcTable: Uint32Array | null = null
function table(): Uint32Array {
  if (crcTable) return crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  crcTable = t
  return t
}

/** CRC-32 (ISO 3309 / PNG) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  const t = table()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Pixels per metre for `scale` × 72 dpi (1 inch = 0.0254 m). */
export function pixelsPerMetre(scale: number): number {
  return Math.round((scale * 72) / 0.0254)
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/**
 * Returns `png` with every pHYs chunk removed and one pHYs (`scale` × 72 dpi, unit metre) inserted right
 * before the first IDAT. Anything that is not a well-formed PNG up to its first IDAT is returned as is.
 */
export function setPngDensity(png: Uint8Array, scale: number): Uint8Array {
  if (!isPng(png) || !(scale > 0) || !Number.isFinite(scale)) return png
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const keep: [number, number][] = [] // [start, end) ranges of the input to copy
  let insertAt = -1 // index in `keep` before which the new chunk goes
  let offset = 8
  let copyFrom = 0
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    if (end > png.length) return png // truncated chunk: leave the file alone
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type === 'pHYs') {
      keep.push([copyFrom, offset])
      copyFrom = end
    } else if (type === 'IDAT' && insertAt < 0) {
      keep.push([copyFrom, offset])
      copyFrom = offset
      insertAt = keep.length
    }
    offset = end
    if (type === 'IEND') break
  }
  if (insertAt < 0) return png // no image data: not something we exported
  keep.push([copyFrom, png.length])

  const ppm = pixelsPerMetre(scale)
  const chunk = new Uint8Array(21)
  const c = new DataView(chunk.buffer)
  c.setUint32(0, 9)
  chunk.set([0x70, 0x48, 0x59, 0x73], 4) // "pHYs"
  c.setUint32(8, ppm)
  c.setUint32(12, ppm)
  chunk[16] = 1 // unit: metre
  c.setUint32(17, crc32(chunk.subarray(4, 17)))

  const parts = keep.map(([s, e]) => png.subarray(s, e))
  parts.splice(insertAt, 0, chunk)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
