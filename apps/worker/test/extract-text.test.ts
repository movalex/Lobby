// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): the extract-text runner and its child, against real files. The source is
// served by a local HTTP server (the presigned GET's stand-in, so transfer.ts's caps apply as in production), the ops
// api is a fake that records the `/text` batches, Office documents go through the stand-in soffice (fake-soffice.ts:
// a real PDF carrying the document's own text), and the child is the real pdf-text-child.ts with pdf.js. Files are
// untrusted: past 300 pages, a page of megabytes of text, a heap that runs out, a child that hangs or crashes, an
// encrypted or broken file, a zip bomb.

import { createReadStream, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILE_TEXT_LIMITS, WORKER_OP_LIMITS } from '@draftroom/contracts'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkerApi } from '../src/api-client.ts'
import { localOfficeConverter } from '../src/office.ts'
import type { ClaimedOp, WorkerOpsApi } from '../src/ops/client.ts'
import { OP_RUNNERS, OpFailure, type OpRunContext } from '../src/ops/dispatch.ts'
import {
  checkedPages,
  createExtractTextRunner,
  type ExtractTextOptions,
  TEXT_BATCH_BYTES,
  textBatches,
} from '../src/ops/extract-text.ts'
import { cleanPageText } from '../src/ops/pdf-text-protocol.ts'
import { ensureFixtures, fixturePath } from './helpers.ts'
import { cleanupRoots, tmpRoot } from './remote-helpers.ts'

const FAKE_SOFFICE = fileURLToPath(new URL('./children/fake-soffice.ts', import.meta.url))
const HANG_CHILD = fileURLToPath(new URL('./children/hang-child.ts', import.meta.url))
const CRASH_CHILD = fileURLToPath(new URL('./children/crash-child.ts', import.meta.url))

let server: Server
let base = ''
const served = new Map<string, string>()

beforeAll(async () => {
  await ensureFixtures()
  server = createServer((req, res) => {
    const path = served.get(req.url ?? '')
    if (!path) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-length': String(statSync(path).size) })
    createReadStream(path).pipe(res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  cleanupRoots()
})

const api = { blobRequest: (ref: { url: string }) => ({ url: ref.url, headers: {} }) } as unknown as WorkerApi

/** A fake ops api: records each `/text` batch. */
function fakeOps() {
  const batches: { page: number; body: string }[][] = []
  const ops = {
    async text(_lease: unknown, pages: { page: number; body: string }[]) {
      batches.push(pages)
    },
  } as unknown as WorkerOpsApi
  return { ops, batches, pages: () => batches.flat().filter((p) => p.body) }
}

let n = 0
/** The op of `file` (served at a fresh path) and a run context for it. */
function contextFor(
  file: string,
  over: Partial<ClaimedOp['source']> = {},
  params: Record<string, unknown> = { maxPages: 300 },
): { ctx: OpRunContext; f: ReturnType<typeof fakeOps> } {
  const path = `/blob/${++n}`
  served.set(path, file)
  const f = fakeOps()
  const op: ClaimedOp = {
    id: 'wop_0123456789abcdefghij',
    kind: 'extract-text',
    capability: 'extract-text@1',
    boardId: 'b-0123456789',
    sourceVersionId: 'ver_0123456789abcdefghij',
    params,
    attempt: 1,
    leaseMs: 120_000,
    source: {
      kind: 'pdf',
      name: 'file',
      mimeType: 'application/pdf',
      sizeBytes: statSync(file).size,
      pageCount: null,
      ...over,
    },
    original: { url: `${base}${path}`, headers: {} },
  }
  const ctx: OpRunContext = {
    op,
    lease: { opId: op.id, attempt: 1 },
    ops: f.ops,
    api,
    tmpDir: tmpRoot(),
    signal: new AbortController().signal,
    log: () => {},
  }
  return { ctx, f }
}

async function runOn(file: string, o: ExtractTextOptions = {}, over: Partial<ClaimedOp['source']> = {}) {
  const { ctx, f } = contextFor(file, over)
  const result = await createExtractTextRunner(o).run(ctx)
  return { result, f }
}

async function failureOf(p: Promise<unknown>): Promise<{ code: string; retry: boolean }> {
  try {
    await p
  } catch (e) {
    if (e instanceof OpFailure) return { code: e.code, retry: e.retry }
    throw e
  }
  throw new Error('expected an OpFailure')
}

/** A PDF of `pages` pages, each with `text(n)` in a standard font. */
async function textPdf(pages: number, text: (n: number) => string): Promise<string> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792])
    const t = text(i)
    // one line per 200 characters: pdf-lib draws what it is given, line by line
    const lines = t.match(/.{1,200}/g) ?? []
    lines.forEach((line, k) => {
      page.drawText(line, { x: 20, y: 770 - (k % 70) * 11, size: 8, font })
    })
  }
  const path = join(tmpRoot(), `text-${pages}.pdf`)
  writeFileSync(path, await doc.save({ useObjectStreams: false }))
  return path
}

