// Wave N.1 (review findings 2 and 3): a vector PDF export always ends, with a file or a clear cancel.
//  - The vector pages' fonts are subset when the file is written (doc.save → the fork's serializeFont → fontkit's
//    encodeStream, whose encode runs in a later tick): a throw there, or a stream that never ends, makes finish()
//    reject within its bound in both builders (the PDF worker's, and the no-worker one on the page), and the export
//    makes the document again with image pages.
//  - Cancel stops a vector page the PDF worker is busy with: the worker is terminated and the export rejects with
//    ExportCancelled at once. A vector page past its time limit is an image page (the document is made again).
import * as pdfLibFontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { servedFontFile } from '../../canvas/export/test-fixtures.ts'
import { createPdfBuilder, type PdfBuilder } from './pdf-build.ts'
import { createPdfBuilderOffThread } from './pdf-client.ts'
import type { PdfWorkerRequest, PdfWorkerResponse } from './pdf-protocol.ts'
import { ExportCancelled, type PdfPageSpec, renderPdf } from './ported/exporter.ts'
import { adaptFontkit, type Fontkit } from './vector/fontkit.ts'

// the font engine the builders load (vector/fontkit.ts loadFontkit), switchable per test; and Lobby's served font
// files for the deps (the browser's fetch has no same-origin page in Node)
const engine = vi.hoisted(() => ({ fontkit: null as unknown }))
vi.mock('./vector/fontkit.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vector/fontkit.ts')>()
  return { ...actual, loadFontkit: async () => (engine.fontkit as Fontkit | null) ?? actual.loadFontkit() }
})
vi.mock('./vector/worker-deps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vector/worker-deps.ts')>()
  return { ...actual, browserVectorDeps: () => ({ fetchFace: async (url: string) => servedFontFile(url) }) }
})

afterEach(() => {
  engine.fontkit = null
  vi.unstubAllGlobals()
})

interface RawSubset {
  encode?(stream: unknown): unknown
  encodeStream(): unknown
}
interface RawFont {
  createSubset(): RawSubset
}
const raw = pdfLibFontkit as unknown as {
  default?: { create(b: Uint8Array, n?: string): RawFont }
  create(b: Uint8Array, n?: string): RawFont
}
const rawEngine = raw.default ?? raw

/**
 * @pdf-lib/fontkit (through Lobby's adapter) with its subsets broken the way a glyph the woff2 adapter cannot write
 * breaks them: the encode throws (in fontkit's later tick), or the stream never ends.
 */
function brokenFontkit(how: 'throws' | 'never ends'): Fontkit {
  return adaptFontkit({
    create(buffer: Uint8Array, name?: string) {
      const font = rawEngine.create(buffer, name)
      const own = font.createSubset.bind(font)
      font.createSubset = () => {
        const subset = own()
        if (how === 'throws')
          subset.encode = () => {
            throw new Error('a glyph that cannot be written')
          }
        else
          subset.encodeStream = () => ({
            on() {
              return this
            },
          })
        return subset
      }
      return font
    },
  })
}

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

const EXCALIFONT = {
  family: 'Excalifont',
  url: '/excalidraw-assets/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2',
  unicodeRange: 'U+20-7E',
  weight: '400',
  style: 'normal',
}
/** A 400×300 frame with a line of Excalifont text (its font is subset when the file is written). */
const SVG =
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">' +
  `<defs><metadata id="lobby-pdf-faces">${JSON.stringify({ v: 1, faces: [EXCALIFONT] })}</metadata></defs>` +
  '<rect x="0" y="0" width="400" height="300" fill="#ffffff"></rect><g transform="translate(20 20)">' +
  '<text x="0" y="20" font-family="Excalifont, Xiaolai, sans-serif, Segoe UI Emoji" font-size="20px" ' +
  'fill="#1e1e1e" style="white-space: pre;">Kickoff</text></g></svg>'

const vectorPage = { title: 'One', widthPx: 400, heightPx: 300, svg: SVG }

/** The board as renderPdf reads it: frames of 400×300, their SVG, and a 1×1 PNG for an image page. */
const canvas = {
  items: () => [],
  isHidden: () => false,
  bounds: () => ({ x: 0, y: 0, width: 400, height: 300 }),
  boundsOf: () => ({ x: 0, y: 0, width: 400, height: 300 }),
  visibleBounds: () => null,
  export: {
    svg: async () => SVG,
    canvas: async () => ({
      width: 400,
      height: 300,
      toBlob: (done: (b: Blob | null) => void) => done(new Blob([PNG as BlobPart], { type: 'image/png' })),
    }),
  },
} as unknown as LobbyCanvas

const frames = (n: number): PdfPageSpec[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'frame',
    title: `Frame ${i + 1}`,
    frame: { id: `f${i + 1}` } as Extract<PdfPageSpec, { kind: 'frame' }>['frame'],
  }))

