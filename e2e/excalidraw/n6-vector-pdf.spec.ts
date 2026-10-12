// Wave N, WS6 (N6-3, N6-4, N6-5): vector PDF pages, checked as FILES (pdf-lib reads the pages, their images and
// where each image is drawn; pdf.js reads the text a viewer finds).
//  - a frame of shapes and a photo is a vector page: no full-page image, the photo an image XObject at its own
//    place; Lobby-font text is real text (CJK included) once the font engine (@pdf-lib/fontkit, N6-1) is installed,
//    and until then that page is honestly an image page and the dialog says so (and the run FAILS if the
//    VECTOR_PDF switch is on without the font engine);
//  - each vector page, drawn by pdf.js, matches the image page of the same frame pixel for pixel within
//    anti-aliasing and JPEG noise (a shape, a clip or a photo out of place fails);
//  - the dialog lists exactly the pages it exported as images ('Pages 3 and 5 were exported as images');
//  - "Image pages" gives today's output exactly (the pages, their sizes and byte-identical images);
//  - no request leaves Lobby's origins (the page's and the PDF worker's), and no File System Access picker opens
//    (a picker call would be a download the download events do not see).
// The vector option is behind VECTOR_PDF (off until the font engine lands); these specs turn on its local-dev
// preview (vector-pdf.ts VECTOR_PDF_DEV_PREVIEW_KEY, read only behind the dev-auth guard the e2e build has).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import type { PDFDict as PdfDictT, PDFNumber as PdfNumberT, PDFRawStream as PdfRawStreamT } from 'pdf-lib'
import { createItem, expect, expectSaved, selectNone, test, waitForCanvas } from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom, pdfPageTexts, readPdf } from '../tests/support/present-export.ts'
import { REPO_ROOT } from '../tests/support/stack.ts'
import type { Users } from '../tests/support/users.ts'
import { type DeckSpec, openBoardExport, placeUploadedImage, seedDeck, setFrame } from './present-kit.ts'

/** Whether this checkout has the font engine (N6-1): Lobby-font text is then real text on vector pages. */
const FONTKIT = existsSync(join(REPO_ROOT, 'apps/web/node_modules/@pdf-lib/fontkit/package.json'))
/** The kill switch as this checkout sets it (apps/web vector-pdf.ts): on, the font engine must be there. */
const VECTOR_PDF_SWITCH = /export const VECTOR_PDF(?::\s*boolean)?\s*=\s*(true|false)\b/.exec(
  readFileSync(join(REPO_ROOT, 'apps/web/src/features/present-export/vector-pdf.ts'), 'utf8'),
)?.[1]
const PREVIEW_KEY = 'lobby.dev.vectorPdf'

const e2eRequire = createRequire(import.meta.url)
type PdfLibMod = typeof import('pdf-lib')
const pdfLib = () => e2eRequire('pdf-lib') as PdfLibMod

type M = [number, number, number, number, number, number]
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]

interface Placement {
  /** the image's pixel size */
  px: { width: number; height: number }
  /** its drawn size on the page, points */
  width: number
  height: number
  /** sha-256 of the image stream's bytes */
  sha: string
}

