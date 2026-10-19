// WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6): the render-pages runner against real PDFs (pdf-lib) and the
// real pdf child, with a fake ops api and a local server standing in for the blob store (the original's GET, the
// pages' PUTs). Pages from..to come out at the previews' width as webp, a page the api already has is skipped, an
// Office deck goes through the converter, and every failure is a code users may see.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKER_CAPABILITIES } from '@draftroom/contracts'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createWorkerApi, WorkerApiError } from '../src/api-client.ts'
import { PREVIEW } from '../src/config.ts'
import type { OfficeConverter } from '../src/office.ts'
import type { ClaimedOp, OpLease, WorkerOpsApi } from '../src/ops/client.ts'
import { OP_RUNNERS, OpFailure, type OpRunContext } from '../src/ops/dispatch.ts'
import { runClaimedOp } from '../src/ops/loop.ts'
import { createRenderPagesRunner, PAGE_EXISTS, type RenderPagesDeps } from '../src/ops/render-pages.ts'
import { ensureFixtures, fixturePath } from './helpers.ts'

const HANG_CHILD = fileURLToPath(new URL('./children/hang-child.ts', import.meta.url))

/** A PDF of `pages` pages, each saying its number; page sizes alternate landscape and portrait. */
async function deckPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage(n % 2 ? [800, 450] : [450, 800])
    page.drawText(`Slide ${n}`, { x: 40, y: 200, size: 40, font })
  }
  return Buffer.from(await doc.save())
}

// ---- a blob store stand-in: GET /original, PUT /put/<n> -------------------------------------------------------------

let server: Server
let origin = ''
let original: Buffer | null = Buffer.alloc(0)
const puts = new Map<string, Buffer>()

beforeAll(async () => {
  await ensureFixtures()
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/original') {
      if (!original) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-length': String(original.length) }).end(original)
      return
    }
    if (req.method === 'PUT' && req.url?.startsWith('/put/')) {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        puts.set(req.url as string, Buffer.concat(chunks))
        res.writeHead(200).end()
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  puts.clear()
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'drw-rp-'))
  dirs.push(d)
  return d
}

interface Reservation {
  page: number
  width: number
  height: number
  bytes: number
  mimeType: string
}

/** A fake ops api: records reservations and the complete; `exists` pages are refused as the api would. */
function fakeOps(exists: readonly number[] = []) {
  const reserved: Reservation[] = []
  const completed: { outputs: string[]; result: Record<string, unknown> }[] = []
  const api: WorkerOpsApi = {
    async claim() {
      return null
    },
    async heartbeat() {
      return { leaseMs: 120_000 }
    },
    async output(_lease: OpLease, draft) {
      const page = draft.page as number
      if (exists.includes(page)) throw new WorkerApiError('rejected', 409, `HTTP 409 ${PAGE_EXISTS}`)
      reserved.push({
        page,
        width: draft.width,
        height: draft.height,
        bytes: draft.bytes,
        mimeType: draft.mimeType,
      })
      const n = reserved.length
      return {
        outputId: `wpo_out${String(n).padStart(10, '0')}`,
        upload: { url: `${origin}/put/${page}`, headers: {}, method: 'PUT' },
      }
    },
    async text() {},
    async complete(_lease, outputs, result) {
      completed.push({ outputs, result })
    },
    async fail() {},
  }
  return { api, reserved, completed }
}

const workerApi = () =>
  createWorkerApi({
    baseUrl: origin,
    token: 't'.repeat(40),
    workerId: 'test-worker',
    requestTimeoutMs: 10_000,
  })

function opOf(params: Record<string, unknown>, source: Partial<ClaimedOp['source']> = {}): ClaimedOp {
  return {
    id: 'wop_0123456789abcdefghij',
    kind: 'render-pages',
    capability: WORKER_CAPABILITIES['render-pages'],
    boardId: 'b-board0001',
    sourceVersionId: 'ver_0123456789abcdefghij',
    params,
    attempt: 1,
    leaseMs: 120_000,
    source: {
      kind: 'pdf',
      name: 'deck.pdf',
      mimeType: 'application/pdf',
      sizeBytes: original?.length ?? 0,
      pageCount: null,
      ...source,
    },
    original: { url: `${origin}/original`, headers: {} },
  }
}

async function runIt(
  params: Record<string, unknown>,
  o: { exists?: number[]; deps?: RenderPagesDeps; source?: Partial<ClaimedOp['source']> } = {},
) {
  const ops = fakeOps(o.exists)
  const runner = createRenderPagesRunner(() => o.deps ?? {})
  const ctx: OpRunContext = {
    op: opOf(params, o.source),
    lease: { opId: 'wop_0123456789abcdefghij', attempt: 1 },
    ops: ops.api,
    api: workerApi(),
    tmpDir: tmp(),
    signal: new AbortController().signal,
    log: () => {},
  }
  return { ops, out: runner.run(ctx) }
}

async function failureOf(p: Promise<unknown>): Promise<{ code: string; retry: boolean }> {
  try {
    await p
  } catch (e) {
    if (e instanceof OpFailure) return { code: e.code, retry: e.retry }
    throw e
  }
  throw new Error('the run did not fail')
}