const hex4 = (v: number) => v.toString(16).padStart(4, '0').toUpperCase()

/**
 * A PDF whose one page shows `text` in a CID font (Type0, Identity-H) through a ToUnicode CMap, as CJK documents do:
 * CID i+1 is the i-th character. No font program is embedded (text extraction never needs one).
 */
async function cidPdf(text: string): Promise<string> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage([612, 792])
  const ctx = doc.context
  const chars = [...text]
  const unicodeHex = (c: string) =>
    [...Buffer.from(c, 'utf16le').swap16()]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${chars.length} beginbfchar`,
    ...chars.map((c, i) => `<${hex4(i + 1)}> <${unicodeHex(c)}>`),
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
  const toUnicode = ctx.register(ctx.stream(cmap))
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'LobbyCidTest',
      Flags: 4,
      FontBBox: [0, -120, 1000, 880],
      ItalicAngle: 0,
      Ascent: 880,
      Descent: -120,
      CapHeight: 700,
      StemV: 80,
    }),
  )
  const cidFont = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'LobbyCidTest',
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 1000,
      CIDToGIDMap: 'Identity',
    }),
  )
  const font = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'LobbyCidTest',
      Encoding: 'Identity-H',
      DescendantFonts: [cidFont],
      ToUnicode: toUnicode,
    }),
  )
  page.node.setFontDictionary(PDFName.of('F1'), font)
  const codes = chars.map((_, i) => hex4(i + 1)).join('')
  page.node.addContentStream(ctx.register(ctx.stream(`BT /F1 24 Tf 72 700 Td <${codes}> Tj ET`)))
  const path = join(tmpRoot(), 'cid.pdf')
  writeFileSync(path, await doc.save({ useObjectStreams: false }))
  return path
}

describe('the runner on real files', () => {
  it('this build reports extract-text (OP_RUNNERS has its runner)', () => {
    expect(OP_RUNNERS['extract-text']?.kind).toBe('extract-text')
  })

  it('a PDF: every page, in one batch starting at page 1, and the result', async () => {
    const { result, f } = await runOn(fixturePath('document.pdf'))
    expect(f.batches).toHaveLength(1)
    expect(f.pages().map((p) => p.page)).toEqual([1, 2, 3, 4])
    expect(f.pages()[2]?.body).toContain('Page 3 of 4')
    expect(result).toEqual({
      outputs: [],
      result: {
        pages: 4,
        bytes: f.pages().reduce((s, p) => s + Buffer.byteLength(p.body), 0),
        truncated: false,
        extractor: FILE_TEXT_LIMITS.extractor,
      },
    })
  })

  it('a CJK document (a CID font with a ToUnicode map) gives its characters', async () => {
    const { f } = await runOn(await cidPdf('東京の会議 議事録'))
    expect(f.pages()).toHaveLength(1)
    expect(f.pages()[0]?.body.replace(/\s+/g, ' ')).toBe('東京の会議 議事録')
  })

  it('a Word document and a PowerPoint deck: through the converter, their own words', async () => {
    const office = localOfficeConverter({ command: [process.execPath, FAKE_SOFFICE], workRoot: tmpRoot() })
    const docx = await runOn(fixturePath('document.docx'), { office })
    expect(
      docx.f
        .pages()
        .map((p) => p.body)
        .join('\n'),
    ).toContain('Ship the review flow.')
    const pptx = await runOn(fixturePath('slides.pptx'), { office })
    expect(pptx.f.pages().length).toBeGreaterThan(0)
    expect(pptx.result.result).toMatchObject({ truncated: false })
    // without a converter (an office-less worker) it cannot be read now: tried again later
    expect(await failureOf(runOn(fixturePath('document.docx')))).toEqual({
      code: 'WORKER_UNAVAILABLE',
      retry: false,
    })
  })

  it('reads the first 300 pages of a longer file and says truncated', async () => {
    const pdf = await textPdf(305, (i) => `Page ${i} body`)
    const { result, f } = await runOn(pdf)
    expect(f.pages().map((p) => p.page)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1))
    expect(f.batches.every((b) => b.length <= WORKER_OP_LIMITS.textPagesPerCall)).toBe(true)
    expect(result.result).toMatchObject({ pages: 300, truncated: true })
  }, 60_000)

  it('a page of megabytes of text keeps 8,000 characters; a file past 512 KiB stops there', async () => {
    const huge = await textPdf(1, () => 'x'.repeat(20_000))
    const one = await runOn(huge)
    expect(one.f.pages()[0]?.body.length).toBeLessThanOrEqual(FILE_TEXT_LIMITS.maxPageChars)
    const many = await textPdf(80, (i) => `${i} ${'y'.repeat(9_000)}`)
    const r = await runOn(many)
    expect(r.result.result).toMatchObject({ truncated: true })
    expect((r.result.result as { bytes: number }).bytes).toBeLessThanOrEqual(FILE_TEXT_LIMITS.maxVersionBytes)
    // every call stays under the api's JSON body limit
    for (const b of r.f.batches)
      expect(Buffer.byteLength(JSON.stringify({ pages: b }))).toBeLessThan(256 * 1024)
  }, 60_000)

  it('a scan (no text) completes with no page: the api records it empty', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false })
    doc.addPage([612, 792])
    const path = join(tmpRoot(), 'blank.pdf')
    writeFileSync(path, await doc.save())
    const { result, f } = await runOn(path)
    expect(f.batches).toEqual([])
    expect(result.result).toMatchObject({ pages: 0, bytes: 0, truncated: false })
  })

  it('refuses what is not a readable PDF or Office document, with the code users see', async () => {
    expect((await failureOf(runOn(fixturePath('encrypted.pdf')))).code).toBe('SOURCE_UNSUPPORTED')
    // it starts like a PDF, but pdf.js cannot read it
    expect((await failureOf(runOn(fixturePath('garbage.pdf')))).code).toBe('TEXT_EXTRACT_FAILED')
    // no PDF signature at all
    const notPdf = join(tmpRoot(), 'notes.txt')
    writeFileSync(notPdf, 'plain words, not a PDF')
    expect(await failureOf(runOn(notPdf))).toEqual({ code: 'SOURCE_UNSUPPORTED', retry: false })
    expect((await failureOf(runOn(fixturePath('image.png'), {}, { kind: 'image' }))).code).toBe(
      'SOURCE_UNSUPPORTED',
    )
    // a zip bomb never reaches LibreOffice
    const office = localOfficeConverter({ command: [process.execPath, FAKE_SOFFICE], workRoot: tmpRoot() })
    expect((await failureOf(runOn(fixturePath('bomb.docx'), { office }))).code).toBe('SOURCE_UNSUPPORTED')
    // the version is gone from storage
    const { ctx } = contextFor(fixturePath('document.pdf'))
    served.delete(new URL(ctx.op.original.url).pathname)
    expect((await failureOf(createExtractTextRunner().run(ctx))).code).toBe('SOURCE_MISSING')
  })

  it('a child that hangs is killed at its timeout; one that crashes or runs out of heap fails, the worker lives', async () => {
    const pdf = fixturePath('document.pdf')
    expect(await failureOf(runOn(pdf, { childPath: HANG_CHILD, timeoutMs: 1_000 }))).toEqual({
      code: 'TIMEOUT',
      retry: false,
    })
    expect(await failureOf(runOn(pdf, { childPath: CRASH_CHILD }))).toEqual({
      code: 'TEXT_EXTRACT_FAILED',
      retry: false,
    })
    const big = await textPdf(200, (i) => `${i} ${'z'.repeat(8_000)}`)
    expect((await failureOf(runOn(big, { heapMb: 8 }))).code).toBe('TEXT_EXTRACT_FAILED')
  }, 60_000)
})

describe('the pieces', () => {
  it('textBatches: ascending, page 1 first, at most 50 pages and TEXT_BATCH_BYTES of JSON a call', () => {
    expect(textBatches([])).toEqual([])
    expect(textBatches([{ page: 3, body: 'c' }])).toEqual([
      [
        { page: 1, body: '' },
        { page: 3, body: 'c' },
      ],
    ])
    const many = Array.from({ length: 120 }, (_, i) => ({ page: i + 1, body: 'b'.repeat(10) }))
    expect(textBatches(many).map((b) => b.length)).toEqual([50, 50, 20])
    const heavy = Array.from({ length: 50 }, (_, i) => ({ page: i + 1, body: '"'.repeat(8_000) }))
    for (const b of textBatches(heavy))
      expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(TEXT_BATCH_BYTES)
  })

  it('checkedPages: the child output is checked like any input', () => {
    expect(() => checkedPages('not json', 300)).toThrow(OpFailure)
    expect(() => checkedPages('{}', 300)).toThrow(OpFailure)
    expect(() =>
      checkedPages(
        JSON.stringify([
          { page: 2, body: 'a' },
          { page: 1, body: 'b' },
        ]),
        300,
      ),
    ).toThrow(OpFailure)
    expect(() => checkedPages(JSON.stringify([{ page: 301, body: 'a' }]), 300)).toThrow(OpFailure)
    expect(
      checkedPages(
        JSON.stringify([
          { page: 1, body: '  a\u0000b  ' },
          { page: 2, body: '   ' },
        ]),
        300,
      ),
    ).toEqual({
      pages: [{ page: 1, body: 'ab' }],
      bytes: 2,
      truncated: false,
    })
  })

  it('cleanPageText: invisible and bidi characters go, lines are kept, the cap counts UTF-16 units', () => {
    const bidi = String.fromCodePoint(0x202e)
    const zw = String.fromCodePoint(0x200b)
    expect(cleanPageText(`a${bidi}b${zw}c\t d\r\n\n\n\ne`, 100)).toBe('abc d\n\ne')
    const astral = String.fromCodePoint(0x1f600).repeat(5)
    expect(cleanPageText(astral, 5)).toBe(String.fromCodePoint(0x1f600).repeat(2))
  })
})
