import { readFileSync } from 'node:fs'
import { type DataLayout, LIMITS } from '@draftroom/dev-assets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { userMessage } from '../src/errors.ts'
import { lockedSharp } from '../src/image.ts'
import { confirmKind } from '../src/sniff.ts'
import { validate } from '../src/video.ts'
import {
  cleanupLayouts,
  derivativeFiles,
  ensureFixtures,
  fixturePath,
  type Ingested,
  ingest,
  jobsIn,
  metaOf,
  processNext,
  tempLayout,
} from './helpers.ts'

let l: DataLayout
beforeAll(async () => {
  await ensureFixtures()
  l = tempLayout()
})
afterAll(cleanupLayouts)

/** Runs the job and checks the invariants every permanent failure must satisfy. */
async function expectFailed(i: Ingested, code: string) {
  const t0 = Date.now()
  const out = await processNext(l)
  const ms = Date.now() - t0
  expect(out).toEqual({ result: 'failed', status: 'failed', code })
  const m = metaOf(l, i)
  expect(m.status).toBe('failed')
  expect(m.attempts).toBe(1) // permanent: no retries
  expect(m.error?.code).toBe(code)
  // User-safe: the fixed catalog text, never a path, stderr or library message.
  expect(m.error?.message).toBe(userMessage(code as Parameters<typeof userMessage>[0]))
  expect(m.error?.message).not.toMatch(/[\\/]|drw-|ffprobe|pdf\.js|vips|Exception/i)
  expect(m.derivatives).toEqual([])
  expect(derivativeFiles(l, i)).toEqual([])
  expect(jobsIn(l, 'failed')).toContain(`${i.meta.versionId}.json`)
  expect(jobsIn(l, 'processing')).toEqual([])
  return { meta: m, ms }
}

