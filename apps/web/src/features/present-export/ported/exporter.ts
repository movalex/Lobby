// Exports on the Excalidraw page (docs/EXCALIDRAW-MIGRATION.md §4.5): the port of ../export-render.ts onto
// `LobbyCanvas.export` (canvas/api/parts/export.ts: Excalidraw's exporters with export-only files maps and
// Lobby's own font embedding). Same rules as the tldraw page:
//  - PNG, the clipboard and PDF pages draw uploaded images from their ORIGINAL uploads; SVG embeds the
//    2,048 px previews unless the person asks for the originals (F15);
//  - a PNG exported at N× says so (one pHYs chunk: N × 72 dpi, ../png-density.ts);
//  - a board or a selection gets a 32 px margin (F15); a single frame or a single image is its own export
//    bounds, unpadded;
//  - revealed vote results are drawn as on the board, and so is every other overlay layer registered for exports
//    (./badges.ts, the export-overlay registry of wave T);
//  - a PDF can end with a vote results page and a comments appendix (RETRO-05b, ./report.ts): text pages the
//    browser draws (any script, as a page title is) with the same searchable text layer as a frame's page;
//  - wave N (N6-3/N6-4): a PDF's frame pages can be VECTOR pages (`pagesKind: 'vector'`): the frame's SVG with
//    `fonts: 'names'` and its images as display copies, drawn in the PDF worker with embedded subsets of Lobby's
//    fonts (../vector/vector-page.ts). A frame the vector drawing cannot reproduce faithfully is drawn as today's
//    image page instead, and the result names those pages (`imagePages`).
// Hide note authors (RETRO-03a; 3f's `workshopSettingsOf(canvas).hideNoteAuthors`) needs nothing here:
// notes on the new canvas draw no author name (CR-3F-4), exports draw no overlay but the registered export layers
// (./badges.ts; none draws an author), and the engine's
// exports embed no scene data (canvas/export/scene.ts `exportEmbedScene: false`), so the server's
// attribution (`customData.lobbyServer`) never reaches a PNG, SVG, PDF or the clipboard, whatever the
// setting. workshops-facilitation.spec.ts RETRO-03a checks the files.
import type { Bounds, CanvasElement, ExportOptions, LobbyCanvas } from '../../../canvas/api/index.ts'
import type { PdfTextItem } from '../pdf-build.ts'
import type { PdfTimeLimits } from '../pdf-client.ts'
import { PDF_RASTER, type PdfPageFormat, pdfRasterScale, planPdfPage } from '../pdf-layout.ts'
import { setPngDensity } from '../png-density.ts'
import { drawOverlays, exportOrigin, exportOverlaysActive, svgWithOverlays } from './badges.ts'
import type { ElementFrameEntry } from './frames.ts'
import {
  type FontWeight,
  layoutReport,
  type Measure,
  REPORT_PAGE_PX,
  type ReportBlock,
  type ReportPage,
} from './report.ts'

export type ImageScale = 1 | 2 | 4
export const IMAGE_SCALES: readonly ImageScale[] = [1, 2, 4]
/** Board units of margin around a PNG/SVG/copied selection or whole board (F15). */
export const EXPORT_PADDING = 32
const BOARD_PAGE_PADDING = 32

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}

/** What an image export covers: the ids (empty: the whole board) and how to frame them. */
export interface ImageTarget {
  readonly ids: readonly string[]
  /** export this frame as the engine's frame export */
  readonly frameId?: string
  /** file-name qualifier: the frame's name, 'frame' or 'selection' (none for the whole board) */
  readonly qualifier?: string
}

