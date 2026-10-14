import { describe, expect, it } from 'vitest'
import type { AssetVersionMeta } from '../../assets/contract.ts'
import type { CanvasElement } from '../../canvas/api/index.ts'
import {
  CARD_RADIUS,
  CARD_ROUNDNESS,
  type CardView,
  cardViewOf,
  cornerRadiusOf,
  displaySizeFromHeader,
  excalidrawCrop,
  exifOrientation,
  factsOf,
  fileItemKind,
  imageSizeFromHeader,
  pageOfFileId,
  PREVIEW_SLOW_MS,
  previewStateText,
  thumbSizeOf,
} from './model.ts'

const AST = 'ast_AAAAAAAAAAAAAAAAAAAA'
const VER = 'ver_BBBBBBBBBBBBBBBBBBBB'
const facts = (kind: string, extra: Record<string, unknown> = {}) => ({
  assetId: AST,
  versionId: VER,
  kind,
  name: 'q3.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1234,
  ...extra,
})
const el = (fileId: string, file: unknown, type = 'image'): CanvasElement =>
  ({ id: 'e1', type, fileId, customData: { lobby: { file } }, x: 0, y: 0, width: 10, height: 10 }) as never

describe('what a card without its picture says (wave P)', () => {
  const state = (status: CardView['status'], over: Partial<CardView> = {}) => ({ status, missing: false, ...over })

  it('says Queued, Generating and Loading while it waits, as before', () => {
    expect(previewStateText(state('queued'), false, true)).toBe('Queued for preview…')
    expect(previewStateText(state('processing'), false, true)).toBe('Generating preview…')
    expect(previewStateText(state('loading'), false, true)).toBe('Loading preview…')
  })

  it('after the wait it says the preview is taking longer and the file can still be downloaded', () => {
    expect(PREVIEW_SLOW_MS).toBe(120_000)
    const slow = 'Preview is taking longer than usual; you can still download the file.'
    expect(previewStateText(state('queued'), true, true)).toBe(slow)
    expect(previewStateText(state('processing'), true, true)).toBe(slow)
    // downloads turned off on this board: no promise of a download
    expect(previewStateText(state('queued'), true, false)).toBe('Preview is taking longer than usual.')
  })

  it('a card whose file is missing keeps saying so, slow or not; "loading" never says slow', () => {
    expect(previewStateText(state('queued', { missing: true }), true, true)).toBe('Preview unavailable')
    expect(previewStateText(state('loading'), true, true)).toBe('Loading preview…')
  })
})

describe('file facts and kinds', () => {
  it('reads well-formed facts only', () => {
    expect(factsOf(el(VER, facts('pdf')))).toMatchObject({ assetId: AST, versionId: VER, kind: 'pdf' })
    expect(factsOf(el(VER, facts('pdf', { assetId: 'nope' })))).toBeNull()
    expect(factsOf(el(VER, facts('movie')))).toBeNull()
    expect(factsOf(el(VER, facts('pdf'), 'rectangle'))).toBeNull()
    expect(factsOf({ type: 'image' } as never)).toBeNull()
  })

  it('tells cards, images and placed pages apart', () => {
    expect(fileItemKind(el(VER, facts('pdf')))).toBe('card')
    expect(fileItemKind(el(VER, facts('video')))).toBe('card')
    expect(fileItemKind(el(VER, facts('other')))).toBe('card')
    expect(fileItemKind(el(VER, facts('image')))).toBe('image')
    expect(fileItemKind(el(`${VER}@display`, facts('image')))).toBe('image')
    expect(fileItemKind(el(`${VER}.p3`, facts('pdf')))).toBe('page')
    expect(fileItemKind(el(`${VER}.p3@display`, facts('pdf')))).toBe('page')
    expect(pageOfFileId(`${VER}.p12`)).toBe(12)
    expect(pageOfFileId(VER)).toBeNull()
    expect(pageOfFileId(null)).toBeNull()
  })
})