/** Every image drawn on each page, with where (the content streams' q/Q/cm interpreted) and its bytes' hash. */
async function imagePlacements(
  bytes: Buffer,
): Promise<{ width: number; height: number; images: Placement[] }[]> {
  const { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFNumber, decodePDFRawStream } = pdfLib()
  const doc = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false })
  const out: { width: number; height: number; images: Placement[] }[] = []
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    const byName = new Map<string, PdfRawStreamT>()
    for (const [name, ref] of xobjects?.entries() ?? []) {
      const x = doc.context.lookup(ref)
      if (x instanceof PDFRawStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
        byName.set(name.toString(), x)
    }
    const c = page.node.Contents()
    const streams = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c]
    let text = ''
    for (const s of streams)
      if (s instanceof PDFRawStream)
        text += `${new TextDecoder('latin1').decode(decodePDFRawStream(s).decode())}\n`
    const images: Placement[] = []
    const stack: M[] = []
    let ctm: M = [1, 0, 0, 1, 0, 0]
    const nums: number[] = []
    let lastName = ''
    // strings are skipped whole (a text's bytes are never operators)
    for (const tok of text.replace(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>/g, ' ').split(/\s+/)) {
      if (!tok) continue
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
        nums.push(Number(tok))
        continue
      }
      if (tok.startsWith('/')) {
        lastName = tok
        nums.length = 0
        continue
      }
      if (tok === 'q') stack.push(ctm)
      else if (tok === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
      else if (tok === 'cm' && nums.length >= 6) ctm = mul(ctm, nums.slice(-6) as M)
      else if (tok === 'Do') {
        const x = byName.get(lastName)
        if (x) {
          const w = Math.hypot(ctm[0], ctm[1])
          const h = Math.hypot(ctm[2], ctm[3])
          images.push({
            px: {
              width: (x.dict.lookup(PDFName.of('Width'), PDFNumber) as PdfNumberT).asNumber(),
              height: (x.dict.lookup(PDFName.of('Height'), PDFNumber) as PdfNumberT).asNumber(),
            },
            width: Math.round(w * 100) / 100,
            height: Math.round(h * 100) / 100,
            sha: createHash('sha256').update(x.contents).digest('hex'),
          })
        }
      }
      nums.length = 0
    }
    const { width, height } = page.getSize()
    out.push({ width, height, images })
  }
  return out
}

/** Whether the document embeds a TrueType font program (FontFile2) with a ToUnicode map (real, searchable text). */
async function embeddedSubsetFonts(bytes: Buffer): Promise<string[]> {
  const { PDFDocument, PDFName, PDFDict } = pdfLib()
  const doc = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false })
  const names: string[] = []
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('Font')) continue
    const descendants = obj.lookupMaybe(PDFName.of('DescendantFonts'), pdfLib().PDFArray)
    const cid = descendants ? (doc.context.lookup(descendants.get(0)) as PdfDictT) : obj
    const desc = cid.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)
    if (desc?.get(PDFName.of('FontFile2')) && obj.get(PDFName.of('ToUnicode')))
      names.push(String(obj.get(PDFName.of('BaseFont'))))
  }
  return names
}

interface Rendered {
  width: number
  height: number
  /** RGBA */
  data: Uint8ClampedArray
}

interface PdfJsRender {
  getDocument(src: Record<string, unknown>): {
    promise: Promise<{
      numPages: number
      canvasFactory: {
        create(
          w: number,
          h: number,
        ): {
          canvas: { width: number; height: number; toBuffer(mime: string): Buffer }
          context: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } }
        }
      }
      getPage(n: number): Promise<{
        getViewport(o: { scale: number }): { width: number; height: number }
        render(o: Record<string, unknown>): { promise: Promise<void> }
      }>
    }>
    /** pdf.js 6: the loading task owns the document (PDFDocumentProxy has no destroy()) */
    destroy(): Promise<void>
  }
}

/**
 * Every page as a viewer draws it: pdf.js (an e2e dependency) in this process, at `scale` pixels per point.
 * N6_PDF_DIR keeps the pictures as <name>-<page>.png.
 */
async function renderPages(bytes: Buffer, scale: number, name: string): Promise<Rendered[]> {
  const root = dirname(e2eRequire.resolve('pdfjs-dist/package.json'))
  const pdfjs = (await import(pathToFileURL(join(root, 'legacy/build/pdf.mjs')).href)) as PdfJsRender
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: `${root.replaceAll('\\', '/')}/standard_fonts/`,
    useSystemFonts: false,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    const out: Rendered[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const viewport = page.getViewport({ scale })
      const { canvas, context } = doc.canvasFactory.create(
        Math.round(viewport.width),
        Math.round(viewport.height),
      )
      await page.render({ canvas, canvasContext: context, viewport }).promise
      out.push({
        width: canvas.width,
        height: canvas.height,
        data: context.getImageData(0, 0, canvas.width, canvas.height).data,
      })
      keep(`${name}-${n}.png`, canvas.toBuffer('image/png'))
    }
    return out
  } finally {
    await task.destroy()
  }
}

/**
 * The share of `a`'s pixels with no close match (every channel within `tolerance`) in `b` within one pixel: what
 * anti-aliasing, JPEG noise and a sub-pixel offset leave alone, and what a shape, a clip or an image drawn in the
 * wrong place (or not at all) does not.
 */
