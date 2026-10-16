// Photoshop files (wave R, docs/WAVE-R-CONTRACTS.md §6): the messages between psd.ts (worker) and psd-child.ts
// (isolated reader), the limits, and the pure reading of a PSD's layout that both sides run before ag-psd sees a byte.
// Request JSON on stdin, one JSON response on stdout. No imports: the child loads this before anything else.
//
// What a preview needs is the file's merged composite ("Maximize Compatibility"), never its layers. So the child
// rewrites the file in place (compact) into the smallest PSD that holds only that: the header with the colour
// channels (and the merged transparency) alone, no colour-mode data, two image resources (1036 thumbnail, 1057 version info), an empty layer
// section and the composite's colour planes. ag-psd then parses nothing else: no layer records, no descriptors, no
// text engine data, no other resources.

/** The worker's limits for Photoshop files: the same values as @draftroom/contracts DESIGN_PREVIEW_LIMITS. */
export const PSD_LIMITS = {
  maxPixels: 40_000_000,
  maxSide: 30_000,
  maxLayerRecords: 2_000,
  childHeapMb: 768,
  timeoutMs: 30_000,
  /** the embedded thumbnail (resource 1036) is about 160 px; anything bigger than this is not a thumbnail */
  maxThumbnailPixels: 1_000_000,
} as const

export interface PsdChildRequest {
  /** Worker-chosen path of the original (never a user file name). */
  input: string
  /** Scratch dir the child writes p1.webp into. */
  outDir: string
  /** Longest edge of the page it writes. */
  maxEdge: number
  quality: number
  maxPixels: number
  maxSide: number
  maxLayerRecords: number
}

/** Why there is no preview: `invalid` (damaged), `unsupported` (PSB, depth, mode), `too_large`, `no_composite`. */
export type PsdRefusal = 'invalid' | 'unsupported' | 'too_large' | 'no_composite'

export type PsdChildResponse =
  | {
      ok: true
      /** false: the file has no real composite and p1.webp is its embedded thumbnail (a low-resolution preview) */
      composite: boolean
      /** the document's own size (header) */
      width: number
      height: number
    }
  | { ok: false; reason: PsdRefusal; detail: string }

export const psdPageFileName = 'p1.webp'

export interface PsdHeader {
  version: number
  channels: number
  width: number
  height: number
  depth: number
  mode: number
}

export const PSD_HEADER_BYTES = 26
const MODE_GREY = 1
const MODE_RGB = 3
/** Colour modes a PSD may declare (bitmap, grey, indexed, RGB, CMYK, multichannel, duotone, Lab). */
const KNOWN_MODES = new Set([0, 1, 2, 3, 4, 7, 8, 9])

type Bytes = Uint8Array

