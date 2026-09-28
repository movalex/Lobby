import { describe, expect, it } from 'vitest'
import { ImageHeaderError, readImageHeader } from '../../../src/features/thumbnails/image-header.ts'
import { apng, jpeg, png, pngWithText, webpExtended, webpLossless, webpLossy } from './images.ts'

const refused = (bytes: Uint8Array) => expect(() => readImageHeader(bytes)).toThrow(ImageHeaderError)

describe('thumbnail image headers', () => {
  it('reads the type and size of PNG, the three WebP forms and JPEG', () => {
    expect(readImageHeader(png(480, 300))).toEqual({ mimeType: 'image/png', width: 480, height: 300 })
    expect(readImageHeader(webpLossy(480, 300))).toEqual({ mimeType: 'image/webp', width: 480, height: 300 })
    expect(readImageHeader(webpLossless(321, 7))).toEqual({ mimeType: 'image/webp', width: 321, height: 7 })
    expect(readImageHeader(webpExtended(1024, 640))).toEqual({
      mimeType: 'image/webp',
      width: 1024,
      height: 640,
    })
    expect(readImageHeader(jpeg(480, 300))).toEqual({ mimeType: 'image/jpeg', width: 480, height: 300 })
    // Progressive JPEG (SOF2) carries its size the same way.
    expect(readImageHeader(jpeg(200, 100, { sof: 0xc2 }))).toEqual({
      mimeType: 'image/jpeg',
      width: 200,
      height: 100,
    })
  })

  it('refuses other formats, whatever they claim to be', () => {
    refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
    refused(Buffer.from('<!doctype html><script>alert(1)</script>'))
    refused(Buffer.from('GIF89a\x01\x00\x01\x00'))
    refused(Buffer.alloc(0))
    refused(Buffer.from([0x89, 0x50, 0x4e])) // a PNG signature cut short
  })

  it('refuses anything appended after the image, so no other content rides along', () => {
    const tail = Buffer.from('<html><script>alert(1)</script></html>')
    refused(Buffer.concat([png(4, 4), tail]))
    refused(Buffer.concat([webpLossy(4, 4), tail]))
    refused(Buffer.concat([jpeg(4, 4), tail]))
  })

  it('refuses truncated or inconsistent headers', () => {
    const p = png(4, 4)
    refused(p.subarray(0, p.length - 1)) // no complete IEND
    const noIhdr = Buffer.from(p)
    noIhdr.write('IHDX', 12, 'ascii')
    refused(noIhdr)

    const w = webpLossy(4, 4)
    const badSize = Buffer.from(w)
    badSize.writeUInt32LE(w.length, 4) // RIFF size 8 bytes too large
    refused(badSize)
    const noStart = Buffer.from(w)
    noStart[24] = 0x00 // start code 9d 01 2a broken
    refused(noStart)
    const interframe = Buffer.from(w)
    interframe[20] = 0x11 // not a key frame
    refused(interframe)
    const unknownChunk = Buffer.from(w)
    unknownChunk.write('ALPH', 12, 'ascii')
    refused(unknownChunk)
    const lossless = webpLossless(4, 4)
    const badSig = Buffer.from(lossless)
    badSig[20] = 0x2e
    refused(badSig)

    const j = jpeg(4, 4)
    refused(j.subarray(0, j.length - 1)) // no EOI
    const noFrame = Buffer.concat([j.subarray(0, 20), j.subarray(39)]) // SOF removed: scan first
    refused(noFrame)
  })

  it('refuses animated WebP', () => {
    refused(webpExtended(4, 4, { animated: true }))
  })

  it('refuses animated PNG (APNG: an acTL chunk), like animated WebP (SEAM-12)', () => {
    expect(() => readImageHeader(apng(64, 40))).toThrow('Animated images are not accepted.')
    // The spec puts acTL before the first IDAT; a misplaced one is refused all the same.
    refused(apng(64, 40, { acTLAfterIdat: true }))
    // An ordinary PNG with ancillary chunks is still a PNG.
    expect(readImageHeader(pngWithText(64, 40))).toEqual({ mimeType: 'image/png', width: 64, height: 40 })
  })

  it('refuses a PNG whose chunks do not line up with its end', () => {
    const p = pngWithText(4, 4)
    const longer = Buffer.from(p)
    longer.writeUInt32BE(p.readUInt32BE(33) + 7, 33) // the tEXt chunk claims 7 more bytes
    refused(longer)
    // IEND bytes glued on after arbitrary data: the chunk walk never reaches them as a chunk.
    const glued = Buffer.concat([
      p.subarray(0, 33),
      Buffer.from('<script>alert(1)</script>'),
      p.subarray(-12),
    ])
    refused(glued)
  })

  it('reports a zero or huge size as it is (the route refuses it)', () => {
    expect(readImageHeader(png(0, 0)).width).toBe(0)
    expect(readImageHeader(webpExtended(4000, 3000))).toMatchObject({ width: 4000, height: 3000 })
    expect(readImageHeader(jpeg(0, 10)).width).toBe(0)
  })
})
