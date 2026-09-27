import { type DataLayout, LIMITS } from '@draftroom/dev-assets'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lockedSharp } from '../src/image.ts'
import {
  cleanupLayouts,
  derivativeBytes,
  derivativeFiles,
  ensureFixtures,
  fixturePath,
  ingest,
  jobsIn,
  metaOf,
  processNext,
  tempLayout,
} from './helpers.ts'

/** Mean absolute difference per channel (0..255) between two images resized to the same box. */
async function meanDiff(a: Buffer, b: Buffer, w: number, h: number) {
  const raw = (x: Buffer) =>
    lockedSharp()(x).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: false })
  const [ra, rb] = await Promise.all([raw(a), raw(b)])
  let sum = 0
  for (let i = 0; i < ra.length; i++) sum += Math.abs((ra[i] ?? 0) - (rb[i] ?? 0))
  return sum / ra.length
}

let l: DataLayout
beforeAll(async () => {
  await ensureFixtures()
  l = tempLayout()
})
afterAll(cleanupLayouts)

describe('image', () => {
  it('PNG becomes ready with a 512 thumb and a 2048 display WebP', async () => {
    const i = ingest(l, 'image.png', { mimeType: 'image/png' })
    expect(i.meta.kind).toBe('image')
    const out = await processNext(l)
    expect(out).toMatchObject({ result: 'done', status: 'ready' })
    const m = metaOf(l, i)
    expect(m.status).toBe('ready')
    expect(m.error).toBeNull()
    expect(m.attempts).toBe(1)
    expect(m.mimeType).toBe('image/png')
    expect(m.probe).toMatchObject({ width: 1920, height: 1080, pageCount: null, durationMs: null })
    const byRole = Object.fromEntries(m.derivatives.map((d) => [d.role, d]))
    expect(Object.keys(byRole).sort()).toEqual(['display', 'thumb'])
    expect(byRole.thumb).toMatchObject({ width: 512, height: 288, mimeType: 'image/webp', page: null })
    expect(byRole.display).toMatchObject({ width: 1920, height: 1080, mimeType: 'image/webp' })
    // Files exist under the recorded names, really are WebP of the recorded size, and nothing else is left.
    expect(derivativeFiles(l, i)).toEqual(m.derivatives.map((d) => d.file).sort())
    for (const d of m.derivatives) {
      expect(d.id).toMatch(/^drv_[0-9A-Za-z]{20}$/)
      expect(d.file).toBe(`${d.id}.webp`)
      const bytes = derivativeBytes(l, i, d.file)
      expect(bytes.length).toBe(d.bytes)
      const dm = await sharp(bytes).metadata()
      expect([dm.format, dm.width, dm.height]).toEqual(['webp', d.width, d.height])
    }
    expect(jobsIn(l, 'done')).toContain(`${i.meta.versionId}.json`)
    expect(jobsIn(l, 'processing')).toEqual([])
  })

  it('EXIF-rotated JPEG is auto-oriented and its derivatives carry no EXIF', async () => {
    const i = ingest(l, 'image-exif6.jpg', { mimeType: 'image/jpeg' })
    const src = await sharp(fixturePath('image-exif6.jpg')).metadata()
    expect(src.exif).toBeDefined() // the fixture really has EXIF (orientation 6)
    expect(src.orientation).toBe(6)
    expect(await processNext(l)).toMatchObject({ result: 'done' })
    const m = metaOf(l, i)
    expect(m.probe).toMatchObject({ width: 1080, height: 1920 })
    const thumb = m.derivatives.find((d) => d.role === 'thumb')
    const display = m.derivatives.find((d) => d.role === 'display')
    expect(thumb).toMatchObject({ width: 288, height: 512 })
    expect(display).toMatchObject({ width: 1080, height: 1920 })
    if (!thumb || !display) throw new Error('missing derivatives')
    for (const d of [thumb, display]) {
      const dm = await sharp(derivativeBytes(l, i, d.file)).metadata()
      expect(dm.exif).toBeUndefined()
      expect(dm.orientation).toBeUndefined()
    }
    // Pixels, not just dimensions: the display matches the source rotated 90° clockwise and not
    // the unrotated source squeezed into a portrait box.
    const png = derivativeBytes(l, i, display.file)
    const rotated = await lockedSharp()(fixturePath('image.png')).rotate(90).png().toBuffer()
    const unrotated = await lockedSharp()(fixturePath('image.png')).png().toBuffer()
    const good = await meanDiff(png, rotated, 108, 192)
    const bad = await meanDiff(png, unrotated, 108, 192)
    expect(good).toBeLessThan(12)
    expect(bad).toBeGreaterThan(good * 3)
  })
})

