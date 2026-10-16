// Design-file previews (wave R, WS3; docs/WAVE-R-CONTRACTS.md §6): Photoshop (ag-psd in psd-child.ts), TIFF (sharp's
// TIFF file loader), Illustrator (the PDF path) and HEIC (an attachment), with their hostile files: lying headers,
// pixel and page bombs, truncated files, a PNG named .psd and a child that never answers.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DataLayout, LIMITS, maxKindBytes, versionDir } from '@draftroom/dev-assets'
import agPsd from 'ag-psd'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DESIGN_PREVIEW_CODES,
  DESIGN_PREVIEW_LIMITS,
  DESIGN_PREVIEW_MESSAGES,
} from '../../../packages/contracts/src/design-previews.ts'
import { type FailureCode, userMessage } from '../src/errors.ts'
import { ALLOWED_LOADERS, lockedSharp } from '../src/image.ts'
import { checkPsdHeader, compactPsd, PSD_LIMITS } from '../src/psd-protocol.ts'
import { contentByteLimit } from '../src/sniff.ts'
import { TIFF_LIMITS } from '../src/tiff.ts'
import {
  cleanupLayouts,
  derivativeBytes,
  derivativeFiles,
  ensureFixtures,
  fixturePath,
  type Ingested,
  ingest,
  metaOf,
  processNext,
  tempLayout,
} from './helpers.ts'

const HANG = fileURLToPath(new URL('./children/hang-child.ts', import.meta.url))
const CRASH = fileURLToPath(new URL('./children/crash-child.ts', import.meta.url))
const PSD = 'image/vnd.adobe.photoshop'
const MiB = 1024 * 1024

let l: DataLayout
beforeAll(async () => {
  await ensureFixtures()
  l = tempLayout()
})
afterAll(cleanupLayouts)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function expectReady(i: Ingested, opts: Parameters<typeof processNext>[1] = {}) {
  const out = await processNext(l, opts)
  expect(out).toEqual({ result: 'done', status: 'ready', skipped: false })
  const m = metaOf(l, i)
  expect(m.status).toBe('ready')
  expect(m.error).toBeNull()
  return m
}

async function expectFailed(i: Ingested, code: FailureCode, opts: Parameters<typeof processNext>[1] = {}) {
  const t0 = Date.now()
  const out = await processNext(l, opts)
  const ms = Date.now() - t0
  expect(out).toEqual({ result: 'failed', status: 'failed', code })
  const m = metaOf(l, i)
  expect(m.attempts).toBe(1) // permanent: no retries
  expect(m.error).toEqual({ code, message: userMessage(code) })
  expect(m.error?.message).not.toMatch(/[\\/]|drw-|ag-psd|vips|tiff|Exception/i)
  expect(m.error?.message).not.toMatch(/editable/i)
  expect(m.derivatives).toEqual([])
  expect(derivativeFiles(l, i)).toEqual([])
  return { meta: m, ms }
}

const pixel = async (webp: Buffer, x: number, y: number) => {
  const { data, info } = await lockedSharp()(webp).raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [data[i], data[i + 1], data[i + 2]]
}

