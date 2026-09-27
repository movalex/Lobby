// Helpers for the present-export suite (present mode, PNG/SVG/PDF/CSV exports, copy as PNG) and the two
// integration checks that ride on it (event stream after an API restart, clean presentations).
//
// Downloaded files are checked as files, not as UI state: PNGs are parsed here (signature, IHDR, pHYs,
// the top-left pixel), PDFs with pdf-lib (pages, sizes, bookmarks, page images) and pdf.js (the text
// layer). e2e declares no dependency on either library, so they are loaded from the workspace packages
// that already depend on them (apps/web: pdf-lib, apps/worker: pdfjs-dist) — see the unresolved note in
// the validation report: e2e/package.json should declare them.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import {
  type Browser,
  type BrowserContext,
  type Download,
  expect,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test'
import { type Api, signInContext } from './api.ts'
import {
  boardDocument,
  edit,
  insertFiles,
  pageShapes,
  read,
  type Session,
  waitForBoard,
  waitForValue,
} from './board.ts'
import { type BoxLike, type EditorLike, richText, type VecLike } from './editor.ts'
import { FIXTURES_DIR } from './stack.ts'
import type { TestUser } from './users.ts'

// ---- the slice of tldraw 5.4.2's Editor these tests use beyond support/editor.ts ----------------------

export interface CameraLike {
  x: number
  y: number
  z: number
}

/** Methods verified in node_modules/@tldraw/editor/src/lib/editor/Editor.ts (5.4.2). */
export interface PresentEditor extends EditorLike {
  getCamera(): CameraLike
  getViewportPageBounds(): BoxLike
  getViewportScreenBounds(): BoxLike
  getCurrentPageBounds(): BoxLike | undefined
  getSelectionPageBounds(): BoxLike | null
  getCurrentPageId(): string
  getCurrentPageShapeIds(): Set<string>
  reparentShapes(ids: string[], parentId: string): EditorLike
  getCanUndo(): boolean
  getInstanceState(): { isFocused: boolean; exportBackground: boolean }
}

// `edit`/`read` callbacks are serialized into the page, so they may only use their parameters: widen the
// editor with an inline `ed as unknown as PresentEditor` (erased at runtime), never a helper function.

// ---- board setup -----------------------------------------------------------------------------------