describe('what a card shows', () => {
  const f = factsOf(el(VER, facts('pdf'))) as NonNullable<ReturnType<typeof factsOf>>
  it('says loading until the api answers, then the live facts', () => {
    expect(cardViewOf(f, { meta: null, missing: false, error: false })).toMatchObject({
      status: 'loading',
      name: 'q3.pdf',
      pageCount: null,
    })
    const meta = {
      status: 'ready',
      kind: 'pdf',
      name: 'Q3 plan.pdf',
      sizeBytes: 99,
      probe: { pageCount: 4 },
      error: null,
    } as unknown as AssetVersionMeta
    expect(cardViewOf(f, { meta, missing: false, error: false })).toMatchObject({
      status: 'ready',
      name: 'Q3 plan.pdf',
      sizeBytes: 99,
      pageCount: 4,
      errorMessage: null,
    })
    const failed = { ...meta, status: 'failed', error: { message: 'This PDF is password-protected.' } }
    expect(cardViewOf(f, { meta: failed as never, missing: false, error: false }).errorMessage).toBe(
      'This PDF is password-protected.',
    )
    expect(cardViewOf(f, { meta: null, missing: true, error: false }).missing).toBe(true)
  })
})

describe('image sizes from headers (never decoded)', () => {
  const bytes = (...parts: (number[] | string)[]) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
  const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]

  it('PNG (a 12,000 × 12,000 bomb is only read, not decoded)', () => {
    const png = bytes(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      be32(13),
      'IHDR',
      be32(12000),
      be32(12000),
    )
    expect(imageSizeFromHeader(png)).toEqual({ w: 12000, h: 12000 })
  })
  it('GIF', () => {
    expect(imageSizeFromHeader(bytes('GIF89a', le16(320), le16(200)))).toEqual({ w: 320, h: 200 })
  })
  it('JPEG (the first SOF after other segments)', () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0, 0x00, 0x10],
      new Array(14).fill(0),
      [0xff, 0xc0, 0x00, 0x11, 0x08],
      [0x05, 0x46], // height 1350
      [0x04, 0x38], // width 1080
      new Array(12).fill(0),
    )
    expect(imageSizeFromHeader(jpeg)).toEqual({ w: 1080, h: 1350 })
  })
  it('WebP (VP8X, VP8L, VP8)', () => {
    const vp8x = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBP',
      'VP8X',
      [10, 0, 0, 0],
      [0, 0, 0, 0],
      le24(1599),
      le24(1066),
    )
    expect(imageSizeFromHeader(vp8x)).toEqual({ w: 1600, h: 1067 })
    const w = 2400 - 1
    const h = 1000 - 1
    const bits = w | (h << 14)
    const vp8l = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBP',
      'VP8L',
      [0, 0, 0, 0],
      [0x2f],
      [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255],
      [0, 0, 0, 0, 0],
    )
    expect(imageSizeFromHeader(vp8l)).toEqual({ w: 2400, h: 1000 })
    const vp8 = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBP',
      'VP8 ',
      [0, 0, 0, 0],
      [0, 0, 0, 0x9d, 0x01, 0x2a],
      le16(800),
      le16(600),
    )
    expect(imageSizeFromHeader(vp8)).toEqual({ w: 800, h: 600 })
  })
  it('anything else: null', () => {
    expect(imageSizeFromHeader(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imageSizeFromHeader(new Uint8Array(0))).toBeNull()
  })

  // W5-12: a phone photo stored 1920 × 1080 with EXIF Orientation 6 is shown 1080 × 1920.
  const be16 = (n: number) => [(n >>> 8) & 255, n & 255]
  /** A TIFF block with IFD0 = [Make (ignored), Orientation `o`], little- or big-endian. */
  const tiff = (o: number, le: boolean) => {
    const s = (n: number) => (le ? le16(n) : be16(n))
    const l = (n: number) => (le ? [...le16(n & 0xffff), ...le16(n >>> 16)] : be32(n))
    return [
      ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...s(42),
      ...l(8),
      ...s(2),
      ...[...s(0x010f), ...s(2), ...l(4), 0x41, 0x42, 0x43, 0],
      ...[...s(0x0112), ...s(3), ...l(1), ...s(o), 0, 0],
      ...l(0),
    ]
  }
  const jpegWith = (o: number | null, le = false) => {
    const exif = o === null ? [] : [...bytes('Exif'), 0, 0, ...tiff(o, le)]
    return bytes(
      [0xff, 0xd8],
      exif.length ? [0xff, 0xe1, ...be16(exif.length + 2), ...exif] : [],
      [0xff, 0xc0, 0x00, 0x11, 0x08],
      be16(1080), // height
      be16(1920), // width
      new Array(12).fill(0),
    )
  }
  it('JPEG: EXIF Orientation 5-8 swaps the shown width and height; 1-4 keep them', () => {
    for (const le of [false, true]) {
      expect(exifOrientation(jpegWith(6, le))).toBe(6)
      expect(imageSizeFromHeader(jpegWith(6, le))).toEqual({ w: 1920, h: 1080 })
      expect(displaySizeFromHeader(jpegWith(6, le))).toEqual({ w: 1080, h: 1920 })
      expect(displaySizeFromHeader(jpegWith(8, le))).toEqual({ w: 1080, h: 1920 })
      expect(displaySizeFromHeader(jpegWith(5, le))).toEqual({ w: 1080, h: 1920 })
      expect(displaySizeFromHeader(jpegWith(3, le))).toEqual({ w: 1920, h: 1080 })
    }
    expect(exifOrientation(jpegWith(null))).toBeNull()
    expect(displaySizeFromHeader(jpegWith(null))).toEqual({ w: 1920, h: 1080 })
    // out of range: ignored
    expect(exifOrientation(jpegWith(9))).toBeNull()
  })
  it('WebP and PNG carry the orientation in their EXIF chunks', () => {
    const exif = tiff(6, true)
    const webp = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBP',
      'VP8X',
      [10, 0, 0, 0],
      [0x08, 0, 0, 0],
      le24(1919),
      le24(1079),
      'EXIF',
      [...le16(exif.length), 0, 0],
      exif,
    )
    expect(displaySizeFromHeader(webp)).toEqual({ w: 1080, h: 1920 })
    const png = bytes(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      be32(13),
      'IHDR',
      be32(1920),
      be32(1080),
      [8, 6, 0, 0, 0],
      [0, 0, 0, 0],
      be32(exif.length),
      'eXIf',
      exif,
      [0, 0, 0, 0],
    )
    expect(displaySizeFromHeader(png)).toEqual({ w: 1080, h: 1920 })
    // an eXIf after the image data is not read
    const late = bytes(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      be32(13),
      'IHDR',
      be32(1920),
      be32(1080),
      [8, 6, 0, 0, 0],
      [0, 0, 0, 0],
      be32(0),
      'IDAT',
      [0, 0, 0, 0],
      be32(exif.length),
      'eXIf',
      exif,
    )
    expect(displaySizeFromHeader(late)).toEqual({ w: 1920, h: 1080 })
  })
  it('a truncated or malformed EXIF block is ignored', () => {
    const j = jpegWith(6)
    expect(exifOrientation(j.subarray(0, 20))).toBeNull()
    expect(exifOrientation(bytes([0xff, 0xd8], [0xff, 0xe1, 0x00, 0x08], 'Exif', [0, 0]))).toBeNull()
  })
})