const frameName = (el: CanvasElement | undefined) => {
  const name = (el as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name.trim() ? name : 'frame'
}

/** The selection (or the board) as an export target; one selected frame is that frame (F15). */
export function exportTarget(canvas: LobbyCanvas, scope: 'selection-or-board' | 'board'): ImageTarget {
  const selected = scope === 'board' ? [] : [...canvas.selection]
  if (selected.length === 0) return { ids: [] }
  if (selected.length === 1) {
    const el = canvas.get(selected[0] as string)
    if (el?.type === 'frame') return { ids: selected, frameId: el.id, qualifier: frameName(el) }
  }
  return { ids: selected, qualifier: 'selection' }
}

/** A frame as an export target. */
export const frameTarget = (canvas: LobbyCanvas, frameId: string): ImageTarget => ({
  ids: [frameId],
  frameId,
  qualifier: frameName(canvas.get(frameId)),
})

/** The export options of a target: a frame alone, one image unpadded, anything else with the margin. */
export function targetOptions(canvas: LobbyCanvas, t: ImageTarget): ExportOptions {
  if (t.frameId) return { frameId: t.frameId }
  if (t.ids.length === 0) return { padding: EXPORT_PADDING }
  const only = t.ids.length === 1 ? canvas.get(t.ids[0] as string) : undefined
  return { ids: t.ids, padding: only?.type === 'image' ? 0 : EXPORT_PADDING }
}

/**
 * The elements an export of `t` draws (with bound labels and frame children), for badges, the origin
 * and the originals' size.
 */
export function targetElements(canvas: LobbyCanvas, t: ImageTarget): CanvasElement[] {
  const live = canvas.items().filter((e) => !canvas.isHidden(e.id))
  if (t.ids.length === 0 && !t.frameId) return [...live]
  const keep = new Set(t.frameId ? [t.frameId] : t.ids)
  for (let grew = true; grew; ) {
    grew = false
    for (const e of live) {
      if (keep.has(e.id)) continue
      if (
        (e.type === 'text' && e.containerId && keep.has(e.containerId)) ||
        (e.frameId && keep.has(e.frameId))
      ) {
        keep.add(e.id)
        grew = true
      }
    }
  }
  return live.filter((e) => keep.has(e.id))
}

/** The bytes of the original uploads of the images in `t` (for the SVG option's label). */
export function originalBytes(canvas: LobbyCanvas, t: ImageTarget): number {
  const seen = new Set<string>()
  let total = 0
  for (const e of targetElements(canvas, t)) {
    if (e.type !== 'image') continue
    const f = e.customData?.lobby?.file as
      | { versionId?: unknown; kind?: unknown; sizeBytes?: unknown }
      | undefined
    if (f?.kind !== 'image' || typeof f.versionId !== 'string' || seen.has(f.versionId)) continue
    seen.add(f.versionId)
    if (typeof f.sizeBytes === 'number' && f.sizeBytes > 0) total += f.sizeBytes
  }
  return total
}

/** Where an export of `t` starts in scene coordinates, from its drawn size (./badges.ts exportOrigin). */
function originOf(
  canvas: LobbyCanvas,
  t: ImageTarget,
  opts: ExportOptions,
  size: { width: number; height: number },
) {
  if (t.frameId) {
    const b = canvas.bounds(t.frameId)
    return b ? { x: b.x, y: b.y } : { x: 0, y: 0 }
  }
  if (opts.bounds) return { x: opts.bounds.x, y: opts.bounds.y }
  const boxes = targetElements(canvas, t)
    .map((e) => canvas.bounds(e.id))
    .filter((b): b is Bounds => !!b)
  return exportOrigin(boxes, size, opts.padding ?? 0)
}

/** The ids an export of `t` draws (what an overlay layer draws for). */
const exportedIds = (canvas: LobbyCanvas, t: ImageTarget) =>
  new Set(targetElements(canvas, t).map((e) => e.id))

/** The export as a bitmap with the overlay layers (vote badges, …) drawn on it. */
async function bitmap(canvas: LobbyCanvas, t: ImageTarget, opts: ExportOptions): Promise<HTMLCanvasElement> {
  const c = await canvas.export.canvas(opts)
  if (exportOverlaysActive(canvas)) {
    const scale = opts.scale ?? 1
    const origin = originOf(canvas, t, opts, { width: c.width / scale, height: c.height / scale })
    await drawOverlays(c, { canvas, exported: exportedIds(canvas, t), origin }, scale)
  }
  return c
}

const blobOf = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas gave no image'))), type, quality),
  )

async function pngFrom(c: HTMLCanvasElement, scale: number): Promise<Blob> {
  const bytes = setPngDensity(new Uint8Array(await (await blobOf(c, 'image/png')).arrayBuffer()), scale)
  return new Blob([bytes as BlobPart], { type: 'image/png' })
}