describe('the worker’s design rules match the contracts', () => {
  it('limits, codes and messages are the contracts’ (the worker does not depend on contracts)', () => {
    expect(PSD_LIMITS).toMatchObject({
      maxPixels: DESIGN_PREVIEW_LIMITS.psdMaxPixels,
      maxSide: DESIGN_PREVIEW_LIMITS.psdMaxSide,
      maxLayerRecords: DESIGN_PREVIEW_LIMITS.psdMaxLayerRecords,
      childHeapMb: DESIGN_PREVIEW_LIMITS.psdChildHeapMb,
      timeoutMs: DESIGN_PREVIEW_LIMITS.psdTimeoutMs,
    })
    expect(TIFF_LIMITS.maxPagesRead).toBe(DESIGN_PREVIEW_LIMITS.tiffMaxPagesRead)
    expect(TIFF_LIMITS.timeoutMs).toBe(DESIGN_PREVIEW_LIMITS.tiffTimeoutMs)
    // every design code the worker reports, with the words the api shows (HEIC and the thumbnail note are the web's)
    const reported = Object.values(DESIGN_PREVIEW_CODES).filter(
      (c) => c !== 'HEIC_NO_PREVIEW' && c !== 'PSD_THUMBNAIL_ONLY',
    )
    for (const code of reported) {
      expect(userMessage(code as FailureCode), code).toBe(DESIGN_PREVIEW_MESSAGES[code])
    }
  })

  it('sharp’s loader allowlist is exactly the expected set: TIFF from a file only', async () => {
    expect([...ALLOWED_LOADERS].sort()).toEqual(
      [
        'VipsForeignLoadJpegFile',
        'VipsForeignLoadJpegBuffer',
        'VipsForeignLoadPngFile',
        'VipsForeignLoadPngBuffer',
        'VipsForeignLoadWebpFile',
        'VipsForeignLoadWebpBuffer',
        'VipsForeignLoadNsgifFile',
        'VipsForeignLoadNsgifBuffer',
        'VipsForeignLoadTiffFile',
      ].sort(),
    )
    const s = lockedSharp()
    expect((await s(fixturePath('scan-lzw.tif')).metadata()).format).toBe('tiff')
    // the buffer loader stays blocked: an image upload (decoded from a buffer) can never be a TIFF
    const tiffBuffer = readFileSync(fixturePath('scan-lzw.tif'))
    await expect(s(tiffBuffer).metadata()).rejects.toThrow(/unsupported image format/i)
  })

  it('the size limits follow the content: a PSD may be 200 MiB, a TIFF, PDF or Office document 100 MiB', () => {
    expect(maxKindBytes('pdf')).toBe(200 * MiB)
    expect(maxKindBytes('image')).toBe(LIMITS.maxBytes.image)
    expect(contentByteLimit('pdf', { mime: PSD, ext: 'psd' })).toBe(200 * MiB)
    expect(contentByteLimit('pdf', { mime: 'image/tiff', ext: 'tif' })).toBe(100 * MiB)
    expect(contentByteLimit('pdf', { mime: 'application/pdf', ext: 'pdf' })).toBe(LIMITS.maxBytes.pdf)
    expect(contentByteLimit('pdf', { mime: null, ext: null })).toBe(LIMITS.maxBytes.pdf)
  })
})