const u16 = (b: Bytes, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
const u32 = (b: Bytes, o: number) => (u16(b, o) * 0x10000 + u16(b, o + 2)) >>> 0
const i16 = (b: Bytes, o: number) => {
  const v = u16(b, o)
  return v >= 0x8000 ? v - 0x10000 : v
}
function put16(b: Bytes, o: number, v: number) {
  b[o] = (v >>> 8) & 0xff
  b[o + 1] = v & 0xff
}
function put32(b: Bytes, o: number, v: number) {
  b[o] = (v >>> 24) & 0xff
  b[o + 1] = (v >>> 16) & 0xff
  b[o + 2] = (v >>> 8) & 0xff
  b[o + 3] = v & 0xff
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: PsdRefusal; detail: string }
const refuse = (reason: PsdRefusal, detail: string) => ({ ok: false, reason, detail }) as const

type Limits = Pick<PsdChildRequest, 'maxPixels' | 'maxSide'>

/**
 * The 26-byte header, checked before anything else is read: `8BPS`, version 1 (2 is PSB: not previewed), the
 * dimensions (each side ≤ maxSide, the area ≤ maxPixels), the channels, 8 bits and RGB or greyscale.
 */
export function checkPsdHeader(head: Bytes, limits: Limits): Checked<PsdHeader> {
  if (head.length < PSD_HEADER_BYTES) return refuse('invalid', 'short header')
  if (head[0] !== 0x38 || head[1] !== 0x42 || head[2] !== 0x50 || head[3] !== 0x53) {
    return refuse('invalid', 'no 8BPS signature')
  }
  const h: PsdHeader = {
    version: u16(head, 4),
    channels: u16(head, 12),
    height: u32(head, 14),
    width: u32(head, 18),
    depth: u16(head, 22),
    mode: u16(head, 24),
  }
  if (h.version === 2) return refuse('unsupported', 'PSB (large document format)')
  if (h.version !== 1) return refuse('invalid', `version ${h.version}`)
  if (h.channels < 1 || h.channels > 56) return refuse('invalid', `${h.channels} channels`)
  if (h.width < 1 || h.height < 1) return refuse('invalid', `${h.width}x${h.height}`)
  if (h.width > limits.maxSide || h.height > limits.maxSide || h.width * h.height > limits.maxPixels) {
    return refuse('too_large', `${h.width}x${h.height}`)
  }
  if (![1, 8, 16, 32].includes(h.depth)) return refuse('invalid', `depth ${h.depth}`)
  if (!KNOWN_MODES.has(h.mode)) return refuse('invalid', `mode ${h.mode}`)
  if (h.depth !== 8) return refuse('unsupported', `depth ${h.depth}`)
  if (h.mode !== MODE_RGB && h.mode !== MODE_GREY) return refuse('unsupported', `mode ${h.mode}`)
  if (h.channels < colourChannels(h)) return refuse('invalid', `${h.channels} channels for mode ${h.mode}`)
  return { ok: true, value: h }
}

const colourChannels = (h: PsdHeader) => (h.mode === MODE_RGB ? 3 : 1)

/** Image resources kept for ag-psd: the thumbnail and the version info (hasRealMergedData). */
const KEPT_RESOURCES = new Set([1036, 1057])

export interface PsdLayout {
  header: PsdHeader
  /** the layer count the layer section declares (absolute: a negative count only flags merged transparency) */
  layerRecords: number
  /** composite compression: 0 raw, 1 PackBits (RLE) */
  compression: number
  /** whether resource 1057 says the composite is real (null: no version info, so it is) */
  hasRealMergedData: boolean | null
}

/**
 * Walks the sections of a whole PSD (after checkPsdHeader), refuses what it must, and compacts the buffer in place
 * into the composite-only PSD described at the top of this file. Returns the new length: parse only
 * `buf.subarray(0, length)`. Every length is checked against the file, so a truncated or lying file is refused here
 * (`invalid`), never half-read; the layer count is checked against maxLayerRecords before any layer is parsed.
 */
export function compactPsd(
  buf: Bytes,
  limits: Limits & Pick<PsdChildRequest, 'maxLayerRecords'>,
): Checked<{ layout: PsdLayout; length: number }> {
  const head = checkPsdHeader(buf, limits)
  if (!head.ok) return head
  const h = head.value
  const end = buf.length
  let r = PSD_HEADER_BYTES
  const section = (what: string): Checked<{ start: number; length: number }> => {
    if (r + 4 > end) return refuse('invalid', `truncated before ${what}`)
    const length = u32(buf, r)
    const start = r + 4
    if (start + length > end) return refuse('invalid', `${what} runs past the end`)
    r = start + length
    return { ok: true, value: { start, length } }
  }
  const colourData = section('colour mode data')
  if (!colourData.ok) return colourData
  const resources = section('image resources')
  if (!resources.ok) return resources
  const layers = section('layer and mask information')
  if (!layers.ok) return layers
  const composite = r

  // the layer count, before anything parses a layer record; a negative count says the composite's first extra
  // channel is its transparency (any other extra channel is a saved selection or a spot colour: dropped)
  let layerRecords = 0
  let mergedAlpha = false
  const lm = layers.value
  if (lm.length >= 4) {
    const infoLength = u32(buf, lm.start)
    if (infoLength >= 2 && lm.length >= 6) {
      const count = i16(buf, lm.start + 4)
      layerRecords = Math.abs(count)
      mergedAlpha = count < 0
    }
  }
  if (layerRecords > limits.maxLayerRecords) return refuse('too_large', `${layerRecords} layer records`)

  // the image resources to keep, read in place
  const kept: { start: number; length: number }[] = []
  let hasRealMergedData: boolean | null = null
  {
    let o = resources.value.start
    const stop = resources.value.start + resources.value.length
    while (o + 12 <= stop) {
      const sig = String.fromCharCode(buf[o] ?? 0, buf[o + 1] ?? 0, buf[o + 2] ?? 0, buf[o + 3] ?? 0)
      if (sig !== '8BIM' && sig !== 'MeSa' && sig !== 'AgHg' && sig !== 'PHUT' && sig !== 'DCSR') {
        return refuse('invalid', 'image resource signature')
      }
      const id = u16(buf, o + 4)
      const nameLength = buf[o + 6] ?? 0
      const nameBytes = (1 + nameLength + 1) & ~1 // Pascal string padded to even
      const sizeAt = o + 6 + nameBytes
      if (sizeAt + 4 > stop) return refuse('invalid', 'truncated image resource')
      const size = u32(buf, sizeAt)
      const next = sizeAt + 4 + size + (size & 1)
      if (sizeAt + 4 + size > stop) return refuse('invalid', 'image resource runs past its section')
      if (KEPT_RESOURCES.has(id)) kept.push({ start: o, length: Math.min(next, stop) - o })
      if (id === 1057 && size >= 5) hasRealMergedData = (buf[sizeAt + 8] ?? 0) !== 0
      o = next
    }
  }

  // the composite: compression, then planar channels (raw) or row byte counts and PackBits rows (RLE)
  if (composite + 2 > end) return refuse('invalid', 'no composite')
  const compression = u16(buf, composite)
  if (compression !== 0 && compression !== 1) return refuse('invalid', `composite compression ${compression}`)
  // RGB keeps its transparency (flattened onto white later); greyscale keeps its one colour channel, as ag-psd reads
  // a greyscale composite's second channel as colour, not transparency (Photoshop's composite is matted with white).
  const keep =
    colourChannels(h) + (mergedAlpha && h.mode === MODE_RGB && h.channels > colourChannels(h) ? 1 : 0)
  const data = composite + 2
  let compositeBytes: number
  let keptCounts = 0
  if (compression === 0) {
    const plane = h.width * h.height
    if (data + plane * keep > end) return refuse('invalid', 'truncated composite')
    compositeBytes = plane * keep
  } else {
    const rows = h.channels * h.height
    if (data + rows * 2 > end) return refuse('invalid', 'truncated composite row counts')
    keptCounts = keep * h.height
    let sum = 0
    for (let i = 0; i < keptCounts; i++) sum += u16(buf, data + i * 2)
    // only the kept channels must be there in full (later ones are dropped)
    if (data + rows * 2 + sum > end) return refuse('invalid', 'truncated composite')
    compositeBytes = sum
  }

  // compact in place: every write position stays at or before the read position, so copyWithin is safe
  put16(buf, 12, keep)
  let w = PSD_HEADER_BYTES
  put32(buf, w, 0) // no colour mode data (RGB and greyscale have none)
  w += 4
  const resourcesLengthAt = w
  w += 4
  for (const k of kept) {
    buf.copyWithin(w, k.start, k.start + k.length)
    w += k.length
  }
  put32(buf, resourcesLengthAt, w - resourcesLengthAt - 4)
  put32(buf, w, 0) // no layers
  w += 4
  put16(buf, w, compression)
  w += 2
  if (compression === 0) {
    buf.copyWithin(w, data, data + compositeBytes)
    w += compositeBytes
  } else {
    buf.copyWithin(w, data, data + keptCounts * 2) // the kept channels' row counts
    w += keptCounts * 2
    const rowsData = data + h.channels * h.height * 2
    buf.copyWithin(w, rowsData, rowsData + compositeBytes)
    w += compositeBytes
  }
  return {
    ok: true,
    value: { layout: { header: h, layerRecords, compression, hasRealMergedData }, length: w },
  }
}