export async function renderPng(
  canvas: LobbyCanvas,
  t: ImageTarget,
  opts: { scale: ImageScale; transparent: boolean },
): Promise<Blob> {
  const o: ExportOptions = {
    ...targetOptions(canvas, t),
    scale: opts.scale,
    background: !opts.transparent,
    theme: 'light',
    files: 'original',
  }
  return pngFrom(await bitmap(canvas, t, o), opts.scale)
}

/** An exported SVG's drawn size (its viewBox). */
function svgSize(svg: string): { width: number; height: number } {
  const m = /viewBox="\s*[\d.e+-]+[\s,]+[\d.e+-]+[\s,]+([\d.e+-]+)[\s,]+([\d.e+-]+)/.exec(svg)
  return { width: Number(m?.[1] ?? 0), height: Number(m?.[2] ?? 0) }
}

export async function renderSvg(
  canvas: LobbyCanvas,
  t: ImageTarget,
  opts: { transparent: boolean; originals?: boolean },
): Promise<Blob> {
  const o: ExportOptions = {
    ...targetOptions(canvas, t),
    background: !opts.transparent,
    theme: 'light',
    files: opts.originals === true ? 'original' : 'display',
  }
  let svg = await canvas.export.svg(o)
  if (exportOverlaysActive(canvas))
    svg = svgWithOverlays(svg, {
      canvas,
      exported: exportedIds(canvas, t),
      origin: originOf(canvas, t, o, svgSize(svg)),
    })
  return new Blob([svg], { type: 'image/svg+xml' })
}

/**
 * Copies the target as a PNG (2×, originals). The clipboard write starts inside the click or key press
 * (Safari requires it); the bytes follow.
 */
export function copyPng(
  canvas: LobbyCanvas,
  t: ImageTarget,
  opts: { transparent?: boolean } = {},
): Promise<void> {
  const clip = navigator.clipboard
  if (!clip?.write || typeof ClipboardItem === 'undefined')
    return Promise.reject(new Error('the clipboard cannot take images here'))
  const png = renderPng(canvas, t, { scale: 2, transparent: opts.transparent === true })
  return clip.write([new ClipboardItem({ 'image/png': png })])
}

// ---- PDF -------------------------------------------------------------------------------------------------

export type PdfPageSpec =
  | { kind: 'frame'; frame: ElementFrameEntry; title: string }
  | { kind: 'board'; title: string }
  /** a text page laid out by ./report.ts (the vote results, the comments appendix) */
  | { kind: 'report'; title: string; page: ReportPage }

export interface PdfProgress {
  done: number
  total: number
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 16))

type Align = 'start' | 'middle' | 'end'
const alignOf = (v: unknown): Align => (v === 'center' ? 'middle' : v === 'right' ? 'end' : 'start')

/** Elements that hide what is under them on a page (photos, file-card faces). */
const OCCLUDING_TYPES = new Set(['image'])
/** A file card face's footer height and where its name starts (file-card's CSS: 10 + 34 + 10 px). */
const CARD_FOOTER_PX = 56
const CARD_NAME_LEFT_PX = 54

/**
 * The hidden text layer of one PDF page: every text element (free text and labels: their own box,
 * size and alignment) and each file card's name at its top-left, relative to `origin`, clipped by its
 * frame, leaving out text an image drawn later covers whole. Frame names are left out (the page's header
 * band has the title).
 */