describe('render-pages', () => {
  it('is the registered runner, reported as its capability', () => {
    expect(OP_RUNNERS['render-pages']?.kind).toBe('render-pages')
  })

  it('renders pages from..to at the previews’ width as webp, reserves and PUTs each, and reports them', async () => {
    original = await deckPdf(12)
    const { ops, out } = await runIt({ from: 9, to: 12 })
    const r = await out
    expect(r.result).toEqual({ pageCount: 12, rendered: [9, 10, 11, 12] })
    expect(r.outputs).toHaveLength(4)
    expect(ops.reserved.map((x) => x.page)).toEqual([9, 10, 11, 12])
    for (const x of ops.reserved) {
      expect(x.mimeType).toBe('image/webp')
      // portrait pages (even) are narrower than 1024 at most; landscape ones exactly the width
      if (x.page % 2) expect(x.width).toBe(PREVIEW.pdfPageWidth)
      else expect(x.width).toBeLessThanOrEqual(PREVIEW.pdfPageWidth)
      const body = puts.get(`/put/${x.page}`)
      expect(body?.length).toBe(x.bytes)
      const meta = await sharp(body as Buffer).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', x.width, x.height])
    }
  })

  it('a run past the end of the document stops at its last page', async () => {
    original = await deckPdf(10)
    const { out } = await runIt({ from: 9, to: 38 })
    expect((await out).result).toEqual({ pageCount: 10, rendered: [9, 10] })
  })

  it('skips a page the api has already (409 PAGE_EXISTS) and publishes the rest', async () => {
    original = await deckPdf(12)
    const { ops, out } = await runIt({ from: 9, to: 12 }, { exists: [10, 12] })
    const r = await out
    expect(r.result).toEqual({ pageCount: 12, rendered: [9, 11] })
    expect(ops.reserved.map((x) => x.page)).toEqual([9, 11])
    expect([...puts.keys()].sort()).toEqual(['/put/11', '/put/9'])
  })

  it('an Office deck is converted with the previews’ converter, inside the op’s own directory', async () => {
    const { readFileSync } = await import('node:fs')
    original = readFileSync(fixturePath('slides.pptx'))
    const seen: string[] = []
    const office: OfficeConverter = {
      describe: 'test converter',
      async convert(_input, format, outDir) {
        seen.push(format.mime)
        const pdf = join(outDir, 'converted.pdf')
        writeFileSync(pdf, await deckPdf(11))
        return pdf
      },
    }
    const { out } = await runIt({ from: 9, to: 38 }, { deps: { office } })
    expect((await out).result).toEqual({ pageCount: 11, rendered: [9, 10, 11] })
    expect(seen).toEqual(['application/vnd.openxmlformats-officedocument.presentationml.presentation'])
    // without a converter (Office previews off on this worker): not available now, nothing published
    const off = await runIt({ from: 9, to: 38 })
    expect(await failureOf(off.out)).toEqual({ code: 'WORKER_UNAVAILABLE', retry: false })
    expect(off.ops.reserved).toEqual([])
    // a text document is not a deck
    original = readFileSync(fixturePath('document.docx'))
    const docx = await runIt({ from: 9, to: 38 }, { deps: { office } })
    expect(await failureOf(docx.out)).toEqual({ code: 'SOURCE_UNSUPPORTED', retry: false })
  })

  it('what is not a deck, or is gone, or breaks, fails with a code users may see', async () => {
    const { readFileSync } = await import('node:fs')
    original = readFileSync(fixturePath('image.png'))
    expect(await failureOf((await runIt({ from: 9, to: 12 })).out)).toEqual({
      code: 'SOURCE_UNSUPPORTED',
      retry: false,
    })
    original = readFileSync(fixturePath('garbage.pdf'))
    expect(await failureOf((await runIt({ from: 9, to: 12 })).out)).toEqual({
      code: 'RENDER_PAGES_FAILED',
      retry: false,
    })
    original = readFileSync(fixturePath('encrypted.pdf'))
    expect((await failureOf((await runIt({ from: 9, to: 12 })).out)).code).toMatch(
      /^(SOURCE_UNSUPPORTED|RENDER_PAGES_FAILED)$/,
    )
    original = await deckPdf(12)
    expect(await failureOf((await runIt({ from: 9, to: 12 }, { source: { kind: 'image' } })).out)).toEqual({
      code: 'SOURCE_UNSUPPORTED',
      retry: false,
    })
    expect(await failureOf((await runIt({ from: 9, to: 99 })).out)).toEqual({
      code: 'INTERNAL',
      retry: false,
    })
    const size = original.length
    original = null
    expect(await failureOf((await runIt({ from: 9, to: 12 }, { source: { sizeBytes: size } })).out)).toEqual({
      code: 'SOURCE_MISSING',
      retry: false,
    })
  })

  it('a child stuck past its budget is killed: TIMEOUT', async () => {
    original = await deckPdf(12)
    const { out } = await runIt(
      { from: 9, to: 12 },
      { deps: { pdfChildPath: HANG_CHILD, pdfTimeoutMs: 1_500 } },
    )
    expect(await failureOf(out)).toEqual({ code: 'TIMEOUT', retry: false })
  }, 20_000)

  it('through the op loop: the run completes with its outputs and result', async () => {
    original = await deckPdf(9)
    const ops = fakeOps()
    const dir = tmp()
    mkdirSync(join(dir, 'ops'), { recursive: true })
    const outcome = await runClaimedOp(opOf({ from: 9, to: 9 }), {
      ops: ops.api,
      api: workerApi(),
      capabilities: [WORKER_CAPABILITIES['render-pages']],
      runners: { 'render-pages': createRenderPagesRunner() },
      tmpDir: join(dir, 'ops'),
      signal: new AbortController().signal,
      log: () => {},
    })
    expect(outcome).toEqual({ kind: 'done', opId: 'wop_0123456789abcdefghij' })
    expect(ops.completed).toEqual([
      { outputs: ['wpo_out0000000001'], result: { pageCount: 9, rendered: [9] } },
    ])
  })
})