export interface FrameSpec {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** meta.presentationSkip (what the Frames panel's skip toggle writes). */
  skip?: boolean
  /** meta.presentationIndex (what reordering in the Frames panel writes). */
  index?: number
}

export interface NoteSpec {
  id: string
  /** A frame id: x/y are then relative to the frame. Omitted: a page-level note (keep it outside frames). */
  parentId?: string
  x: number
  y: number
  text: string
  color?: string
}

export interface BoardSpec {
  frames?: FrameSpec[]
  notes?: NoteSpec[]
}

/** Creates the frames, then the notes (one undoable step each), as the signed-in user of `page`. */
export async function seedBoard(page: Page, spec: BoardSpec) {
  const frames = (spec.frames ?? []).map((f) => ({
    id: f.id,
    type: 'frame',
    x: f.x,
    y: f.y,
    props: { w: f.w, h: f.h, name: f.name },
    meta: {
      ...(f.skip ? { presentationSkip: true } : {}),
      ...(typeof f.index === 'number' ? { presentationIndex: f.index } : {}),
    },
  }))
  const notes = (spec.notes ?? []).map((n) => ({
    id: n.id,
    type: 'note',
    ...(n.parentId ? { parentId: n.parentId } : {}),
    x: n.x,
    y: n.y,
    props: { color: n.color ?? 'yellow', richText: richText(n.text) },
  }))
  await edit(
    page,
    (ed, arg) => {
      if (arg.frames.length) ed.createShapes(arg.frames)
      if (arg.notes.length) ed.createShapes(arg.notes)
    },
    { frames, notes },
  )
}

/** Waits until `page` holds every listed shape (a collaborator's copy has caught up). */
export async function expectShapes(page: Page, ids: string[], timeout = 15_000) {
  await expect
    .poll(() => read(page, (ed, list) => list.filter((id) => !ed.getShape(id)), ids), {
      timeout,
      message: 'shapes missing on this client',
    })
    .toEqual([])
}

export const camera = (page: Page) => read(page, (ed) => (ed as unknown as PresentEditor).getCamera())

export const roundCamera = (c: CameraLike) => ({
  x: Math.round(c.x * 1000) / 1000,
  y: Math.round(c.y * 1000) / 1000,
  z: Math.round(c.z * 10_000) / 10_000,
})

/**
 * How `frameId` sits in the current viewport: whether it is fully inside, how far its centre is from the
 * viewport's centre (page units) and how much of the viewport it fills along its tighter axis (1 = fitted).
 */
export function slidePlacement(page: Page, frameId: string) {
  return read(
    page,
    (ed, id) => {
      const vp = (ed as unknown as PresentEditor).getViewportPageBounds()
      const f = ed.getShapePageBounds(id)
      if (!f) return null
      const eps = 1
      return {
        inside:
          f.x >= vp.x - eps &&
          f.y >= vp.y - eps &&
          f.x + f.w <= vp.x + vp.w + eps &&
          f.y + f.h <= vp.y + vp.h + eps,
        centreOffset: Math.hypot(f.x + f.w / 2 - (vp.x + vp.w / 2), f.y + f.h / 2 - (vp.y + vp.h / 2)),
        fill: Math.max(f.w / vp.w, f.h / vp.h),
      }
    },
    frameId,
  )
}

/** The frame is the slide on screen: inside the viewport, centred and fitted (camera animation done). */
export async function expectSlideOnScreen(page: Page, frameId: string) {
  await expect
    .poll(
      async () => {
        const p = await slidePlacement(page, frameId)
        return !!p && p.inside && p.centreOffset < 1 && p.fill > 0.98
      },
      { message: `${frameId} fitted on screen`, timeout: 10_000 },
    )
    .toBe(true)
}

/** Resolves after two animation frames (tldraw and React have flushed what a key event triggered). */
export const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

/** Screen point (CSS px in the page) of a page-space point, for mouse moves. */
export async function screenPoint(page: Page, p: VecLike): Promise<VecLike> {
  return read(page, (ed, point) => ed.pageToScreen(point), p)
}

export async function shapeCentre(page: Page, id: string): Promise<VecLike> {
  const b = await read(page, (ed, shapeId) => ed.getShapePageBounds(shapeId) ?? null, id)
  if (!b) throw new Error(`${id} has no bounds`)
  return screenPoint(page, { x: b.x + b.w / 2, y: b.y + b.h / 2 })
}

// ---- present mode locators ---------------------------------------------------------------------------

export const presentUi = (page: Page) => ({
  button: page.getByTestId('present-button'),
  overlay: page.getByTestId('present-overlay'),
  counter: page.getByTestId('present-counter'),
  title: page.locator('.dr-present__title'),
  grid: page.getByTestId('present-grid'),
  exit: page.getByTestId('present-exit'),
})

/** data-testid of the focused element (null when it has none). */
export const focusedTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)

// ---- downloads -----------------------------------------------------------------------------------------

export async function downloadBytes(download: Download): Promise<Buffer> {
  const path = await download.path()
  return readFileSync(path)
}

/** Clicks `trigger` and returns the download it starts (file name + bytes). */
export async function downloadFrom(page: Page, click: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), click()])
  return { name: download.suggestedFilename(), bytes: await downloadBytes(download) }
}

/** Collects every download a page starts (to prove that none happened). */
export function collectDownloads(page: Page) {
  const names: string[] = []
  page.on('download', (d) => names.push(d.suggestedFilename()))
  return names
}

// ---- PNG -----------------------------------------------------------------------------------------------

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
  /** Pixels per metre (x) of every pHYs chunk, in file order (the PNG spec allows at most one). */
  pixelsPerMetre: number[]
  /** RGBA of the top-left pixel (8-bit RGB/RGBA, non-interlaced images). */
  topLeft: [number, number, number, number] | null
}

/**
 * Minimal PNG reader: validates the signature, reads IHDR/pHYs and decodes the top-left pixel. For the
 * first pixel of the first scanline every PNG filter (None/Sub/Up/Average/Paeth) predicts 0, so the
 * filtered bytes ARE the pixel: no full unfiltering needed.
 */
export function readPng(buf: Buffer): PngInfo {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file')
  let offset = 8
  let ihdr: Buffer | null = null
  const ppm: number[] = []
  const idat: Buffer[] = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') ihdr = data
    else if (type === 'pHYs') ppm.push(data.readUInt32BE(0))
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!ihdr) throw new Error('PNG without IHDR')
  const info: PngInfo = {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8] ?? 0,
    colorType: ihdr[9] ?? 0,
    interlace: ihdr[12] ?? 0,
    pixelsPerMetre: ppm,
    topLeft: null,
  }
  if (info.bitDepth === 8 && info.interlace === 0 && (info.colorType === 6 || info.colorType === 2)) {
    const raw = inflateSync(Buffer.concat(idat))
    const px = raw.subarray(1, info.colorType === 6 ? 5 : 4)
    info.topLeft = [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0, info.colorType === 6 ? (px[3] ?? 0) : 255]
  }
  return info
}