/** Rejects (with its error) or resolves within `ms`, else 'still waiting'. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([p, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))])
}

describe('finding 2: the font subsetting at save time cannot hang or lose the export', () => {
  it('the worker’s builder: a subset encode that throws in fontkit’s later tick makes finish() reject', async () => {
    const b = await createPdfBuilder({
      title: 'T',
      vector: { fontkit: brokenFontkit('throws'), deps: deps() },
    })
    expect(await b.addVectorPage(vectorPage)).toEqual({ vector: true })
    const done = within(
      b.finish().then(
        () => 'finished',
        (e: Error) => e.message,
      ),
      2000,
    )
    expect(await done).toBe('a glyph that cannot be written')
  })

  it('the worker’s builder: a font stream that never ends makes finish() reject within its bound', async () => {
    const b = await createPdfBuilder({
      title: 'T',
      vector: { fontkit: brokenFontkit('never ends'), deps: deps() },
      finishMs: 200,
    })
    expect(await b.addVectorPage(vectorPage)).toEqual({ vector: true })
    await expect(within(b.finish(), 2000)).rejects.toThrow('the PDF could not be written in time')
  })

  it('the no-worker builder (on the page): finish() rejects within its bound too', async () => {
    expect(typeof (globalThis as { Worker?: unknown }).Worker).toBe('undefined')
    engine.fontkit = brokenFontkit('never ends')
    const b = await createPdfBuilderOffThread({ title: 'T', limits: { finishMs: 200 } })
    expect(b.offThread).toBe(false)
    expect(await b.addVectorPage(vectorPage)).toEqual({ vector: true })
    await expect(within(b.finish(), 2000)).rejects.toThrow(/took too long|could not be written in time/)
  })

  it('the export makes the document again with image pages, and says which', async () => {
    engine.fontkit = brokenFontkit('throws')
    const result = await within(
      renderPdf(canvas, frames(2), { title: 'Board', lossless: true, pagesKind: 'vector' }),
      10_000,
    )
    if (result === 'still waiting') throw new Error('the export did not end')
    expect(result.imagePages).toEqual([
      { page: 1, reason: 'the vector PDF could not be finished' },
      { page: 2, reason: 'the vector PDF could not be finished' },
    ])
    const doc = await PDFDocument.load(new Uint8Array(await result.blob.arrayBuffer()))
    expect(doc.getPageCount()).toBe(2)
  })
})

function deps() {
  return { fetchFace: async (url: string) => servedFontFile(url) }
}

/** A PDF worker that answers everything but a vector page (it is stuck in one). */
class StuckWorker {
  static made: StuckWorker[] = []
  readonly posted: PdfWorkerRequest['type'][] = []
  terminated = false
  private pages = 0
  private readonly listeners: ((e: { data: PdfWorkerResponse }) => void)[] = []
  constructor() {
    StuckWorker.made.push(this)
  }
  addEventListener(type: string, fn: (e: { data: PdfWorkerResponse }) => void) {
    if (type === 'message') this.listeners.push(fn)
  }
  postMessage(msg: PdfWorkerRequest) {
    this.posted.push(msg.type)
    const answer = (data: PdfWorkerResponse) =>
      setTimeout(() => {
        if (this.terminated) return
        for (const fn of this.listeners) fn({ data })
      }, 1)
    if (msg.type === 'start') answer({ id: msg.id, type: 'ok', pageCount: 0 })
    else if (msg.type === 'page') answer({ id: msg.id, type: 'ok', pageCount: ++this.pages })
    else if (msg.type === 'finish') answer({ id: msg.id, type: 'done', bytes: new Uint8Array([0x25, 0x50]) })
    // 'vector-page': never answered
  }
  terminate() {
    this.terminated = true
  }
}

const stuckWorkers = () => {
  StuckWorker.made = []
  vi.stubGlobal('Worker', StuckWorker)
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

describe('finding 3: Cancel and a time limit end a vector page the worker is stuck in', () => {
  it('Cancel terminates the worker and rejects with ExportCancelled at once', async () => {
    stuckWorkers()
    const controller = new AbortController()
    const run = renderPdf(canvas, frames(1), {
      title: 'Board',
      lossless: true,
      pagesKind: 'vector',
      signal: controller.signal,
    })
    run.catch(() => undefined)
    await until(() => StuckWorker.made[0]?.posted.includes('vector-page') === true)
    const t0 = Date.now()
    controller.abort()
    await expect(run).rejects.toBeInstanceOf(ExportCancelled)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(StuckWorker.made).toHaveLength(1)
    expect(StuckWorker.made[0]?.terminated).toBe(true)
  })

  it('a vector page past its time limit is an image page: the worker is stopped, the document made again', async () => {
    stuckWorkers()
    const result = await within(
      renderPdf(canvas, frames(1), {
        title: 'Board',
        lossless: true,
        pagesKind: 'vector',
        limits: { vectorPageMs: 50 },
      }),
      5000,
    )
    if (result === 'still waiting') throw new Error('the export did not end')
    expect(result.imagePages).toEqual([{ page: 1, reason: 'its vector drawing took too long' }])
    expect(StuckWorker.made.map((w) => [w.terminated, w.posted])).toEqual([
      [true, ['start', 'vector-page']],
      [true, ['start', 'page', 'finish']],
    ])
  })

  it('a second page past its limit: every frame is an image page (the export still ends)', async () => {
    stuckWorkers()
    const result = await within(
      renderPdf(canvas, frames(2), {
        title: 'Board',
        lossless: true,
        pagesKind: 'vector',
        limits: { vectorPageMs: 50 },
      }),
      5000,
    )
    if (result === 'still waiting') throw new Error('the export did not end')
    expect(result.imagePages).toEqual([
      { page: 1, reason: 'the vector PDF could not be finished' },
      { page: 2, reason: 'the vector PDF could not be finished' },
    ])
    expect(StuckWorker.made.map((w) => w.posted)).toEqual([
      ['start', 'vector-page'],
      ['start', 'page', 'vector-page'],
      ['start', 'page', 'page', 'finish'],
    ])
  })

  it('the builder alone: a vector page the worker never answers rejects at its limit, and the worker is stopped', async () => {
    stuckWorkers()
    const b: PdfBuilder = await createPdfBuilderOffThread({ title: 'T', limits: { vectorPageMs: 50 } })
    await expect(within(b.addVectorPage(vectorPage), 2000)).rejects.toThrow('a vector page took too long')
    expect(StuckWorker.made[0]?.terminated).toBe(true)
    await expect(b.finish()).rejects.toThrow('a vector page took too long')
  })
})