describe('the centre crop of a slot, in the thumb’s pixels', () => {
  it('thumbs fit inside 512 and are never enlarged', () => {
    expect(thumbSizeOf({ w: 1080, h: 1920 })).toEqual({ w: 288, h: 512 })
    expect(thumbSizeOf({ w: 300, h: 200 })).toEqual({ w: 300, h: 200 })
  })
  it('maps a normalized crop to Excalidraw’s', () => {
    const crop = excalidrawCrop(
      { topLeft: { x: 0, y: 0.25 }, bottomRight: { x: 1, y: 0.75 } },
      { w: 1080, h: 1920 },
    )
    expect(crop).toEqual({ x: 0, y: 128, width: 288, height: 256, naturalWidth: 288, naturalHeight: 512 })
  })
})

describe('W5-36: a card face follows its element’s corners', () => {
  it('new cards get a fixed 10-unit radius; the face reads it the way Excalidraw clips the bitmap', () => {
    expect(CARD_ROUNDNESS).toEqual({ type: 3, value: CARD_RADIUS })
    expect(cornerRadiusOf({ width: 320, height: 240, roundness: CARD_ROUNDNESS })).toBe(10)
    // shorter than the cut-off (4 × the radius): a quarter of the shorter side
    expect(cornerRadiusOf({ width: 30, height: 200, roundness: CARD_ROUNDNESS })).toBe(7.5)
    expect(cornerRadiusOf({ width: 320, height: 240, roundness: { type: 3 } })).toBe(32)
    expect(cornerRadiusOf({ width: 320, height: 240, roundness: { type: 2 } })).toBe(60)
    // cards made before W5-36 are square, so their face is square too
    expect(cornerRadiusOf({ width: 320, height: 240, roundness: null })).toBe(0)
    expect(cornerRadiusOf({ width: 320, height: 240 })).toBe(0)
  })
})