describe('images', () => {
  it('a 900 MP decompression-bomb header is rejected before decoding', async () => {
    const i = ingest(l, 'bomb-30000x30000.png', { mimeType: 'image/png' })
    const { ms } = await expectFailed(i, 'IMAGE_TOO_LARGE')
    expect(ms).toBeLessThan(2000)
  })

  it('a 144 MP header (under sharp default, over our 100 MP limit) is rejected', async () => {
    await expectFailed(ingest(l, 'bomb-12000x12000.png', { mimeType: 'image/png' }), 'IMAGE_TOO_LARGE')
  })

  it('an SVG declared as a PNG image is a type mismatch', async () => {
    await expectFailed(
      ingest(l, 'vector.svg', { name: 'vector.png', mimeType: 'image/png' }),
      'TYPE_MISMATCH',
    )
  })

  it('a PDF declared as an image is a type mismatch', async () => {
    await expectFailed(
      ingest(l, 'document.pdf', { name: 'scan.jpg', mimeType: 'image/jpeg' }),
      'TYPE_MISMATCH',
    )
  })

  it('the loader allowlist refuses SVG even if the sniff gate were bypassed, and still decodes GIF', async () => {
    const s = lockedSharp()
    await expect(s(readFileSync(fixturePath('vector.svg'))).metadata()).rejects.toThrow(
      /unsupported image format/i,
    )
    // GIF is decoded by libnsgif: unblocking the *Gif* names instead would break this.
    const gif = await s({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
      .gif()
      .toBuffer()
    expect((await s(gif).metadata()).format).toBe('gif')
  })

  it('a JPEG named .png is still an image and is recorded with its real type', async () => {
    const i = ingest(l, 'image-exif6.jpg', { name: 'photo.png', mimeType: 'image/png' })
    expect(await processNext(l)).toMatchObject({ result: 'done' })
    expect(metaOf(l, i).mimeType).toBe('image/jpeg')
  })
})

describe('pdfs', () => {
  it('a password-protected PDF fails as PDF_ENCRYPTED', async () => {
    await expectFailed(ingest(l, 'encrypted.pdf', { mimeType: 'application/pdf' }), 'PDF_ENCRYPTED')
  })

  it.each(['garbage.pdf', 'truncated.pdf', 'empty.pdf'])('%s fails as PDF_INVALID', async (f) => {
    await expectFailed(ingest(l, f, { mimeType: 'application/pdf' }), 'PDF_INVALID')
  })

  it('a PNG declared as a PDF is a type mismatch', async () => {
    await expectFailed(
      ingest(l, 'image.png', { name: 'report.pdf', mimeType: 'application/pdf' }),
      'TYPE_MISMATCH',
    )
  })

  it('a PDF above LIMITS.maxPdfPages fails as PDF_TOO_MANY_PAGES and records the count', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create({ updateMetadata: false })
    for (let n = 0; n <= LIMITS.maxPdfPages; n++) doc.addPage([100, 100])
    const i = ingest(l, null, {
      name: 'huge.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from(await doc.save()),
    })
    const { meta } = await expectFailed(i, 'PDF_TOO_MANY_PAGES')
    expect(meta.probe.pageCount).toBe(LIMITS.maxPdfPages + 1)
  })
})

describe('videos', () => {
  it('HEVC fails as UNSUPPORTED_CODEC but keeps its probe facts', async () => {
    const { meta } = await expectFailed(
      ingest(l, 'video-hevc.mp4', { mimeType: 'video/mp4' }),
      'UNSUPPORTED_CODEC',
    )
    expect(meta.probe).toMatchObject({ videoCodec: 'hevc', width: 640, height: 360 })
    expect(meta.probe.durationMs).toBeGreaterThan(900)
  })

  it('a truncated faststart MP4 (which ffprobe accepts) fails as VIDEO_INVALID', async () => {
    await expectFailed(ingest(l, 'truncated.mp4', { mimeType: 'video/mp4' }), 'VIDEO_INVALID')
  })

  it('an HLS playlist named .mp4 is a type mismatch and is never probed', async () => {
    await expectFailed(ingest(l, 'disguised.mp4', { mimeType: 'video/mp4' }), 'TYPE_MISMATCH')
  })

  it('a video in a container M0 cannot play stays downloadable (UNSUPPORTED_CODEC, not a mismatch)', () => {
    expect(() => confirmKind('video', { mime: 'video/webm', ext: 'webm' })).toThrow(/UNSUPPORTED_CODEC/)
    expect(() => confirmKind('video', { mime: 'text/plain', ext: 'txt' })).toThrow(/TYPE_MISMATCH/)
  })

  it('a probe that exceeds its time budget is killed and fails as TIMEOUT', async () => {
    const i = ingest(l, 'video.mp4', { mimeType: 'video/mp4' })
    const out = await processNext(l, { probeTimeoutMs: 1 })
    expect(out).toMatchObject({ result: 'failed', code: 'TIMEOUT' })
    expect(metaOf(l, i).error?.code).toBe('TIMEOUT')
  })
})

describe('video allowlist rules (synthetic ffprobe output)', () => {
  const good = () => ({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5', tags: { major_brand: 'isom' } },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        pix_fmt: 'yuv420p',
        width: 1920,
        height: 1080,
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ] as Record<string, unknown>[],
  })
  const code = (p: ReturnType<typeof good>) => {
    try {
      validate(p)
      return 'OK'
    } catch (e) {
      return (e as { code?: string }).code
    }
  }

  it('accepts H.264 High 4:2:0 + AAC and reports displayed dimensions', () => {
    expect(validate(good())).toMatchObject({
      durationMs: 12500,
      width: 1920,
      height: 1080,
      audioCodec: 'aac',
    })
    const rotated = good()
    rotated.streams[0] = { ...rotated.streams[0], side_data_list: [{ rotation: -90 }] }
    expect(validate(rotated)).toMatchObject({ width: 1080, height: 1920 }) // phone portrait video
  })

  it('rejects what browsers do not play everywhere', () => {
    const tenBit = good()
    tenBit.streams[0] = { ...tenBit.streams[0], pix_fmt: 'yuv420p10le' }
    const hi444 = good()
    hi444.streams[0] = { ...hi444.streams[0], profile: 'High 4:4:4 Predictive' }
    const opus = good()
    opus.streams[1] = { codec_type: 'audio', codec_name: 'opus' }
    const twoAudio = good()
    twoAudio.streams.push({ codec_type: 'audio', codec_name: 'aac' })
    const qt = good()
    qt.format.tags.major_brand = 'qt  '
    const huge = good()
    huge.streams[0] = { ...huge.streams[0], width: 7680, height: 4320 }
    for (const p of [tenBit, hi444, opus, twoAudio, qt, huge]) expect(code(p)).toBe('UNSUPPORTED_CODEC')
  })

  it('ignores cover-art streams, and enforces the duration limit', () => {
    const cover = good()
    cover.streams.push({ codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } })
    expect(code(cover)).toBe('OK')
    const long = good()
    long.format.duration = String(LIMITS.maxVideoDurationMs / 1000 + 1)
    expect(code(long)).toBe('VIDEO_TOO_LONG')
    const unknown = good()
    unknown.format.duration = 'N/A'
    expect(code(unknown)).toBe('VIDEO_INVALID')
    expect(code({ ...good(), streams: [{ codec_type: 'audio', codec_name: 'aac' }] })).toBe('VIDEO_INVALID')
  })
})