export function pageTexts(
  canvas: LobbyCanvas,
  members: readonly CanvasElement[],
  origin: Bounds,
  /** wave N (N6-3): only the file cards' names (a vector page's text is real text already) */
  opts: { cardsOnly?: boolean } = {},
): PdfTextItem[] {
  const order = new Map(canvas.items().map((e, i) => [e.id, i]))
  const boxes: { el: CanvasElement; b: Bounds; order: number }[] = []
  for (const el of members) {
    const b = canvas.visibleBounds(el.id)
    if (!b || b.width <= 0 || b.height <= 0) continue
    boxes.push({ el, b, order: order.get(el.id) ?? -1 })
  }
  const images = boxes.filter((x) => OCCLUDING_TYPES.has(x.el.type))
  const covered = (x: { b: Bounds; order: number }) =>
    images.some(
      (i) =>
        i.order > x.order &&
        i.b.x <= x.b.x &&
        i.b.y <= x.b.y &&
        i.b.x + i.b.width >= x.b.x + x.b.width &&
        i.b.y + i.b.height >= x.b.y + x.b.height,
    )
  const items: PdfTextItem[] = []
  for (const x of boxes) {
    if (covered(x)) continue
    const base = { x: x.b.x - origin.x, y: x.b.y - origin.y, w: x.b.width, h: x.b.height }
    if (x.el.type === 'text') {
      if (opts.cardsOnly) continue
      const t = x.el as CanvasElement & {
        originalText?: string
        text?: string
        fontSize?: number
        textAlign?: string
        lineHeight?: number
      }
      // W5-30: the engine's own lines (`text` is `originalText` wrapped to the element's width), drawn
      // line by line: the PDF's Helvetica is wider than the canvas's fonts, so wrapping again in the box
      // split words ("Stor" / "y") and a search for them found nothing.
      const wrapped = typeof t.text === 'string' && t.text.trim() ? t.text : (t.originalText ?? '')
      const text = wrapped.trimEnd()
      if (!text.trim()) continue
      items.push({
        ...base,
        text,
        fontSizePx: typeof t.fontSize === 'number' && t.fontSize > 0 ? t.fontSize : 16,
        align: alignOf(t.textAlign),
        verticalAlign: 'start',
        inset: 0,
        lines: true,
        ...(typeof t.lineHeight === 'number' && t.lineHeight > 0 ? { lineHeight: t.lineHeight } : {}),
      })
    } else if (x.el.type === 'image') {
      const f = x.el.customData?.lobby?.file as { kind?: unknown; name?: unknown } | undefined
      if (!f || f.kind === 'image' || typeof f.name !== 'string' || !f.name.trim()) continue
      // The name sits in the card face's footer (the export draws the face: canvas/api/parts/export-faces.ts):
      // the bottom 56 px, right of the 34 px kind badge; an attachment's footer is the whole card.
      const footer = f.kind === 'other' ? base.h : Math.min(base.h, CARD_FOOTER_PX)
      items.push({
        x: base.x + CARD_NAME_LEFT_PX,
        y: base.y + base.h - footer,
        w: Math.max(1, base.w - CARD_NAME_LEFT_PX - 10),
        h: footer,
        text: f.name.trim(),
        fontSizePx: 13.5,
        align: 'start',
        verticalAlign: 'middle',
        inset: 0,
      })
    }
  }
  return items
}

const TITLE_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
/** Pixels per PDF point for a browser-drawn page title (sharp when printed). */
const TITLE_PX_PER_PT = 4

/**
 * A page title the PDF's standard font cannot show (emoji, CJK…), drawn by the browser with the app's
 * font as a PNG for the page's header band (as ../export-render.ts does).
 */
async function titleImage(
  title: string,
  plan: ReturnType<typeof planPdfPage>,
): Promise<{ bytes: Uint8Array; widthPt: number; heightPt: number } | null> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const px = plan.header.fontSize * TITLE_PX_PER_PT
  const font = `600 ${px}px ${TITLE_FONT}`
  const maxWidth = (plan.header.width - plan.header.padX * 2) * TITLE_PX_PER_PT
  ctx.font = font
  let text = title
  if (ctx.measureText(text).width > maxWidth) {
    const chars = Array.from(text)
    while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop()
    text = `${chars.join('').trimEnd()}…`
  }
  canvas.width = Math.max(1, Math.ceil(Math.min(maxWidth, ctx.measureText(text).width) + 2))
  canvas.height = Math.max(1, Math.ceil(px * 1.35))
  ctx.font = font
  ctx.fillStyle = '#1b2330'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 0, canvas.height / 2, maxWidth)
  const blob = await blobOf(canvas, 'image/png').catch(() => null)
  if (!blob) return null
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    widthPt: canvas.width / TITLE_PX_PER_PT,
    heightPt: canvas.height / TITLE_PX_PER_PT,
  }
}

/** Pixels per report px a text page is drawn at (the frames' own preferred PDF raster). */
const REPORT_RASTER = PDF_RASTER.preferred

const reportFont = (weight: FontWeight, px: number) => `${weight} ${px}px ${TITLE_FONT}`