describe('Photoshop', () => {
  it('the composite becomes one flattened page and the cover; layers are never read', async () => {
    const i = ingest(l, 'design.psd', { mimeType: PSD })
    expect(i.meta.kind).toBe('pdf')
    const m = await expectReady(i)
    expect(m.mimeType).toBe(PSD)
    expect(m.probe).toMatchObject({ pageCount: 1, width: 1200, height: 800 })
    const page = m.derivatives.find((d) => d.role === 'page')
    const thumb = m.derivatives.find((d) => d.role === 'thumb')
    expect(page).toMatchObject({ page: 1, width: 1200, height: 800, mimeType: 'image/webp' })
    expect(thumb).toMatchObject({ page: 1, width: 512 })
    if (!page) throw new Error('no page')
    const webp = derivativeBytes(l, i, page.file)
    // the transparent corner is flattened onto white; the band is dark
    expect(await pixel(webp, 10, 10)).toEqual([255, 255, 255])
    for (const c of await pixel(webp, 600, 400)) expect(c).toBeLessThan(60)
  })

  it('compactPsd keeps only the header, two resources, no layers and the colour planes', () => {
    const buf = Buffer.from(readFileSync(fixturePath('design.psd')))
    const before = agPsd.readPsd(buf, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    })
    expect(before.children?.length).toBe(2)
    const r = compactPsd(buf, { ...PSD_LIMITS, maxLayerRecords: 10 })
    if (!r.ok) throw new Error(r.detail)
    expect(r.value.layout).toMatchObject({ layerRecords: 2, hasRealMergedData: true })
    expect(r.value.layout.header).toMatchObject({ channels: 4, width: 1200, height: 800, depth: 8, mode: 3 })
    const after = agPsd.readPsd(buf.subarray(0, r.value.length), {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      useRawThumbnail: true,
    })
    expect(after.children ?? []).toEqual([])
    expect(after.channels).toBe(4) // RGB and the merged transparency (design.psd has a transparent corner)
    expect(Object.keys(after.imageResources ?? {}).sort()).toEqual(['thumbnailRaw', 'versionInfo'])
    expect(r.value.length).toBeLessThan(buf.length)
  })

  it('an extra channel that is not the merged transparency (a saved selection, a spot colour) is dropped', () => {
    const buf = Buffer.from(readFileSync(fixturePath('design.psd')))
    const resourcesAt = 26 + 4 + buf.readUInt32BE(26)
    const countAt = resourcesAt + 4 + buf.readUInt32BE(resourcesAt) + 4 + 4
    expect(buf.readInt16BE(countAt)).toBe(-2) // ag-psd flags the transparency as Photoshop does
    buf.writeInt16BE(2, countAt)
    const r = compactPsd(buf, { ...PSD_LIMITS })
    if (!r.ok) throw new Error(r.detail)
    const read = agPsd.readPsd(buf.subarray(0, r.value.length), {
      skipCompositeImageData: true,
      skipLayerImageData: true,
    })
    expect(read.channels).toBe(3)
  })

  it('saved without Maximize Compatibility: the embedded thumbnail is the cover only (a low-resolution preview)', async () => {
    const i = ingest(l, 'nocomposite.psd', { mimeType: PSD })
    const m = await expectReady(i)
    expect(m.derivatives.map((d) => d.role)).toEqual(['thumb'])
    expect(m.derivatives[0]).toMatchObject({ page: 1, width: 160, height: 107 })
    expect(m.probe).toMatchObject({ pageCount: 1, width: 900, height: 600 })
  })

  it('without a composite or a thumbnail: PSD_NO_COMPOSITE', async () => {
    await expectFailed(ingest(l, 'nocomposite-nothumb.psd', { mimeType: PSD }), 'PSD_NO_COMPOSITE')
  })

  it('CMYK, 16-bit and PSB are refused from the header, without starting a child', async () => {
    for (const name of ['cmyk.psd', 'deep16.psd', 'large.psb']) {
      const i = ingest(l, name, { name: name.replace('.psb', '.psd'), mimeType: PSD })
      await expectFailed(i, 'PSD_UNSUPPORTED', { psdChildPath: CRASH })
    }
  })

  it('a header claiming 30000x30000 is refused before anything parses it', async () => {
    const head = readFileSync(fixturePath('bomb-30000x30000.psd'))
    expect(checkPsdHeader(head, PSD_LIMITS)).toMatchObject({ ok: false, reason: 'too_large' })
    const i = ingest(l, 'bomb-30000x30000.psd', { mimeType: PSD })
    const { ms } = await expectFailed(i, 'DESIGN_TOO_LARGE', { psdChildPath: CRASH })
    expect(ms).toBeLessThan(2000)
  })

  it('a layer section claiming 30000 layer records is refused before any record is parsed', async () => {
    await expectFailed(ingest(l, 'layers-30000.psd', { mimeType: PSD }), 'DESIGN_TOO_LARGE')
  })

  it('a truncated composite is a damaged file (IMAGE_INVALID), found before ag-psd reads it', async () => {
    const buf = Buffer.from(readFileSync(fixturePath('truncated.psd')))
    expect(compactPsd(buf, { ...PSD_LIMITS })).toMatchObject({ ok: false, reason: 'invalid' })
    await expectFailed(ingest(l, 'truncated.psd', { mimeType: PSD }), 'IMAGE_INVALID')
  })

  it('a PNG named .psd is sniffed as a PNG and never reaches the PSD reader (a type mismatch, still downloadable)', async () => {
    const i = ingest(l, 'really-png.psd', { mimeType: PSD })
    expect(i.meta.kind).toBe('pdf')
    await expectFailed(i, 'TYPE_MISMATCH', { psdChildPath: CRASH })
  })

  it('a child that never answers is SIGKILLed at the timeout and the job fails as TIMEOUT', async () => {
    const i = ingest(l, 'design.psd', { mimeType: PSD })
    const t0 = Date.now()
    const out = await processNext(l, { psdChildPath: HANG, psdTimeoutMs: 1500 })
    const ms = Date.now() - t0
    expect(out).toEqual({ result: 'failed', status: 'failed', code: 'TIMEOUT' })
    expect(ms).toBeGreaterThanOrEqual(1500)
    expect(ms).toBeLessThan(6000)
    const pidFile = join(versionDir(l, i.meta.assetId, i.meta.versionId), 'child.pid')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(false)
    expect(derivativeFiles(l, i)).toEqual([])
  })

  it('a child that dies without answering is retried (transient), never a preview', async () => {
    const own = tempLayout() // the retried job stays queued: keep it out of the other tests' queue
    ingest(own, 'design.psd', { mimeType: PSD })
    const out = await processNext(own, { psdChildPath: CRASH })
    expect(out).toMatchObject({ result: 'retry', status: 'queued' })
  })
})

