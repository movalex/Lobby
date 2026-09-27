import { describe, expect, it } from 'vitest'
import { crc32, isPng, pixelsPerMetre, setPngDensity } from './png-density.ts'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function chunk(type: string, data: number[]): number[] {
  const body = new Uint8Array([...Array.from(type, (c) => c.charCodeAt(0)), ...data])
  const len = data.length
  const crc = crc32(body)
  return [
    (len >>> 24) & 255,
    (len >>> 16) & 255,
    (len >>> 8) & 255,
    len & 255,
    ...body,
    (crc >>> 24) & 255,
    (crc >>> 16) & 255,
    (crc >>> 8) & 255,
    crc & 255,
  ]
}

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const IHDR = chunk('IHDR', [...u32(2), ...u32(1), 8, 6, 0, 0, 0])
const phys = (ppm: number) => chunk('pHYs', [...u32(ppm), ...u32(ppm), 1])
const IDAT = chunk('IDAT', [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])
const IEND = chunk('IEND', [])

interface Chunk {
  type: string
  data: Uint8Array
  crcOk: boolean
}

function chunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: Chunk[] = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = view.getUint32(offset + 8 + length)
    out.push({ type, data, crcOk: crc === crc32(png.subarray(offset + 4, offset + 8 + length)) })
    offset += 12 + length
  }
  return out
}

describe('crc32', () => {
  it('matches the PNG reference value', () => {
    // Every PNG ends with IEND, whose CRC is the well-known AE 42 60 82.
    expect(crc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44]))).toBe(0xae426082)
  })
})

describe('setPngDensity', () => {
  it('replaces duplicated pHYs chunks (what tldraw leaves after a second setPhysChunk) with one', () => {
    const input = new Uint8Array([...SIGNATURE, ...IHDR, ...phys(5671), ...phys(11342), ...IDAT, ...IEND])
    const out = setPngDensity(input, 4)
    expect(isPng(out)).toBe(true)
    const list = chunks(out)
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND'])
    expect(list.every((c) => c.crcOk)).toBe(true)
    const p = list[1]?.data ?? new Uint8Array()
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength)
    expect([view.getUint32(0), view.getUint32(4), p[8]]).toEqual([pixelsPerMetre(4), pixelsPerMetre(4), 1])
    // Everything else is byte-identical.
    expect(Array.from(list[0]?.data ?? [])).toEqual(IHDR.slice(8, -4))
    expect(Array.from(list[2]?.data ?? [])).toEqual(IDAT.slice(8, -4))
  })

  it('adds pHYs before the first IDAT when there is none', () => {
    const input = new Uint8Array([...SIGNATURE, ...IHDR, ...IDAT, ...IDAT, ...IEND])
    const list = chunks(setPngDensity(input, 1))
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IDAT', 'IEND'])
    expect(list.every((c) => c.crcOk)).toBe(true)
  })

  it('uses N × 72 dpi', () => {
    expect(pixelsPerMetre(1)).toBe(2835)
    expect(pixelsPerMetre(2)).toBe(5669)
    expect(pixelsPerMetre(4)).toBe(11339)
  })

  it('leaves anything that is not a complete PNG alone', () => {
    const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(setPngDensity(notPng, 2)).toBe(notPng)
    const truncated = new Uint8Array([...SIGNATURE, ...IHDR.slice(0, 10)])
    expect(setPngDensity(truncated, 2)).toBe(truncated)
    const noIdat = new Uint8Array([...SIGNATURE, ...IHDR, ...IEND])
    expect(setPngDensity(noIdat, 2)).toBe(noIdat)
    const good = new Uint8Array([...SIGNATURE, ...IHDR, ...IDAT, ...IEND])
    expect(setPngDensity(good, 0)).toBe(good)
    expect(setPngDensity(good, Number.NaN)).toBe(good)
  })
})
