// Generates the preview fixtures (milestone 0, plus the wave-4 Office documents built by
// office-fixtures.ts) into <repo>/tests/fixtures/generated/ (gitignored).
//   pnpm fixtures            create missing fixtures, print the manifest
//   pnpm fixtures --force    regenerate everything
// All content is synthetic and non-sensitive. Output is reproducible on one toolchain (ffmpeg
// bitexact flags, pdf-lib without dates) except encrypted.pdf, whose salts are random; another
// ffmpeg/x264 build gives different bytes, so tests assert probed properties, never hashes.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { StandardFonts as EncryptingFonts, PDFDocument as EncryptingPDFDocument } from '@cantoo/pdf-lib'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { run, stderrTail } from '../src/run.ts'
import * as office from './office-fixtures.ts'

export const FIXTURES_DIR = fileURLToPath(new URL('../../../tests/fixtures/generated/', import.meta.url))
export const fixturePath = (name: string) => join(FIXTURES_DIR, name)

export interface FixtureRecord {
  name: string
  bytes: number
  sha256: string
  ms: number
  status: 'created' | 'skipped'
  description: string
}

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg'

async function ffmpeg(args: string[]) {
  const r = await run(FFMPEG(), ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args], {
    timeoutMs: 120_000,
    maxStdoutBytes: 1024 * 1024,
  })
  if (r.spawnError) throw new Error(`ffmpeg could not start (${r.spawnError}); install it or set FFMPEG_PATH`)
  if (r.code !== 0)
    throw new Error(`ffmpeg failed (code ${r.code}, timedOut ${r.timedOut}): ${stderrTail(r.stderr, 4)}`)
}

// ---- builders --------------------------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/** A tiny, valid-looking PNG whose IHDR claims width x height (decompression-bomb header). */
function bombPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(1 + width * 3))), // one scanline only
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function documentPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false }) // no Producer/dates: reproducible bytes
  const bold = await doc.embedFont(StandardFonts.HelveticaBold) // standard-14 font, not embedded
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const colors = [rgb(0.23, 0.51, 0.96), rgb(0.06, 0.73, 0.51), rgb(0.96, 0.62, 0.04), rgb(0.93, 0.27, 0.27)]
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([612, 792]) // US Letter in points
    const { width, height } = page.getSize()
    page.drawRectangle({ x: 0, y: height - 120, width, height: 120, color: colors[(i - 1) % colors.length] })
    page.drawText('Draftroom fixture PDF', {
      x: 48,
      y: height - 75,
      size: 28,
      font: bold,
      color: rgb(1, 1, 1),
    })
    const label = `Page ${i} of ${pageCount}`
    const w = bold.widthOfTextAtSize(label, 72)
    page.drawText(label, {
      x: (width - w) / 2,
      y: height / 2 - 36,
      size: 72,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    })
    page.drawText(`Generated test document. Non-sensitive. Page number ${i}.`, {
      x: 48,
      y: 96,
      size: 14,
      font: regular,
      color: rgb(0.3, 0.3, 0.3),
    })
  }
  return Buffer.from(await doc.save())
}

async function encryptedPdf(): Promise<Buffer> {
  const doc = await EncryptingPDFDocument.create()
  const font = await doc.embedFont(EncryptingFonts.Helvetica)
  doc.addPage([612, 792]).drawText('Encrypted fixture', { x: 72, y: 700, size: 24, font })
  // Default is AES-256 (V5/R6). The user password makes it unopenable without prompting.
  doc.encrypt({ userPassword: 'fixture-user-pw', ownerPassword: 'fixture-owner-pw' })
  return Buffer.from(await doc.save())
}