describe('pdf', () => {
  it('4-page PDF becomes ready with page 1..4 derivatives and a cover thumb', async () => {
    const i = ingest(l, 'document.pdf', { mimeType: 'application/pdf' })
    const out = await processNext(l)
    expect(out).toMatchObject({ result: 'done', status: 'ready' })
    const m = metaOf(l, i)
    expect(m.probe.pageCount).toBe(4)
    expect(m.mimeType).toBe('application/pdf')
    const pages = m.derivatives.filter((d) => d.role === 'page').sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4])
    expect(4).toBeLessThanOrEqual(LIMITS.eagerPdfPages)
    for (const p of pages) expect(p).toMatchObject({ width: 1024, height: 1326, mimeType: 'image/webp' })
    const thumbs = m.derivatives.filter((d) => d.role === 'thumb')
    expect(thumbs).toHaveLength(1)
    expect(thumbs[0]).toMatchObject({ page: 1, width: 395, height: 512 }) // longest edge <= 512
    expect(derivativeFiles(l, i)).toEqual(m.derivatives.map((d) => d.file).sort()) // temp dir removed
    // Each page is a real, distinct rendering with dark text pixels in the middle band.
    const raws = await Promise.all(
      pages.map((p) =>
        lockedSharp()(derivativeBytes(l, i, p.file))
          .greyscale()
          .raw()
          .toBuffer(),
      ),
    )
    expect(new Set(raws.map((r) => r.toString('base64'))).size).toBe(4)
    for (const r of raws) {
      const mid = r.subarray(1024 * 600, 1024 * 720)
      expect(Math.min(...mid)).toBeLessThan(60)
    }
  })

  it('renders at most LIMITS.eagerPdfPages pages of a longer document', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create({ updateMetadata: false })
    for (let n = 0; n < LIMITS.eagerPdfPages + 3; n++) doc.addPage([300, 300])
    const i = ingest(l, null, {
      name: 'long.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from(await doc.save()),
    })
    expect(await processNext(l)).toMatchObject({ result: 'done' })
    const m = metaOf(l, i)
    expect(m.probe.pageCount).toBe(LIMITS.eagerPdfPages + 3)
    const pages = m.derivatives.filter((d) => d.role === 'page').map((d) => d.page)
    expect(pages.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: LIMITS.eagerPdfPages }, (_, k) => k + 1),
    )
  })
})

describe('video', () => {
  it('H.264/AAC MP4 becomes ready with probe facts, a poster and a thumb', async () => {
    const i = ingest(l, 'video.mp4', { mimeType: 'video/mp4' })
    expect(await processNext(l)).toMatchObject({ result: 'done', status: 'ready' })
    const m = metaOf(l, i)
    expect(m.probe.durationMs).toBeGreaterThanOrEqual(4900)
    expect(m.probe.durationMs).toBeLessThanOrEqual(5100)
    expect(m.probe).toMatchObject({
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      audioCodec: 'aac',
      pageCount: null,
    })
    expect(m.mimeType).toBe('video/mp4')
    const poster = m.derivatives.find((d) => d.role === 'poster')
    const thumb = m.derivatives.find((d) => d.role === 'thumb')
    expect(poster).toMatchObject({ width: 1280, height: 720, mimeType: 'image/webp' })
    expect(thumb).toMatchObject({ width: 512, height: 288, mimeType: 'image/webp' })
    expect(m.derivatives).toHaveLength(2)
    if (!poster) throw new Error('no poster')
    const pm = await sharp(derivativeBytes(l, i, poster.file)).stats()
    expect(pm.isOpaque).toBe(true)
    expect(Math.max(...pm.channels.map((c) => c.stdev))).toBeGreaterThan(10) // a real frame, not a flat fill
  })

  it('H.264 without an audio track is accepted', async () => {
    const i = ingest(l, 'video-noaudio.mp4', { mimeType: 'video/mp4' })
    expect(await processNext(l)).toMatchObject({ result: 'done' })
    expect(metaOf(l, i).probe).toMatchObject({
      width: 640,
      height: 360,
      videoCodec: 'h264',
      audioCodec: null,
    })
  })
})

describe('other', () => {
  it('an attachment becomes ready with no derivatives and keeps its declared type', async () => {
    const i = ingest(l, 'notes.zip', { mimeType: 'application/zip' })
    expect(i.meta.kind).toBe('other')
    expect(await processNext(l)).toMatchObject({ result: 'done', status: 'ready' })
    const m = metaOf(l, i)
    expect(m).toMatchObject({ status: 'ready', derivatives: [], error: null, mimeType: 'application/zip' })
    expect(derivativeFiles(l, i)).toEqual([])
  })

  it('an SVG upload is an attachment and is never rasterized', async () => {
    const i = ingest(l, 'vector.svg', { mimeType: 'image/svg+xml' })
    expect(i.meta.kind).toBe('other')
    expect(await processNext(l)).toMatchObject({ result: 'done' })
    expect(metaOf(l, i).derivatives).toEqual([])
  })
})