function unmatched(a: Rendered, b: Rendered, tolerance: number): number {
  if (a.width !== b.width || a.height !== b.height) return 1
  const { width: w, height: h } = a
  let bad = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      let best = 255
      for (let dy = -1; dy <= 1 && best > tolerance; dy++)
        for (let dx = -1; dx <= 1 && best > tolerance; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = (yy * w + xx) * 4
          const d = Math.max(
            Math.abs((a.data[i] as number) - (b.data[j] as number)),
            Math.abs((a.data[i + 1] as number) - (b.data[j + 1] as number)),
            Math.abs((a.data[i + 2] as number) - (b.data[j + 2] as number)),
          )
          if (d < best) best = d
        }
      if (best > tolerance) bad++
    }
  return bad / (w * h)
}

/** A vector page against the image page of the same frame: both ways (a thing missing on either side counts). */
const pageMismatch = (vector: Rendered, image: Rendered) =>
  Math.max(unmatched(vector, image, 48), unmatched(image, vector, 48))

/** Every request (the page's and its workers') that leaves Lobby's origins: none may (the e2e network assertion). */
function watchOrigins(context: BrowserContext) {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  const fonts: string[] = []
  context.on('request', (r) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
    else if (url.pathname.startsWith('/excalidraw-assets/fonts/')) fonts.push(url.pathname)
  })
  return { foreign, fonts }
}

/** Counts File System Access picker calls (a picker is a download Playwright's events never see) and rejects them. */
async function countPickers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    const counts: Record<string, number> = {}
    Object.defineProperty(window, '__n6Pickers', { value: counts })
    for (const name of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
      counts[name] = 0
      w[name] = () => {
        counts[name] = (counts[name] ?? 0) + 1
        return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
      }
    }
  })
  return () =>
    page.evaluate(() => ({
      ...((window as unknown as { __n6Pickers?: Record<string, number> }).__n6Pickers ?? {}),
    }))
}

const boardTitle = async (users: Users, board: string) =>
  (await (await users.api('alice')).getBoard(board)).board.title

async function previewVector(page: Page, on: boolean) {
  await page.evaluate(({ key, on }) => (on ? localStorage.setItem(key, '1') : localStorage.removeItem(key)), {
    key: PREVIEW_KEY,
    on,
  })
}

/** N6_PDF_DIR=<folder>: keeps the exported PDFs there, to look at (debugging only). */
const keep = (name: string, bytes: Buffer) => {
  const dir = process.env.N6_PDF_DIR
  if (dir) writeFileSync(join(dir, name), bytes)
}

const BAND = 28 // the header band on pages this narrow (pdf-layout headerBandHeight)