/** Measures text in the font the report pages are drawn in. */
function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')
  return (text, fontPx, weight) => {
    if (!ctx) return text.length * fontPx * 0.55
    ctx.font = reportFont(weight, fontPx)
    return ctx.measureText(text).width
  }
}

/**
 * The PDF pages of a report (RETRO-05b): `blocks` laid out on pages shaped for the page format (A4 portrait
 * for pages that fit their content, the landscape shape of 16:9 and A4 otherwise). `notShown` counts the items
 * past the page limit. Pages are titled `title`, with "(n of m)" when there are several.
 */
export function reportPdfPages(
  title: string,
  blocks: readonly ReportBlock[],
  format: PdfPageFormat,
): { specs: PdfPageSpec[]; notShown: number } {
  const { pages, notShown } = layoutReport(blocks, canvasMeasure(), REPORT_PAGE_PX[format])
  const specs: PdfPageSpec[] = pages.map((page, i) => ({
    kind: 'report',
    title: pages.length > 1 ? `${title} (${i + 1} of ${pages.length})` : title,
    page,
  }))
  return { specs, notShown }
}

/** The hidden text layer of a report page: its lines as laid out (never wrapped again). */
export function reportTexts(page: ReportPage): PdfTextItem[] {
  return page.lines.map((l) => ({
    text: l.text,
    x: l.x,
    y: l.y,
    w: Math.max(1, l.w),
    h: l.h,
    fontSizePx: l.fontPx,
    align: 'start',
    verticalAlign: 'start',
    inset: 0,
    lines: true,
    lineHeight: l.h / l.fontPx,
  }))
}

/** One report page drawn as a PNG: white paper, each line in its own font, size and colour. */
async function reportPng(page: ReportPage): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(page.width * REPORT_RASTER)
  canvas.height = Math.round(page.height * REPORT_RASTER)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('the browser cannot draw a page here')
  ctx.scale(REPORT_RASTER, REPORT_RASTER)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, page.width, page.height)
  ctx.textBaseline = 'middle'
  for (const l of page.lines) {
    ctx.font = reportFont(l.weight, l.fontPx)
    ctx.fillStyle = l.color
    ctx.fillText(l.text, l.x, l.y + l.h / 2)
  }
  return new Uint8Array(await (await blobOf(canvas, 'image/png')).arrayBuffer())
}

/**
 * One PDF page per spec (as ../export-render.ts `renderPdf`): a header band with the frame's title and
 * the frame's content (the engine's frame export: no title or outline) rendered at `pdfRasterScale` for
 * the size it is printed at, on frame-sized pages or the same 16:9 / A4 landscape page for every frame,
 * plus a hidden text layer. pdf-lib loads with the first PDF (§2.2: a lazy import, in a worker when it
 * can). Yields between pages and checks `signal`.
 */
/** How the frames' pages are drawn: vector (N6-3, sharp, real text) or images (today's raster pages). */
export type PdfPagesKind = 'vector' | 'image'

export interface PdfResult {
  readonly blob: Blob
  readonly pageCount: number
  /**
   * Vector exports: the 1-based numbers of the frame pages drawn as images instead (N6-4: effects the vector
   * drawing does not reproduce, a font that could not be embedded…; wave N.1: a page past its time limit, or every
   * frame page when the vector document could not be finished), with why. Empty for an image export.
   */
  readonly imagePages: readonly { readonly page: number; readonly reason: string }[]
}

/**
 * A vector document its builder could not finish (wave N.1): a vector page past its time limit (`page`: its spec's
 * index), or a builder step that failed (the file not written, the worker lost). The export makes it again.
 */
class VectorDocumentFailed extends Error {
  readonly page: number | null
  constructor(page: number | null) {
    super('the vector PDF could not be made')
    this.name = 'VectorDocumentFailed'
    this.page = page
  }
}

const isVectorPageTimeout = (e: unknown) => e instanceof Error && e.name === 'PdfVectorPageTimeout'

/** `p`, or ExportCancelled as soon as `signal` aborts (the step itself is stopped by the builder's dispose). */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new ExportCancelled())
    if (signal.aborted) cancel()
    signal.addEventListener('abort', cancel, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', cancel)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', cancel)
        reject(e)
      },
    )
  })
}