/** Minimal ZIP (method 0 = stored), fixed 1980-01-01 timestamp so the bytes are reproducible. */
function storedZip(files: { name: string; data: Buffer }[]): Buffer {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const crc = zlib.crc32(f.data) >>> 0
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0, 6) // flags
    lh.writeUInt16LE(0, 8) // stored
    lh.writeUInt16LE(0, 10) // time
    lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(f.data.length, 18)
    lh.writeUInt32LE(f.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4) // made by
    ch.writeUInt16LE(20, 6) // needed
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(DOS_DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(f.data.length, 20)
    ch.writeUInt32LE(f.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    locals.push(lh, name, f.data)
    centrals.push(ch, name)
    offset += lh.length + name.length + f.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

// ---- fixture table -----------------------------------------------------------------------------------

interface Spec {
  name: string
  description: string
  /** Produce the bytes, or write the file at `out` (ffmpeg) and return undefined. */
  make: (out: string) => Promise<Buffer | undefined>
}

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30']
const BITEXACT = [
  '-map_metadata',
  '-1',
  '-fflags',
  '+bitexact',
  '-flags:v',
  '+bitexact',
  '-flags:a',
  '+bitexact',
]

const SPECS: Spec[] = [
  {
    name: 'image.png',
    description: '1920x1080 PNG (ffmpeg testsrc2 frame 0)',
    make: async (out) => {
      await ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1920x1080:rate=1',
        '-frames:v',
        '1',
        '-fflags',
        '+bitexact',
        '-flags',
        '+bitexact',
        out,
      ])
      return undefined
    },
  },
  {
    name: 'image-exif6.jpg',
    description: 'image.png as JPEG stored 1920x1080 with EXIF Orientation=6 (displays 1080x1920)',
    make: async () =>
      sharp(await readFile(fixturePath('image.png')))
        .jpeg({ quality: 85 })
        .withMetadata({ orientation: 6 })
        .toBuffer(),
  },
  { name: 'document.pdf', description: '4-page US Letter PDF, "Page N of 4"', make: () => documentPdf(4) },
  {
    name: 'video.mp4',
    description: '5 s 1280x720@30 H.264 High yuv420p + AAC-LC 48 kHz stereo, faststart',
    make: async (out) => {
      await ffmpeg([
        ...['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'],
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
        ...['-t', '5', '-map', '0:v', '-map', '1:a', ...X264, '-profile:v', 'high'],
        ...['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', ...BITEXACT],
        out,
      ])
      return undefined
    },
  },
  {
    name: 'video-noaudio.mp4',
    description: '1 s 640x360 H.264 Main, no audio track, faststart',
    make: async (out) => {
      await ffmpeg([
        ...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1', ...X264, '-profile:v', 'main'],
        ...['-an', '-movflags', '+faststart', ...BITEXACT],
        out,
      ])
      return undefined
    },
  },
  // ---- negative fixtures ----
  {
    name: 'bomb-30000x30000.png',
    description: '167-byte PNG claiming 900 MP (above sharp default and our limit)',
    make: async () => bombPng(30000, 30000),
  },
  {
    name: 'bomb-12000x12000.png',
    description: 'PNG claiming 144 MP (below sharp default 268 MP, above our 100 MP limit)',
    make: async () => bombPng(12000, 12000),
  },
  {
    name: 'vector.svg',
    description: 'SVG (never rasterized in M0)',
    make: async () =>
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>\n',
      ),
  },
  { name: 'encrypted.pdf', description: 'AES-256 PDF with a user password', make: encryptedPdf },
  {
    name: 'garbage.pdf',
    description: '%PDF-1.7 header followed by junk',
    make: async () => Buffer.from(`%PDF-1.7\n${'this is not really a pdf\n'.repeat(40)}`),
  },
  { name: 'empty.pdf', description: 'zero bytes', make: async () => Buffer.alloc(0) },
  {
    name: 'truncated.pdf',
    description: 'first 60% of document.pdf',
    make: async () => {
      const pdf = await readFile(fixturePath('document.pdf'))
      return pdf.subarray(0, Math.floor(pdf.length * 0.6))
    },
  },
  {
    name: 'truncated.mp4',
    description: 'first 30% of video.mp4 (still passes ffprobe and poster extraction)',
    make: async () => {
      const mp4 = await readFile(fixturePath('video.mp4'))
      return mp4.subarray(0, Math.floor(mp4.length * 0.3))
    },
  },
  {
    name: 'video-hevc.mp4',
    description: '1 s 640x360 HEVC (hvc1) MP4: valid, but outside the playback allowlist',
    make: async (out) => {
      await ffmpeg([
        ...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '1'],
        ...['-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'],
        ...['-movflags', '+faststart', ...BITEXACT],
        out,
      ])
      return undefined
    },
  },
  {
    name: 'disguised.mp4',
    description: 'HLS playlist text named .mp4 (format confusion / SSRF vector; the URL is never fetched)',
    make: async () =>
      Buffer.from(
        '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttp://127.0.0.1:9/never-fetched.ts\n#EXT-X-ENDLIST\n',
      ),
  },
  {
    name: 'notes.zip',
    description: 'stored ZIP with one text file (attachment card, never expanded)',
    make: async () =>
      storedZip([
        { name: 'notes.txt', data: Buffer.from('Draftroom fixture attachment. Synthetic, non-sensitive.\n') },
      ]),
  },
  // ---- Office documents (wave 4; built in office-fixtures.ts) ----
  {
    name: 'document.docx',
    description: '3-page Word document (US Letter, Calibri)',
    make: async () => office.docx(),
  },
  {
    name: 'slides.pptx',
    description: '3-slide 16:9 PowerPoint deck (Arial)',
    make: async () => office.pptx(),
  },
  {
    name: 'sheet.xlsx',
    description: 'Excel workbook: a budget with SUM formulas + a notes sheet',
    make: async () => office.xlsx(),
  },
  { name: 'document.odt', description: '3-page OpenDocument text', make: async () => office.odt() },
  { name: 'slides.odp', description: '3-slide OpenDocument presentation', make: async () => office.odp() },
  { name: 'sheet.ods', description: 'one-sheet OpenDocument spreadsheet', make: async () => office.ods() },
  {
    name: 'truncated.docx',
    description: 'first 60% of document.docx (no central directory)',
    make: async () => {
      const b = await readFile(fixturePath('document.docx'))
      return b.subarray(0, Math.floor(b.length * 0.6))
    },
  },
  {
    name: 'broken.docx',
    description: 'valid package whose word/document.xml is garbage',
    make: async () => office.brokenDocx(),
  },
  {
    name: 'macro.docx',
    description: 'macro-enabled package (.docm content) under a .docx name',
    make: async () => office.macroDocx(),
  },
  {
    name: 'encrypted.docx',
    description: 'MS-CFB with EncryptionInfo + EncryptedPackage (password-protected OOXML)',
    make: async () => office.encryptedOoxml(),
  },
  {
    name: 'encrypted.odt',
    description: 'ODT whose manifest lists encryption-data (password-protected)',
    make: async () => office.encryptedOdt(),
  },
  {
    name: 'bomb.docx',
    description: 'zip bomb: word/document.xml inflates to 1120 MiB',
    make: () => office.bombDocx(),
  },
]