test.describe('N6 vector PDF', () => {
  test('a vector PDF: shapes and a photo as vector graphics (the photo drawn natively, no page image), Lobby-font text real text or honestly an image page; only Lobby origins, no file picker', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const net = watchOrigins(a.context)
    const pickers = await countPickers(a.page)
    await a.page.reload()
    await waitForCanvas(a.page)
    const title = await boardTitle(users, board)
    const INTRO = { id: 'n6-intro', name: 'Intro', x: 0, y: 0, w: 800, h: 600, index: 0 }
    const SHAPES = { id: 'n6-shapes', name: 'Shapes', x: 1000, y: 0, w: 800, h: 600, index: 1 }
    const deck: DeckSpec = {
      frames: [INTRO, SHAPES],
      notes: [{ id: 'n6-note', frame: INTRO.id, x: 60, y: 60, text: 'Kickoff agenda' }],
    }
    await seedDeck(a.page, deck)
    await createItem(a.page, 'text', { id: 'n6-cjk', x: 60, y: 400, text: '日本語のメモ', frameId: INTRO.id })
    await expectSaved(a.page)
    for (const [i, x] of [60, 300].entries()) {
      await createItem(a.page, 'rectangle', {
        id: `n6-rect-${i}`,
        x: SHAPES.x + x,
        y: 60,
        width: 180,
        height: 120,
        backgroundColor: '#a5d8ff',
        fillStyle: 'solid',
      })
      await expectSaved(a.page)
      await setFrame(a.page, [`n6-rect-${i}`], SHAPES.id)
      await expectSaved(a.page)
    }
    await placeUploadedImage(a.page, users, board, SHAPES, { x: 60, y: 300, w: 400, h: 225 })
    await selectNone(a.page)

    // the port option the vector page reads (foundation: export.svg fonts 'names', WS6's canvas/export/scene.ts): no
    // @font-face at all, the face table of the text's fonts instead, same-origin paths only (CJK's Xiaolai among them)
    const svg = await a.page.evaluate(
      (id) =>
        (
          window as unknown as {
            __lobbyBoard?: { canvas: { export: { svg(o: Record<string, unknown>): Promise<string> } } }
          }
        ).__lobbyBoard?.canvas.export.svg({
          frameId: id,
          fonts: 'names',
          files: 'display',
          background: true,
        }) ?? '',
      INTRO.id,
    )
    keep('intro-names.svg', Buffer.from(svg))
    expect(svg).toMatch(/^<svg/)
    expect(svg).not.toContain('@font-face')
    const json = /<metadata id="lobby-pdf-faces">([^<]*)<\/metadata>/.exec(svg)?.[1] ?? ''
    const table = JSON.parse(json.replaceAll('&quot;', '"').replaceAll('&amp;', '&')) as {
      faces: { family: string; url: string }[]
    }
    expect(table.faces.length).toBeGreaterThan(0)
    for (const f of table.faces) expect(f.url).toMatch(/^\/excalidraw-assets\/fonts\/[\w-]+\/[\w.-]+\.woff2$/)
    expect(table.faces.map((f) => f.family)).toContain('Xiaolai')

    await previewVector(a.page, true)
    await openBoardExport(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    // N6-5: offered, on by default
    await expect(dialog.getByTestId('export-pdf-pages-vector')).toBeChecked()
    await expect(dialog.getByTestId('export-pdf-pages-image')).not.toBeChecked()
    await expect(dialog.getByTestId('export-pdf-hint')).toContainText('Vector pages stay sharp at any zoom')
    const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    expect(pdf.name).toBe(`${title}.pdf`)
    keep('vector.pdf', pdf.bytes)
    await expect(dialog.getByTestId('export-status')).toHaveText(`Downloaded “${title}.pdf” (2 pages).`)

    const info = await readPdf(pdf.bytes)
    expect(info.pages.map((p) => [p.width, p.height])).toEqual([
      [600, 450 + BAND],
      [600, 450 + BAND],
    ])
    expect(info.outline).toEqual([
      { title: 'Intro', page: 0 },
      { title: 'Shapes', page: 1 },
    ])
    const placed = await imagePlacements(pdf.bytes)
    const texts = await pdfPageTexts(pdf.bytes)

    // page 2 (Shapes) is a vector page: one image, the photo, drawn at its own place (400 × 225 px → 300 × 168.75 pt),
    // never a picture of the page; the rectangles are vector paths
    const shapes = placed[1]
    expect(shapes?.images).toHaveLength(1)
    expect(shapes?.images[0]?.width).toBeCloseTo(300, 0)
    expect(shapes?.images[0]?.height).toBeCloseTo(168.75, 0)
    expect(shapes?.images[0]?.px.width).toBeLessThanOrEqual(2048) // the display copy, not a 3× frame raster

    if (FONTKIT) {
      // page 1 (Intro): real text in embedded subsets of Lobby's fonts, CJK included; no image at all
      await expect(dialog.getByTestId('export-pdf-fallback')).toHaveCount(0)
      expect(placed[0]?.images).toEqual([])
      expect(texts[0]).toContain('Kickoff agenda')
      expect(texts[0]).toContain('日本語のメモ')
      expect((await embeddedSubsetFonts(pdf.bytes)).length).toBeGreaterThan(0)
    } else {
      // without the font engine, Lobby-font text is never drawn in a stand-in: page 1 is today's image page, and
      // the dialog says so; its hidden text layer still finds the Latin words
      await expect(dialog.getByTestId('export-pdf-fallback')).toContainText('Page 1 was exported as an image')
      expect(placed[0]?.images.map((i) => [i.px.width, i.px.height])).toEqual([[2400, 1800]])
      expect(placed[0]?.images[0]?.width).toBeCloseTo(600, 0)
      expect(texts[0]).toContain('Kickoff agenda')
      // never shipped that way: with the switch on, a missing font engine fails here rather than being noted
      expect(VECTOR_PDF_SWITCH, 'the VECTOR_PDF switch is read from vector-pdf.ts').toBeDefined()
      expect(
        VECTOR_PDF_SWITCH,
        'VECTOR_PDF is on but @pdf-lib/fontkit is not installed: Lobby-font text would never be real text',
      ).toBe('false')
      test.info().annotations.push({
        type: 'not run',
        description:
          '@pdf-lib/fontkit is not installed (N6-1 pending): Lobby-font text and CJK as real text unchecked',
      })
    }
    expect(texts[1]?.startsWith('Shapes')).toBe(true)

    // what a viewer shows: each vector page drawn by pdf.js matches the image page of the same frame (today's
    // picture of it, drawn by the canvas) within anti-aliasing and JPEG noise: the shapes, the photo, its clip and
    // every transform in place. Measured (2× render, 1200 × 956 px): 0.000% unmatched here, the photo drawn 2 px
    // off 0.146%, the shapes 2 px off 0.313%. When the font engine lands, page 1 compares real text with the
    // canvas's text: its tolerance is decided then, with this measure, never by loosening the shapes' one.
    await dialog.getByTestId('export-pdf-pages-image').check()
    const imagePdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    keep('vector-as-images.pdf', imagePdf.bytes)
    await expect(dialog.getByTestId('export-pdf-fallback')).toHaveCount(0)
    const [vectorShown, imageShown] = [
      await renderPages(pdf.bytes, 2, 'vector'),
      await renderPages(imagePdf.bytes, 2, 'images'),
    ]
    expect(vectorShown.map((p) => [p.width, p.height])).toEqual(imageShown.map((p) => [p.width, p.height]))
    const mismatch = vectorShown.map((p, i) => pageMismatch(p, imageShown[i] as Rendered))
    test.info().annotations.push({
      type: 'vector vs image pages',
      description: mismatch.map((m, i) => `page ${i + 1}: ${(m * 100).toFixed(4)}% unmatched`).join('; '),
    })
    for (const [i, m] of mismatch.entries())
      expect(m, `page ${i + 1} looks like its image page`).toBeLessThan(0.0002)

    // the PDF worker read Lobby's own font files, same-origin (the face table of the 'names' SVG)
    expect(net.fonts.length).toBeGreaterThan(0)
    expect(net.fonts.every((p) => /^\/excalidraw-assets\/fonts\/[\w-]+\/[\w.-]+\.woff2$/.test(p))).toBe(true)
    expect(net.foreign).toEqual([])
    expect(await pickers()).toEqual({ showSaveFilePicker: 0, showOpenFilePicker: 0, showDirectoryPicker: 0 })
  })

  test('N6-4: the dialog lists exactly the pages it exported as images (Pages 3 and 5), and those pages alone are pictures', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const net = watchOrigins(a.context)
    // frame 5's name is not one the standard PDF font shows: its header is a picture, made once for the vector try
    // and used again by the image page it falls back to
    const frames = [1, 2, 3, 4, 5].map((n, i) => ({
      id: `n6-f${n}`,
      name: n === 5 ? 'Step 5 · 日本' : `Step ${n}`,
      x: i * 900,
      y: 0,
      w: 640,
      h: 480,
      index: i,
    }))
    await seedDeck(a.page, { frames })
    for (const f of frames) {
      await createItem(a.page, 'rectangle', {
        id: `${f.id}-r`,
        x: f.x + 40,
        y: 40,
        width: 200,
        height: 120,
        backgroundColor: '#ffc9c9',
        fillStyle: 'solid',
      })
      await expectSaved(a.page)
      await setFrame(a.page, [`${f.id}-r`], f.id)
      await expectSaved(a.page)
    }
    // frames 3 and 5: right-to-left text (never laid out by the vector page: an image page instead)
    for (const n of [3, 5]) {
      const f = frames[n - 1] as (typeof frames)[number]
      await createItem(a.page, 'text', {
        id: `${f.id}-he`,
        x: f.x + 40,
        y: 300,
        text: 'שלום עולם',
        frameId: f.id,
      })
      await expectSaved(a.page)
    }
    await selectNone(a.page)
    await previewVector(a.page, true)
    await openBoardExport(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    const title = await boardTitle(users, board)
    const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    keep('fallback.pdf', pdf.bytes)
    await expect(dialog.getByTestId('export-status')).toHaveText(`Downloaded “${title}.pdf” (5 pages).`)
    const note = dialog.getByTestId('export-pdf-fallback')
    await expect(note).toBeVisible()
    expect((await note.textContent())?.startsWith('Pages 3 and 5 were exported as images')).toBe(true)
    const placed = await imagePlacements(pdf.bytes)
    // pages 3 and 5: the frame's picture; page 5 also its header's title picture
    expect(placed.map((p) => p.images.length)).toEqual([0, 0, 1, 0, 2])
    for (const n of [3, 5]) {
      const img = placed[n - 1]?.images.find((i) => i.px.width === 1920)
      expect(img?.px).toEqual({ width: 1920, height: 1440 }) // today's 3× raster of a 640 × 480 frame
      expect(img?.width).toBeCloseTo(480, 0) // the whole frame area of the page
    }
    const header = placed[4]?.images.find((i) => i.px.width !== 1920)
    expect(header?.px.width).toBeGreaterThan(20) // a real picture of the title, not an empty or detached one
    expect(header?.height).toBeLessThan(BAND)
    expect((await readPdf(pdf.bytes)).outline.map((o) => o.title)).toEqual(frames.map((f) => f.name))
    expect(net.foreign).toEqual([])
  })

  test('N6-5: "Image pages" gives today’s output exactly (the pages, their sizes and byte-identical images), and the choice is remembered', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const INTRO = { id: 'n6i-intro', name: 'Intro', x: 0, y: 0, w: 800, h: 600, index: 1 }
    const PLAN = { id: 'n6i-plan', name: 'Plan', x: 1000, y: 0, w: 640, h: 480, index: 0 }
    await seedDeck(a.page, {
      frames: [INTRO, PLAN],
      notes: [
        { id: 'n6i-n1', frame: INTRO.id, x: 300, y: 200, text: 'Kickoff agenda' },
        { id: 'n6i-n2', frame: PLAN.id, x: 220, y: 140, text: 'Launch checklist' },
      ],
    })
    await placeUploadedImage(a.page, users, board, INTRO, { x: 40, y: 330, w: 400, h: 225 })
    await selectNone(a.page)
    const dialog = a.page.getByTestId('export-dialog')

    // today's dialog (the vector option not offered: VECTOR_PDF off and no preview)
    await previewVector(a.page, false)
    await openBoardExport(a.page)
    await expect(dialog.getByTestId('export-pdf-pages')).toHaveCount(0)
    const today = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // the preview on, "Image pages" chosen
    await previewVector(a.page, true)
    await openBoardExport(a.page)
    await dialog.getByTestId('export-pdf-pages-image').check()
    await expect(dialog.getByTestId('export-pdf-hint')).toContainText('Pages are sharp images of your frames')
    const images = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    await expect(dialog.getByTestId('export-pdf-fallback')).toHaveCount(0)
    await a.page.keyboard.press('Escape')

    const [t, i] = [await readPdf(today.bytes), await readPdf(images.bytes)]
    expect(i.pages).toEqual(t.pages)
    expect(i.outline).toEqual(t.outline)
    expect(t.pages.map((p) => p.images)).toEqual([
      [{ width: 1920, height: 1440 }],
      [{ width: 2400, height: 1800 }],
    ])
    const [tp, ip] = [await imagePlacements(today.bytes), await imagePlacements(images.bytes)]
    expect(ip).toEqual(tp) // the same images, drawn the same way, byte for byte
    expect(await pdfPageTexts(images.bytes)).toEqual(await pdfPageTexts(today.bytes))

    // remembered: the next opening is on Image pages
    await openBoardExport(a.page)
    await expect(dialog.getByTestId('export-pdf-pages-image')).toBeChecked()
  })
})