describe('TIFF', () => {
  it.each([
    ['scan-lzw.tif'],
    ['scan-deflate.tif'],
    ['scan-jpeg.tif'],
    ['scan-packbits.tif'],
    ['scan-cmyk.tif'],
  ])('%s becomes one flattened page and the cover', async (name) => {
    const i = ingest(l, name, { mimeType: 'image/tiff' })
    expect(i.meta.kind).toBe('pdf')
    const m = await expectReady(i)
    expect(m.mimeType).toBe('image/tiff')
    expect(m.probe).toMatchObject({ pageCount: 1, width: 1600, height: 1000 })
    expect(m.derivatives.map((d) => [d.role, d.page, d.width])).toEqual([
      ['page', 1, 1600],
      ['thumb', 1, 512],
    ])
  })

  it('a multi-page TIFF: the first page is previewed and the page count is reported', async () => {
    const m = await expectReady(ingest(l, 'multipage.tif', { name: 'pages.tiff', mimeType: '' }))
    expect(m.probe.pageCount).toBe(3)
    expect(m.derivatives.filter((d) => d.role === 'page').map((d) => d.page)).toEqual([1])
  })

  it('a 300-page TIFF is over the page limit (DESIGN_TOO_LARGE)', async () => {
    await expectFailed(ingest(l, 'pages-300.tif', { mimeType: 'image/tiff' }), 'DESIGN_TOO_LARGE')
  })

  it('a 10-gigapixel TIFF with a tiny deflate strip is refused from its header (limitInputPixels)', async () => {
    const { ms } = await expectFailed(
      ingest(l, 'bomb-100000x100000.tif', { mimeType: 'image/tiff' }),
      'DESIGN_TOO_LARGE',
    )
    expect(ms).toBeLessThan(2000)
  })

  it('a truncated TIFF is a damaged file (IMAGE_INVALID)', async () => {
    await expectFailed(ingest(l, 'truncated.tif', { mimeType: 'image/tiff' }), 'IMAGE_INVALID')
  })
})

describe('Illustrator', () => {
  it('a file saved with PDF content is previewed as its artboards, through the PDF path', async () => {
    const i = ingest(l, 'artwork.ai', { mimeType: 'application/postscript' })
    expect(i.meta.kind).toBe('pdf')
    const m = await expectReady(i)
    expect(m.mimeType).toBe('application/pdf')
    expect(m.probe.pageCount).toBe(2)
    expect(m.derivatives.filter((d) => d.role === 'page').map((d) => d.page)).toEqual([1, 2])
  })

  it('a file saved without PDF content: NO_PDF_CONTENT, not a preview of Illustrator’s notice', async () => {
    await expectFailed(ingest(l, 'nopdf.ai', { mimeType: '' }), 'NO_PDF_CONTENT')
  })

  it('an old PostScript Illustrator file: POSTSCRIPT_NOT_SUPPORTED (no Ghostscript)', async () => {
    const i = ingest(l, 'legacy.ai', { mimeType: 'application/postscript' })
    await expectFailed(i, 'POSTSCRIPT_NOT_SUPPORTED')
  })

  it('an Office conversion is never checked for the notice; a PDF of several pages neither', async () => {
    // document.pdf has 4 pages: the check is for one-page documents only
    await expectReady(ingest(l, 'document.pdf', { mimeType: 'application/pdf' }))
  })
})

describe('HEIC', () => {
  it('stays an attachment: nothing decodes it, no derivatives', async () => {
    const i = ingest(l, 'photo.heic', { name: 'IMG_0001.HEIC', mimeType: 'image/heic' })
    expect(i.meta.kind).toBe('other')
    const m = await expectReady(i)
    expect(m.derivatives).toEqual([])
    expect(m.mimeType).toBe('image/heic')
  })
})