/** How one attempt draws the frames. */
interface PdfPlan {
  /** vector pages for the frames (else image pages) */
  readonly vector: boolean
  /** frames (by spec index) drawn as image pages in a vector document, and why */
  readonly asImages: ReadonlyMap<number, string>
  /** an image document made because the vector one could not be: every frame page is named, with this reason */
  readonly allImagesBecause?: string
}

type PdfOptions = {
  title: string
  lossless: boolean
  pageFormat?: PdfPageFormat
  /** default 'image' (today's pages) */
  pagesKind?: PdfPagesKind
  signal?: AbortSignal
  onProgress?(p: PdfProgress): void
  /** the builder's time limits (../pdf-client.ts PDF_TIME_LIMITS unless a test sets them) */
  limits?: Partial<PdfTimeLimits>
}

/** A frame's SVG for its vector page: fonts by name only (the worker embeds them), images as display copies. */
async function vectorSvg(canvas: LobbyCanvas, t: ImageTarget, o: ExportOptions): Promise<string> {
  const opts: ExportOptions = { ...o, background: true, theme: 'light', files: 'display', fonts: 'names' }
  const svg = await canvas.export.svg(opts)
  if (!exportOverlaysActive(canvas)) return svg
  return svgWithOverlays(svg, {
    canvas,
    exported: exportedIds(canvas, t),
    origin: originOf(canvas, t, opts, svgSize(svg)),
  })
}

/**
 * The PDF. A vector one its builder cannot finish (wave N.1) is made again: once with the page that went past its
 * time limit as an image page, then, if that fails too, with every frame as an image page (the dialog names them).
 */
export async function renderPdf(
  canvas: LobbyCanvas,
  pages: readonly PdfPageSpec[],
  opts: PdfOptions,
): Promise<PdfResult> {
  if (opts.pagesKind !== 'vector')
    return renderPdfOnce(canvas, pages, opts, { vector: false, asImages: new Map() })
  const asImages = new Map<number, string>()
  try {
    return await renderPdfOnce(canvas, pages, opts, { vector: true, asImages })
  } catch (e) {
    if (!(e instanceof VectorDocumentFailed)) throw e
    if (e.page !== null) {
      asImages.set(e.page, 'its vector drawing took too long')
      try {
        return await renderPdfOnce(canvas, pages, opts, { vector: true, asImages })
      } catch (again) {
        if (!(again instanceof VectorDocumentFailed)) throw again
      }
    }
  }
  const allImagesBecause = 'the vector PDF could not be finished'
  return renderPdfOnce(canvas, pages, opts, { vector: false, asImages: new Map(), allImagesBecause })
}

