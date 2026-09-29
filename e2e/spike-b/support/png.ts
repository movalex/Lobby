// A tiny PNG encoder (RGB, 8 bit, no filter) for the images the §8.4 and B9 boards upload through the api:
// deterministic gradients with a few blocks, so each image is distinct and compresses like a picture, not
// like a flat colour. Node only (zlib).
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** A `w`×`h` PNG, seeded by `i` (hue and block positions). */
export function makePng(w: number, h: number, i: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  const hue = (i * 47) % 360
  const base = [
    Math.round(128 + 100 * Math.cos((hue * Math.PI) / 180)),
    90 + (i % 7) * 20,
    Math.round(128 + 100 * Math.sin((hue * Math.PI) / 180)),
  ]
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const block = ((Math.floor(x / 40) + Math.floor(y / 40) + i) % 5) * 12
      const o = row + 1 + x * 3
      raw[o] = Math.min(255, ((base[0] as number) + (x * 80) / w + block) | 0)
      raw[o + 1] = Math.min(255, ((base[1] as number) + (y * 80) / h) | 0)
      raw[o + 2] = Math.min(255, ((base[2] as number) + block) | 0)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