export const FIXTURE_NAMES = SPECS.map((s) => s.name)

// ---- generation ------------------------------------------------------------------------------------

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Several test files may ask for fixtures at once; a lock directory serializes generation. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = join(FIXTURES_DIR, '.lock')
  const deadline = Date.now() + 5 * 60_000
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const age = Date.now() - (statSafeMs(lock) ?? Date.now())
      if (age > 3 * 60_000) await rm(lock, { recursive: true, force: true }) // a generator crashed
      if (Date.now() > deadline) throw new Error('timed out waiting for the fixtures lock')
      await sleep(100)
    }
  }
  try {
    return await fn()
  } finally {
    await rmdir(lock).catch(() => {})
  }
}

function statSafeMs(p: string): number | null {
  try {
    return statSync(p).mtimeMs
  } catch {
    return null
  }
}

export async function ensureFixtures(opts: { force?: boolean } = {}): Promise<FixtureRecord[]> {
  await mkdir(FIXTURES_DIR, { recursive: true })
  return withLock(async () => {
    const records: FixtureRecord[] = []
    for (const spec of SPECS) {
      const out = fixturePath(spec.name)
      const t0 = performance.now()
      let status: FixtureRecord['status'] = 'skipped'
      if (opts.force || !existsSync(out)) {
        // Write under a temporary name (same extension, so ffmpeg picks the muxer) and rename, so
        // a reader never sees a half-written fixture.
        const tmp = fixturePath(`.tmp-${process.pid}-${randomBytes(3).toString('hex')}-${spec.name}`)
        try {
          const bytes = await spec.make(tmp)
          if (bytes) await writeFile(tmp, bytes)
          await rename(tmp, out)
        } finally {
          await rm(tmp, { force: true })
        }
        status = 'created'
      }
      const buf = await readFile(out)
      records.push({
        name: spec.name,
        bytes: buf.length,
        sha256: sha256(buf).slice(0, 16),
        ms: Math.round(performance.now() - t0),
        status,
        description: spec.description,
      })
    }
    await writeFile(fixturePath('manifest.json'), `${JSON.stringify(records, null, 2)}\n`)
    return records
  })
}

if (import.meta.main) {
  const t0 = performance.now()
  const records = await ensureFixtures({ force: process.argv.includes('--force') })
  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  console.log(`fixtures: ${FIXTURES_DIR}`)
  console.log(
    `${pad('name', 22)}${pad('status', 9)}${pad('bytes', 11)}${pad('ms', 7)}${pad('sha256', 18)}description`,
  )
  for (const r of records) {
    console.log(
      `${pad(r.name, 22)}${pad(r.status, 9)}${pad(r.bytes, 11)}${pad(r.ms, 7)}${pad(r.sha256, 18)}${r.description}`,
    )
  }
  console.log(`total ${Math.round(performance.now() - t0)} ms; manifest.json written`)
}