async function renderPdfOnce(
  canvas: LobbyCanvas,
  pages: readonly PdfPageSpec[],
  opts: PdfOptions,
  how: PdfPlan,
): Promise<PdfResult> {
  const pageFormat = opts.pageFormat ?? 'fit'
  const signal = opts.signal
  const imagePages: { page: number; reason: string }[] = []
  const [{ createPdfBuilderOffThread }, { bookmarkTitle, isWinAnsi }] = await Promise.all([
    import('../pdf-client.ts'),
    import('../pdf-text.ts'),
  ])
  if (signal?.aborted) throw new ExportCancelled()
  const builder = await createPdfBuilderOffThread({
    title: opts.title,
    ...(opts.limits ? { limits: opts.limits } : {}),
  })
  // Cancel stops the PDF worker at once, whatever page it is on; every wait for the builder ends with ExportCancelled
  const stop = () => builder.dispose()
  signal?.addEventListener('abort', stop, { once: true })
  /** One builder step: cancellable; in a vector document any failure gives the document up (made again). */
  const step = async <T>(p: Promise<T>, specIndex: number | null = null): Promise<T> => {
    try {
      return await abortable(p, signal)
    } catch (e) {
      if (signal?.aborted || e instanceof ExportCancelled) throw new ExportCancelled()
      if (how.vector) throw new VectorDocumentFailed(isVectorPageTimeout(e) ? specIndex : null)
      throw e
    }
  }
  try {
    const total = pages.length
    for (let i = 0; i < total; i++) {
      opts.onProgress?.({ done: i, total })
      await nextTask()
      if (signal?.aborted) throw new ExportCancelled()
      const spec = pages[i] as PdfPageSpec
      if (spec.kind === 'report') {
        const plan = planPdfPage(spec.page.width, spec.page.height, pageFormat)
        const title = bookmarkTitle(spec.title, builder.pageCount)
        const headerImage = isWinAnsi(title) ? null : await titleImage(title, plan)
        const bytes = await reportPng(spec.page)
        if (signal?.aborted) throw new ExportCancelled()
        await step(
          builder.addPage({
            title,
            format: pageFormat,
            widthPx: spec.page.width,
            heightPx: spec.page.height,
            image: { bytes, type: 'png' },
            ...(headerImage ? { headerImage } : {}),
            texts: reportTexts(spec.page),
          }),
        )
        continue
      }
      let target: ImageTarget
      let bounds: Bounds | null
      let o: ExportOptions
      if (spec.kind === 'frame') {
        target = { ids: [spec.frame.id], frameId: spec.frame.id }
        bounds = canvas.bounds(spec.frame.id)
        o = { frameId: spec.frame.id }
      } else {
        target = { ids: [] }
        const all = canvas.boundsOf()
        bounds = all
          ? {
              x: all.x - BOARD_PAGE_PADDING,
              y: all.y - BOARD_PAGE_PADDING,
              width: all.width + BOARD_PAGE_PADDING * 2,
              height: all.height + BOARD_PAGE_PADDING * 2,
            }
          : null
        o = bounds ? { bounds } : {}
      }
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue // deleted meanwhile
      const plan = planPdfPage(bounds.width, bounds.height, pageFormat)
      // the page's title and its header picture (a title the standard font cannot show), made once: a vector page
      // that falls back reuses them for its image page
      const title = bookmarkTitle(spec.title, builder.pageCount)
      const headerImage = isWinAnsi(title) ? null : await titleImage(title, plan)
      const forced = how.vector ? how.asImages.get(i) : how.allImagesBecause
      if (forced !== undefined) imagePages.push({ page: builder.pageCount + 1, reason: forced })
      else if (how.vector) {
        const svg = await vectorSvg(canvas, target, o).catch(() => null)
        if (signal?.aborted) throw new ExportCancelled()
        const outcome = svg
          ? await step(
              builder.addVectorPage({
                title,
                format: pageFormat,
                widthPx: bounds.width,
                heightPx: bounds.height,
                svg,
                // a copy: the PDF worker takes (transfers) the bytes it is sent
                ...(headerImage ? { headerImage: { ...headerImage, bytes: headerImage.bytes.slice() } } : {}),
                // only the file cards' names: the rest of a vector page's text is drawn as real text
                texts: pageTexts(canvas, targetElements(canvas, target), bounds, { cardsOnly: true }),
              }),
              i,
            )
          : { vector: false as const, reason: 'the frame’s drawing could not be made' }
        if (outcome.vector) continue
        // N6-4: this page as an image (today's page), and the dialog says so
        imagePages.push({ page: builder.pageCount + 1, reason: outcome.reason })
      }
      const raster = pdfRasterScale(bounds.width, bounds.height, PDF_RASTER, plan.ptPerPx)
      const format = opts.lossless ? 'png' : 'jpeg'
      const c = await bitmap(canvas, target, {
        ...o,
        scale: raster,
        background: true,
        theme: 'light',
        files: 'original',
      })
      if (signal?.aborted) throw new ExportCancelled()
      const blob = await blobOf(c, format === 'png' ? 'image/png' : 'image/jpeg', 0.92)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (signal?.aborted) throw new ExportCancelled()
      await step(
        builder.addPage({
          title,
          format: pageFormat,
          widthPx: bounds.width,
          heightPx: bounds.height,
          image: { bytes, type: format },
          ...(headerImage ? { headerImage } : {}),
          texts: pageTexts(canvas, targetElements(canvas, target), bounds),
        }),
      )
    }
    if (builder.pageCount === 0) throw new Error('Nothing to export: the frames were removed.')
    opts.onProgress?.({ done: total, total })
    await nextTask()
    if (signal?.aborted) throw new ExportCancelled()
    const pageCount = builder.pageCount
    const bytes = await step(builder.finish())
    return { blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), pageCount, imagePages }
  } finally {
    signal?.removeEventListener('abort', stop)
    builder.dispose()
  }
}
