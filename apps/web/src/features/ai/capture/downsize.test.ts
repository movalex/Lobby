// Wave N (WS5, N5-2): a photo made ready to send (./downsize.ts): the longest side at most 2048 px with the aspect
// ratio kept (never enlarged), a JPEG of quality 0.85, and no EXIF, GPS, XMP or comment left in it (its JPEG markers
// parsed). The browser's decode and encode are faked here; the e2e checks the real Chromium encode.
import { CAPTURE_CLIENT_JPEG_QUALITY, CAPTURE_CLIENT_MAX_SIDE } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  type DownsizeEnv,
  downsizePhoto,
  fitWithin,
  jpegHasMetadata,
  jpegSegments,
  PhotoUnreadableError,
  stripJpegMetadata,
} from './downsize.ts'

const seg = (marker: number, payload: number[]) => {
  const len = payload.length + 2
  return [0xff, marker, len >> 8, len & 0xff, ...payload]
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** A JPEG as a phone writes one: JFIF, an EXIF APP1 with a GPS tag, XMP, a comment, then the image. */
export function phoneJpeg(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    // "Exif\0\0", a little-endian TIFF header and one IFD entry: GPSInfo (0x8825)
    ...seg(0xe1, [
      ...ascii('Exif'),
      0,
      0,
      0x49,
      0x49,
      0x2a,
      0,
      8,
      0,
      0,
      0,
      1,
      0,
      0x25,
      0x88,
      4,
      0,
      1,
      0,
      0,
      0,
      26,
      0,
      0,
      0,
    ]),
    ...seg(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')),
    ...seg(0xed, ascii('Photoshop 3.0\0')),
    ...seg(0xfe, ascii('taken at 51.5N 0.1W')),
    ...seg(
      0xdb,
      Array.from({ length: 65 }, (_, i) => i % 64),
    ),
    ...seg(0xc0, [8, 0, 48, 0, 64, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...seg(0xc4, [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    0x12,
    0x34,
    0xff,
    0x00,
    0x56,
    0xff,
    0xd9,
  ])
}

describe('the size', () => {
  it('keeps the aspect ratio, never enlarges, never goes past the longest side', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 })
    expect(fitWithin(1000, 400, 2048)).toEqual({ width: 1000, height: 400 })
    expect(fitWithin(9000, 10, 2048)).toEqual({ width: 2048, height: 2 })
    expect(fitWithin(0, 0, 2048)).toEqual({ width: 1, height: 1 })
    for (const [w, h] of [
      [4000, 3000],
      [3001, 1999],
      [2049, 2049],
    ] as const) {
      const out = fitWithin(w, h, CAPTURE_CLIENT_MAX_SIDE)
      expect(Math.max(out.width, out.height)).toBe(CAPTURE_CLIENT_MAX_SIDE)
      expect(Math.abs(out.width / out.height - w / h)).toBeLessThan(0.002)
    }
  })
})

describe('the metadata', () => {
  it('reads the markers, and strips APP1-APP15 and COM, keeping JFIF, the tables, the frame and the scan', () => {
    const jpeg = phoneJpeg()
    expect(jpegHasMetadata(jpeg)).toBe(true)
    const clean = stripJpegMetadata(jpeg)
    expect(jpegHasMetadata(clean)).toBe(false)
    expect(jpegSegments(clean).map((s) => s.marker)).toEqual([0xd8, 0xe0, 0xdb, 0xc0, 0xc4, 0xda])
    // the scan and the end are byte for byte the same
    expect([...clean.slice(-7)]).toEqual([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9])
    expect(new TextDecoder('latin1').decode(clean)).not.toMatch(/Exif|xmpmeta|Photoshop|51\.5N/)
    // a clean JPEG comes back the same
    expect([...stripJpegMetadata(clean)]).toEqual([...clean])
    expect(() => jpegSegments(new Uint8Array([0x89, 0x50]))).toThrow()
  })
})

describe('downsizePhoto', () => {
  const env = (width: number, height: number, out: Uint8Array = phoneJpeg()) => {
    const calls: { size: { width: number; height: number }; quality: number }[] = []
    let closed = 0
    const e: DownsizeEnv = {
      decode: async () => ({ width, height, source: {} as CanvasImageSource, close: () => void closed++ }),
      encode: async (_s, size, quality) => {
        calls.push({ size, quality })
        return out
      },
    }
    return { e, calls, closed: () => closed }
  }

  it('draws at most 2048 px on the long side as a JPEG of 0.85 and sends it without EXIF', async () => {
    const x = env(4032, 3024)
    const photo = await downsizePhoto(new Blob([new Uint8Array(10)]), x.e)
    expect(x.calls).toEqual([{ size: { width: 2048, height: 1536 }, quality: CAPTURE_CLIENT_JPEG_QUALITY }])
    expect(photo).toMatchObject({ width: 2048, height: 1536 })
    expect(photo.blob.type).toBe('image/jpeg')
    const bytes = new Uint8Array(await photo.blob.arrayBuffer())
    expect(jpegHasMetadata(bytes)).toBe(false)
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]).toBe(0xd8)
    expect(x.closed()).toBe(1)
  })

  it('a photo the browser cannot decode, or an encode that is no JPEG, is unreadable', async () => {
    const bad: DownsizeEnv = {
      decode: async () => {
        throw new PhotoUnreadableError()
      },
      encode: async () => new Uint8Array(),
    }
    await expect(downsizePhoto(new Blob([]), bad)).rejects.toBeInstanceOf(PhotoUnreadableError)
    const x = env(100, 100, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    await expect(downsizePhoto(new Blob([]), x.e)).rejects.toBeInstanceOf(PhotoUnreadableError)
    expect(x.closed()).toBe(1)
  })
})
