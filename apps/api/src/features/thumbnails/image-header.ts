// What an uploaded thumbnail really is, from its bytes alone: PNG, WebP or JPEG, and its dimensions from
// the image header. The api has no image decoder (decoding untrusted images stays in the preview worker),
// so this is a strict structural check: the magic numbers, the header that carries the size, and the
// container's own end (PNG IEND, the RIFF length, JPEG EOI), so nothing can ride along after the image.
// Browsers decode the image itself; it is served with its sniffed type, nosniff and a sandbox CSP.
// Pure: unit-tested in Node.

import type { ThumbnailMimeType } from '@draftroom/contracts'

export interface ImageHeader {
  mimeType: ThumbnailMimeType
  width: number
  height: number
}

/** Why the bytes are not an acceptable image (shown to the uploader, so short and generic). */
export class ImageHeaderError extends Error {}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// The last chunk of every PNG: length 0, "IEND", CRC.
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]

const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, o: number) => u16le(b, o) | ((b[o + 2] ?? 0) << 16)
const u32be = (b: Uint8Array, o: number) => u16be(b, o) * 0x10000 + u16be(b, o + 2)
const u32le = (b: Uint8Array, o: number) => u16le(b, o) + u16le(b, o + 2) * 0x10000
const ascii = (b: Uint8Array, o: number, s: string) => {
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false
  return true
}
const startsWith = (b: Uint8Array, bytes: readonly number[], at = 0) =>
  b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x)

/** APNG's animation chunks (acTL announces the animation; fcTL/fdAT carry the frames). */
const APNG_CHUNKS = ['acTL', 'fcTL', 'fdAT']

function png(b: Uint8Array): ImageHeader {
  // Signature (8), then the IHDR chunk: length 13, "IHDR", width, height, 5 more bytes, CRC.
  if (b.length < 8 + 25 + PNG_IEND.length) throw new ImageHeaderError('The PNG is truncated.')
  if (u32be(b, 8) !== 13 || !ascii(b, 12, 'IHDR')) throw new ImageHeaderError('The PNG has no header.')
  if (!startsWith(b, PNG_IEND, b.length - PNG_IEND.length))
    throw new ImageHeaderError('The PNG does not end where it should.')
  // Walk every chunk (length, type, data, CRC) from IHDR to IEND: they must line up exactly with the
  // end of the body, and none may be an APNG animation chunk (SEAM-12: an animated PNG would play on
  // every dashboard card, which animated WebP is already refused for). At most 256 KB: a cheap walk.
  let o = 8
  for (;;) {
    if (o + 12 > b.length) throw new ImageHeaderError('The PNG is truncated.')
    const length = u32be(b, o)
    const end = o + 12 + length
    if (end > b.length) throw new ImageHeaderError('The PNG is truncated.')
    if (APNG_CHUNKS.some((type) => ascii(b, o + 4, type)))
      throw new ImageHeaderError('Animated images are not accepted.')
    if (ascii(b, o + 4, 'IEND')) {
      if (end !== b.length) throw new ImageHeaderError('The PNG does not end where it should.')
      break
    }
    o = end
  }
  return { mimeType: 'image/png', width: u32be(b, 16), height: u32be(b, 20) }
}

function webp(b: Uint8Array): ImageHeader {
  // "RIFF" <size of everything after these 8 bytes> "WEBP", then the first chunk: fourcc + size.
  if (b.length < 30) throw new ImageHeaderError('The WebP is truncated.')
  if (u32le(b, 4) + 8 !== b.length) throw new ImageHeaderError('The WebP does not end where it should.')
  const chunkSize = u32le(b, 16)
  if (chunkSize + 20 > b.length) throw new ImageHeaderError('The WebP is truncated.')
  if (ascii(b, 12, 'VP8 ')) {
    // Lossy: a 3-byte frame tag (bit 0 clear = key frame), the start code 9d 01 2a, then 14-bit sizes.
    if ((b[20] ?? 1) & 1 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a)
      throw new ImageHeaderError('The WebP has no key frame.')
    return { mimeType: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (ascii(b, 12, 'VP8L')) {
    // Lossless: signature 0x2f, then width-1 and height-1 (14 bits each) and a 3-bit version (0).
    const bits = u32le(b, 21)
    if (b[20] !== 0x2f || bits >>> 29 !== 0) throw new ImageHeaderError('The WebP header is not valid.')
    return { mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(b, 12, 'VP8X')) {
    // Extended: flags, 3 reserved bytes, canvas width-1 and height-1 (24 bits each). No animations.
    if (chunkSize < 10) throw new ImageHeaderError('The WebP header is not valid.')
    if ((b[20] ?? 0) & 0x02) throw new ImageHeaderError('Animated images are not accepted.')
    return { mimeType: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  }
  throw new ImageHeaderError('The WebP header is not valid.')
}

// Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

function jpeg(b: Uint8Array): ImageHeader {
  if (b.length < 4 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9)
    throw new ImageHeaderError('The JPEG does not end where it should.')
  // Walk the marker segments after SOI up to the first start-of-frame (it must come before the scan).
  let o = 2
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) throw new ImageHeaderError('The JPEG header is not valid.')
    const marker = b[o + 1] ?? 0
    if (marker === 0xff) {
      o += 1 // fill byte
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda || (marker >= 0xd0 && marker <= 0xd7)) break // a second SOI, EOI, the scan or a restart marker before any frame header
    const length = u16be(b, o + 2)
    if (length < 2 || o + 2 + length > b.length) throw new ImageHeaderError('The JPEG is truncated.')
    if (isSof(marker)) {
      if (length < 8) throw new ImageHeaderError('The JPEG header is not valid.')
      return { mimeType: 'image/jpeg', height: u16be(b, o + 5), width: u16be(b, o + 7) }
    }
    o += 2 + length
  }
  throw new ImageHeaderError('The JPEG has no frame header.')
}

/**
 * The image's type and size from its header, or ImageHeaderError. Sizes of 0 (e.g. a JPEG whose
 * height comes later, in a DNL segment) are returned as 0: the caller's range check refuses them.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  if (startsWith(bytes, PNG_SIGNATURE)) return png(bytes)
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return webp(bytes)
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpeg(bytes)
  throw new ImageHeaderError('Upload a PNG, WebP or JPEG image.')
}
