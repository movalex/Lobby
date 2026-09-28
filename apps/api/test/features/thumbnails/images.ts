// Small images for the thumbnail tests, built byte by byte. The PNG is a real, decodable image (zlib +
// CRCs); the WebP and JPEG carry valid container and frame headers around placeholder payloads, which is
// all the api checks (it never decodes images).

import { crc32, deflateSync } from 'node:zlib'

const u32be = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const u32le = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.from(type, 'ascii')
  return Buffer.concat([u32be(data.length), head, data, u32be(crc32(Buffer.concat([head, data])))])
}

/** A solid-colour RGB PNG. */
export function png(width: number, height: number, rgb: [number, number, number] = [40, 90, 160]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** fcTL: sequence, frame size, offset, delay 1/10 s, no dispose or blend. */
function fcTL(seq: number, width: number, height: number): Buffer {
  const d = Buffer.alloc(26)
  d.writeUInt32BE(seq, 0)
  d.writeUInt32BE(width, 4)
  d.writeUInt32BE(height, 8)
  d.writeUInt16BE(1, 20)
  d.writeUInt16BE(10, 22)
  return pngChunk('fcTL', d)
}

/**
 * A two-frame, loop-forever animated PNG (APNG): acTL before the first IDAT, fcTL per frame, the
 * second frame in fdAT. Browsers play it; the api must refuse it like an animated WebP.
 */
export function apng(width: number, height: number, opts: { acTLAfterIdat?: boolean } = {}): Buffer {
  const still = png(width, height)
  const ihdr = still.subarray(8, 8 + 25)
  // The IDAT chunk sits between IHDR and IEND in png().
  const idat = still.subarray(8 + 25, still.length - 12)
  const idatData = idat.subarray(8, idat.length - 4)
  const actlData = Buffer.alloc(8)
  actlData.writeUInt32BE(2, 0) // two frames
  actlData.writeUInt32BE(0, 4) // loop forever
  const acTL = pngChunk('acTL', actlData)
  const fdAT = pngChunk('fdAT', Buffer.concat([u32be(2), idatData]))
  const frames = [fcTL(0, width, height), idat, fcTL(1, width, height), fdAT]
  return Buffer.concat([
    still.subarray(0, 8),
    ihdr,
    ...(opts.acTLAfterIdat ? [...frames, acTL] : [acTL, ...frames]),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A still PNG with an ancillary text chunk (tEXt) before its image data: a valid, ordinary PNG. */
export function pngWithText(width: number, height: number, text = 'Comment\0made by Lobby'): Buffer {
  const still = png(width, height)
  return Buffer.concat([
    still.subarray(0, 8 + 25),
    pngChunk('tEXt', Buffer.from(text, 'latin1')),
    still.subarray(8 + 25),
  ])
}

function riff(chunks: Buffer): Buffer {
  return Buffer.concat([Buffer.from('RIFF'), u32le(chunks.length + 4), Buffer.from('WEBP'), chunks])
}
const webpChunk = (fourcc: string, data: Buffer) => {
  const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([Buffer.from(fourcc, 'ascii'), u32le(data.length), data, pad])
}

/** Lossy (VP8) WebP headers: a key frame with the start code and the 14-bit sizes. */
export function webpLossy(width: number, height: number, payload = 64): Buffer {
  const frame = Buffer.alloc(10 + payload)
  frame[0] = 0x10 // frame tag: key frame (bit 0 clear), show frame
  frame.set([0x9d, 0x01, 0x2a], 3)
  frame.writeUInt16LE(width & 0x3fff, 6)
  frame.writeUInt16LE(height & 0x3fff, 8)
  return riff(webpChunk('VP8 ', frame))
}

/** Lossless (VP8L) WebP headers. */
export function webpLossless(width: number, height: number, payload = 32): Buffer {
  const data = Buffer.alloc(5 + payload)
  data[0] = 0x2f
  data.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1)
  return riff(webpChunk('VP8L', data))
}

/** Extended (VP8X) WebP headers, optionally flagged as animated. */
export function webpExtended(width: number, height: number, opts: { animated?: boolean } = {}): Buffer {
  const x = Buffer.alloc(10)
  x[0] = opts.animated ? 0x02 : 0x10
  x.writeUIntLE(width - 1, 4, 3)
  x.writeUIntLE(height - 1, 7, 3)
  return riff(Buffer.concat([webpChunk('VP8X', x), webpChunk('VP8 ', webpLossy(width, height).subarray(20))]))
}

/** Baseline JPEG markers: SOI, APP0 (JFIF), SOF0 with the size, SOS, a little scan data, EOI. */
export function jpeg(width: number, height: number, opts: { sof?: number } = {}): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])
  const sof = Buffer.alloc(19)
  sof.set([0xff, opts.sof ?? 0xc0, 0x00, 17, 8], 0)
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof.set([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 9)
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof,
    sos,
    Buffer.alloc(40, 0x55),
    Buffer.from([0xff, 0xd9]),
  ])
}