// ---- SVG -----------------------------------------------------------------------------------------------

/** The root element's name (after an optional XML declaration / comments / doctype). */
export function svgRootName(text: string): string | null {
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .replace(/^\s*<\?xml[^>]*\?>/, '')
    .replace(/^\s*(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/, '')
  return /^\s*<([A-Za-z][\w:.-]*)/.exec(body)?.[1] ?? null
}

/** Every base64 data: URL image embedded in the SVG, decoded. */
export function svgEmbeddedImages(text: string): { mime: string; bytes: Buffer }[] {
  const out: { mime: string; bytes: Buffer }[] = []
  for (const m of text.matchAll(/data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g)) {
    out.push({ mime: m[1] ?? '', bytes: Buffer.from(m[2] ?? '', 'base64') })
  }
  return out
}

// ---- PDF (pdf-lib for structure, pdf.js for the text layer) ----------------------------------------------

interface PdfObjectLike {
  toString(): string
}
interface PdfNameLike extends PdfObjectLike {
  asString(): string
}
interface PdfDictLike extends PdfObjectLike {
  get(key: PdfNameLike): PdfObjectLike | undefined
  lookup(key: PdfNameLike): PdfObjectLike | undefined
  entries(): [PdfNameLike, PdfObjectLike][]
}
interface PdfArrayLike extends PdfObjectLike {
  get(index: number): PdfObjectLike | undefined
}
interface PdfTextLike extends PdfObjectLike {
  decodeText(): string
}
interface PdfNumberLike extends PdfObjectLike {
  asNumber(): number
}
interface PdfStreamLike extends PdfObjectLike {
  dict: PdfDictLike
}
interface PdfPageLike {
  ref: PdfObjectLike
  node: { Resources(): PdfDictLike | undefined }
  getSize(): { width: number; height: number }
}
interface PdfDocumentLike {
  catalog: PdfDictLike
  context: { lookup(ref: PdfObjectLike): PdfObjectLike | undefined }
  getPageCount(): number
  getPages(): PdfPageLike[]
  getTitle(): string | undefined
}
interface PdfLib {
  PDFDocument: { load(bytes: Uint8Array, opts?: { updateMetadata?: boolean }): Promise<PdfDocumentLike> }
  PDFName: { of(name: string): PdfNameLike }
}

// pdf-lib and pdfjs-dist are e2e devDependencies (read the exported PDFs in the test process).
const e2eRequire = createRequire(import.meta.url)
let pdfLib: PdfLib | null = null
const loadPdfLib = () => {
  pdfLib ??= e2eRequire('pdf-lib') as PdfLib
  return pdfLib
}

export interface PdfPageInfo {
  /** Points. */
  width: number
  height: number
  /** Pixel size of each image XObject drawn on the page. */
  images: { width: number; height: number }[]
}

export interface PdfInfo {
  title: string | undefined
  pages: PdfPageInfo[]
  /** Bookmarks in order, with the index of the page each one opens. */
  outline: { title: string; page: number }[]
}

export async function readPdf(bytes: Buffer): Promise<PdfInfo> {
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  const { PDFDocument, PDFName } = loadPdfLib()
  const doc = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false })
  const pages = doc.getPages()
  const pageIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]))
  const num = (o: PdfObjectLike | undefined) => (o as PdfNumberLike | undefined)?.asNumber() ?? Number.NaN

  const pageInfo = pages.map((p): PdfPageInfo => {
    const { width, height } = p.getSize()
    const images: { width: number; height: number }[] = []
    const xobjects = p.node.Resources()?.lookup(PDFName.of('XObject')) as PdfDictLike | undefined
    for (const [, ref] of xobjects?.entries() ?? []) {
      const stream = doc.context.lookup(ref) as PdfStreamLike | undefined
      if (stream?.dict?.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue
      images.push({
        width: num(stream.dict.get(PDFName.of('Width'))),
        height: num(stream.dict.get(PDFName.of('Height'))),
      })
    }
    return { width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100, images }
  })

  const outline: { title: string; page: number }[] = []
  const root = doc.catalog.lookup(PDFName.of('Outlines')) as PdfDictLike | undefined
  let item = root?.lookup(PDFName.of('First')) as PdfDictLike | undefined
  for (let guard = 0; item && guard < 10_000; guard++) {
    const title = (item.lookup(PDFName.of('Title')) as PdfTextLike | undefined)?.decodeText() ?? ''
    const dest = item.lookup(PDFName.of('Dest')) as PdfArrayLike | undefined
    const target = dest?.get(0)?.toString() ?? ''
    outline.push({ title, page: pageIndex.get(target) ?? -1 })
    item = item.lookup(PDFName.of('Next')) as PdfDictLike | undefined
  }
  return { title: doc.getTitle(), pages: pageInfo, outline }
}

