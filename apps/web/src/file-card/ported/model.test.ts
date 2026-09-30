import { describe, expect, it } from 'vitest'
import type { AssetVersionMeta } from '../../assets/contract.ts'
import type { CanvasElement } from '../../canvas/api/index.ts'
import {
  cardViewOf,
  excalidrawCrop,
  factsOf,
  fileItemKind,
  imageSizeFromHeader,
  pageOfFileId,
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