interface PdfJsTextItem {
  str?: string
}
interface PdfJs {
  getDocument(src: {
    data: Uint8Array
    standardFontDataUrl?: string
    useSystemFonts?: boolean
    verbosity?: number
  }): {
    promise: Promise<{
      numPages: number
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfJsTextItem[] }> }>
    }>
    /** PDFDocumentProxy has no destroy() in pdf.js 6: the loading task owns the document and worker. */
    destroy(): Promise<void>
  }
}

/** The text pdf.js extracts from each page (what search / select-all / copy in a viewer see). */
export async function pdfPageTexts(bytes: Buffer): Promise<string[]> {
  const root = dirname(e2eRequire.resolve('pdfjs-dist/package.json'))
  const pdfjs = (await import(pathToFileURL(join(root, 'legacy/build/pdf.mjs')).href)) as PdfJs
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: `${root.replaceAll('\\', '/')}/standard_fonts/`,
    useSystemFonts: false,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    const texts: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent()
      texts.push(
        content.items
          .map((i) => i.str ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
    return texts
  } finally {
    await task.destroy()
  }
}

// ---- CSV -----------------------------------------------------------------------------------------------

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF records, line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// ---- network ---------------------------------------------------------------------------------------------

/** Requests whose URL passes `match`, recorded from now on (pending = started and not yet ended). */
export function trackRequests(page: Page, match: (url: URL) => boolean) {
  const pending = new Set<Request>()
  const urls: string[] = []
  page.on('request', (r) => {
    if (!match(new URL(r.url()))) return
    pending.add(r)
    urls.push(r.url())
  })
  const end = (r: Request) => void pending.delete(r)
  page.on('requestfinished', end)
  page.on('requestfailed', end)
  return {
    pending: () => pending.size,
    total: () => urls.length,
    paths: () => urls.map((u) => new URL(u).pathname),
    clear: () => void urls.splice(0),
  }
}

export const isFileRequest = (u: URL) => u.pathname.startsWith('/files/')
export const ORIGINAL_PATH = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original$/
export const DERIVATIVE_PATH = /\/d\/drv_/

// ---- DOM observation ---------------------------------------------------------------------------------------

/**
 * Starts recording, in the page, every state of `[data-testid=<testId>]` (value/max for a <progress>):
 * a short-lived element (a progress bar during a quick export) is still proven to have shown.
 */
export async function watchTestId(page: Page, testId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __peSeen?: Record<string, string[]> }
    w.__peSeen ??= {}
    const log: string[] = []
    w.__peSeen[id] = log
    const note = () => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return
      const state =
        el instanceof HTMLProgressElement ? `${el.value}/${el.max}` : (el.textContent ?? '').trim()
      if (log[log.length - 1] !== state) log.push(state)
    }
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    note()
  }, testId)
  return () =>
    page.evaluate(
      (id) => (window as unknown as { __peSeen?: Record<string, string[]> }).__peSeen?.[id] ?? [],
      testId,
    )
}

// ---- clipboard ---------------------------------------------------------------------------------------------

/** What the async clipboard holds: its types and, when there is one, the image/png bytes (base64). */
export function readClipboard(page: Page) {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const types = items.flatMap((i) => [...i.types])
    const png = items.find((i) => i.types.includes('image/png'))
    let pngBase64: string | null = null
    if (png) {
      const bytes = new Uint8Array(await (await png.getType('image/png')).arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      pngBase64 = btoa(bin)
    }
    return { types, pngBase64 }
  })
}

export const writeClipboardText = (page: Page, text: string) =>
  page.evaluate((t) => navigator.clipboard.writeText(t), text)

// ---- sessions opened with instrumentation from the first request ------------------------------------------

/**
 * Like support/board.ts `openSession`, but `beforeGoto` runs on the new page before the board loads
 * (request tracking that must see the page's very first requests). The caller closes the context.
 */
export async function openInstrumented(
  browser: Browser,
  board: string,
  user: TestUser,
  beforeGoto: (page: Page, context: BrowserContext) => void | Promise<void>,
): Promise<Session> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  await beforeGoto(page, context)
  await page.goto(`/b/${board}`)
  await waitForBoard(page)
  return { user: user.handle, name: user.name, id: user.id, context, page }
}

// ---- comments (the comments feature's API, used as setup and as the "event-driven change") ------------------

/** Posts a new thread anchored to `shapeId` at (u, v) (default: its middle) as the API client's user; returns its id. */
export async function postThread(
  api: Api,
  board: string,
  shapeId: string,
  body: string,
  at: { u: number; v: number } = { u: 0.5, v: 0.5 },
): Promise<string> {
  const res = await api.fetch('POST', `/api/boards/${board}/threads`, {
    anchor: { kind: 'shape', shapeId, u: at.u, v: at.v },
    body,
  })
  expect(res.status(), await res.text()).toBe(201)
  const { thread } = (await res.json()) as { thread: { id: string } }
  return thread.id
}

// ---- what the server stored -------------------------------------------------------------------------------

export interface StoredShape {
  id: string
  type: string
  parentId: string
  meta: Record<string, unknown>
}

/**
 * The shapes the sync server holds for `board`, read through `GET /api/boards/:bid/export` (history
 * feature: the room's snapshot as a board archive). Proves persistence independently of any browser.
 */
export async function storedShapes(api: Api, board: string): Promise<Map<string, StoredShape>> {
  const res = await api.fetch('GET', `/api/boards/${board}/export`)
  expect(res.status(), 'board export').toBe(200)
  const archive = (await res.json()) as { records: (StoredShape & { typeName: string })[] }
  return new Map(archive.records.filter((r) => r.typeName === 'shape').map((r) => [r.id, r]))
}

/** Waits until the server stores every listed shape. */
export async function expectStored(api: Api, board: string, ids: string[]) {
  await expect
    .poll(
      async () => {
        const stored = await storedShapes(api, board)
        return ids.filter((id) => !stored.has(id))
      },
      { timeout: 15_000, message: 'shapes the server does not store' },
    )
    .toEqual([])
}

export const commentPin = (page: Page, threadId: string) =>
  page.locator(`[data-testid="comment-pin"][data-thread-id="${threadId}"]`)

// ---- visibility --------------------------------------------------------------------------------------------

/** How many of the matched elements are actually rendered visible (display, visibility and opacity). */
export const visibleCount = (locator: Locator) =>
  locator.evaluateAll(
    (els) =>
      els.filter((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true })).length,
  )

// ---- an uploaded image inside a frame ------------------------------------------------------------------------

const STABLE_REF = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/original$/
const DERIVATIVE_SRC = /^\/files\/ast_[0-9A-Za-z]{20}\/ver_[0-9A-Za-z]{20}\/d\/drv_[0-9A-Za-z]{20}\?board=/

/**
 * Uploads the 1920×1080 fixture through the real "Insert file" flow, moves it into `frameId` at `box`
 * (frame-relative) and waits until the canvas shows it from a (small, webp) preview derivative, so that
 * any /files request made afterwards comes from an export, not from the canvas.
 */
export async function placeUploadedImage(page: Page, frameId: string, box: BoxLike): Promise<string> {
  await insertFiles(page, [join(FIXTURES_DIR, 'image.png')])
  const imageId = await waitForValue(
    async () => (await pageShapes(page)).find((s) => s.type === 'image')?.id,
    {
      timeout: 30_000,
    },
  )
  await expect
    .poll(
      async () => {
        const doc = await boardDocument(page)
        const asset = doc.assets[String(doc.shapes[imageId]?.props.assetId)] as
          | { props?: { src?: unknown } }
          | undefined
        return asset?.props?.src ?? null
      },
      { timeout: 30_000, message: 'upload finished (stable file reference stored)' },
    )
    .toMatch(STABLE_REF)
  await edit(
    page,
    (ed, arg) => {
      ;(ed as unknown as PresentEditor).reparentShapes([arg.id], arg.frameId)
      ed.updateShape({
        id: arg.id,
        type: 'image',
        x: arg.box.x,
        y: arg.box.y,
        props: { w: arg.box.w, h: arg.box.h },
      })
      ed.zoomToFit()
    },
    { id: imageId, frameId, box },
  )
  const img = page.locator(`[data-shape-id="${imageId}"] img.tl-image`)
  await expect(img).toHaveAttribute('src', DERIVATIVE_SRC, { timeout: 30_000 })
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  return imageId
}
