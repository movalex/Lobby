// Editor-side rendering for exports (browser only), on tldraw 5.4.2's export pipeline
// (`editor.toImage` → `getSvgString` → `getSvgAsImage`, and `copyAs` for the clipboard).
//
// Best image source: tldraw resolves assets for an export with `shouldResolveToOriginal` exactly when
// the export's `pixelRatio` is null/undefined (getSvgJsx: `shouldResolveToOriginal: pixelRatio === null`);
// our asset store then returns the uploaded original instead of the canvas-sized derivative. Every export
// here therefore passes `pixelRatio: undefined` explicitly (toImage would otherwise default it to 2). The
// bitmap is then drawn at tldraw's default 2× pixel ratio, so `scale` is halved to get N× output.
import { Box, copyAs, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { readSessionSettings } from '../workshops/session-settings.ts'
import type { FrameEntry } from './board-ops.ts'
import { stripNoteAuthors } from './note-authors.ts'
import { bookmarkTitle, isWinAnsi, type PdfTextItem } from './pdf-build.ts'
import { createPdfBuilderOffThread } from './pdf-client.ts'
import {
  PDF_RASTER,
  type PdfPageFormat,
  type PdfPagePlan,
  pdfRasterScale,
  planPdfPage,
} from './pdf-layout.ts'
import { setPngDensity } from './png-density.ts'
import { hiddenUnderImage, OCCLUDING_TYPES, placedTextFor } from './text-layer.ts'

export type ImageScale = 1 | 2 | 4
export const IMAGE_SCALES: readonly ImageScale[] = [1, 2, 4]

/** tldraw rasterizes exports at this pixel ratio when none is given (getSvgAsImageWithOptions). */
const TLDRAW_DEFAULT_PIXEL_RATIO = 2
const BOARD_PAGE_PADDING = 32

/**
 * The editor as exports use it. While the session hides note authors (workshops' "Hide note authors",
 * RETRO-03a), the SVG every export is made from comes without them: `toImage` and `copyAs` build
 * their SVG through `getSvgString`, so a view of the editor whose getSvgString strips the names is
 * enough for PNG, SVG, PDF and the clipboard alike (tldraw's own rasterizing and trimming unchanged).
 */
export function exportEditor(editor: Editor): Editor {
  if (!readSessionSettings(editor).hideNoteAuthors) return editor
  const view = Object.create(editor) as Editor
  view.getSvgString = async (shapes, opts) => {
    const result = await editor.getSvgString(shapes, opts)
    return result && { ...result, svg: stripNoteAuthors(result.svg) }
  }
  return view
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}

export async function renderPng(
  editor: Editor,
  ids: TLShapeId[],
  opts: { scale: ImageScale; transparent: boolean },
): Promise<Blob> {
  const { blob } = await exportEditor(editor).toImage(ids, {
    format: 'png',
    scale: opts.scale / TLDRAW_DEFAULT_PIXEL_RATIO,
    pixelRatio: undefined, // originals, see the header comment
    background: !opts.transparent,
    darkMode: false,
  })
  // Mark the PNG as N× (pHYs = 72 dpi × N), so apps that honour it show it at board size, N× sharper.
  // Replaces the pHYs tldraw wrote at its own pixel ratio (PngHelpers.setPhysChunk would add a second
  // one, and decoders keep the first: see png-density.ts).
  const bytes = setPngDensity(new Uint8Array(await blob.arrayBuffer()), opts.scale)
  return new Blob([bytes as BlobPart], { type: 'image/png' })
}

export async function renderSvg(
  editor: Editor,
  ids: TLShapeId[],
  opts: { transparent: boolean },
): Promise<Blob> {
  // SVG exports default to pixelRatio undefined: originals, embedded as data URLs (self-contained file).
  const { blob } = await exportEditor(editor).toImage(ids, {
    format: 'svg',
    scale: 1,
    background: !opts.transparent,
    darkMode: false,
  })
  return blob
}

/**
 * Copies the shapes as a PNG (2×, originals). Synchronous up to the clipboard write, as Safari requires
 * (copyAs hands the clipboard a promise of the blob).
 */
export function copyPng(
  editor: Editor,
  ids: TLShapeId[],
  opts: { transparent?: boolean } = {},
): Promise<void> {
  return copyAs(exportEditor(editor), ids, {
    format: 'png',
    pixelRatio: undefined,
    background:
      opts.transparent === undefined ? editor.getInstanceState().exportBackground : !opts.transparent,
    darkMode: false,
  })
}

export type PdfPageSpec =
  | { kind: 'frame'; frame: FrameEntry; title: string }
  | { kind: 'board'; title: string }

export interface PdfProgress {
  done: number
  total: number
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 16))

function textsFor(editor: Editor, rootIds: TLShapeId[], origin: Box): PdfTextItem[] {
  const items: PdfTextItem[] = []
  // Paint order (tldraw sorts the page's shapes the way it draws them), for text hidden under images.
  const order = new Map<TLShapeId, number>()
  editor.getCurrentPageShapesSorted().forEach((s, i) => {
    order.set(s.id, i)
  })
  const shapes: { shape: TLShape; bounds: Box }[] = []
  for (const id of editor.getShapeAndDescendantIds(rootIds)) {
    const shape = editor.getShape(id) as TLShape | undefined
    if (!shape) continue
    // Masked = the part inside its frame; undefined when the frame clips it away entirely.
    const bounds = editor.getShapeMaskedPageBounds(id)
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) continue
    shapes.push({ shape, bounds })
  }
  const images = shapes
    .filter(({ shape }) => OCCLUDING_TYPES.has(shape.type))
    .map(({ shape, bounds }) => ({ bounds, order: order.get(shape.id) ?? -1 }))
  for (const { shape, bounds } of shapes) {
    if (hiddenUnderImage({ bounds, order: order.get(shape.id) ?? -1 }, images)) continue
    const placed = placedTextFor(shape, bounds, origin)
    if (placed) items.push(placed)
  }
  return items
}

const TITLE_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
/** Pixels per PDF point for a browser-drawn page title (sharp when printed). */
const TITLE_PX_PER_PT = 4

/**
 * A page title the PDF's standard font cannot show (emoji, CJK…), drawn by the browser with the app's
 * font as a PNG for the page's header band (pdf-build places it; the hidden text layer keeps what
 * encodes). Null when there is no canvas.
 */
async function titleImage(
  title: string,
  plan: PdfPagePlan,
): Promise<{ bytes: Uint8Array; widthPt: number; heightPt: number } | null> {
  if (typeof document === 'undefined') return null
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
    while (chars.length > 1 && ctx.measureText(`${chars.join('')}\u2026`).width > maxWidth) chars.pop()
    text = `${chars.join('').trimEnd()}\u2026`
  }
  canvas.width = Math.max(1, Math.ceil(Math.min(maxWidth, ctx.measureText(text).width) + 2))
  canvas.height = Math.max(1, Math.ceil(px * 1.35))
  ctx.font = font // resizing resets the context
  ctx.fillStyle = '#1b2330'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 0, canvas.height / 2, maxWidth)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    widthPt: canvas.width / TITLE_PX_PER_PT,
    heightPt: canvas.height / TITLE_PX_PER_PT,
  }
}

/**
 * One PDF page per spec: a header band with the frame's title, and the frame's content (tldraw's
 * single-frame export: no frame title or border, the frame's fill as background) rendered at
 * `pdfRasterScale` for the size it is printed at (≥ 2×, 3× for ordinary frames on their own page),
 * on frame-sized pages or the same 16:9 / A4 landscape page for every frame (`pageFormat`), plus a
 * hidden text layer. Yields to the browser between pages and checks `signal` so a long export stays
 * responsive and can be cancelled.
 */
export async function renderPdf(
  editor: Editor,
  pages: readonly PdfPageSpec[],
  opts: {
    title: string
    lossless: boolean
    pageFormat?: PdfPageFormat
    signal?: AbortSignal
    onProgress?(p: PdfProgress): void
  },
): Promise<Blob> {
  const pageFormat = opts.pageFormat ?? 'fit'
  // pdf-lib runs in a worker (main-thread fallback): only tldraw's rendering stays on this thread.
  const builder = await createPdfBuilderOffThread({ title: opts.title })
  try {
    const total = pages.length
    for (let i = 0; i < total; i++) {
      opts.onProgress?.({ done: i, total })
      await nextTask()
      if (opts.signal?.aborted) throw new ExportCancelled()
      const spec = pages[i] as PdfPageSpec
      let ids: TLShapeId[]
      let bounds: Box | undefined
      if (spec.kind === 'frame') {
        ids = [spec.frame.id]
        bounds = editor.getShapePageBounds(spec.frame.id)
      } else {
        ids = [...editor.getCurrentPageShapeIds()]
        bounds = editor.getCurrentPageBounds()?.clone().expandBy(BOARD_PAGE_PADDING)
      }
      if (!bounds || ids.length === 0 || bounds.w <= 0 || bounds.h <= 0) continue // deleted meanwhile
      const plan = planPdfPage(bounds.w, bounds.h, pageFormat)
      const raster = pdfRasterScale(bounds.w, bounds.h, PDF_RASTER, plan.ptPerPx)
      const format = opts.lossless ? 'png' : 'jpeg'
      const { blob } = await exportEditor(editor).toImage(ids, {
        format,
        quality: 0.92,
        scale: raster / TLDRAW_DEFAULT_PIXEL_RATIO,
        pixelRatio: undefined, // originals
        background: true,
        darkMode: false,
        bounds: new Box(bounds.x, bounds.y, bounds.w, bounds.h),
      })
      if (opts.signal?.aborted) throw new ExportCancelled()
      const title = bookmarkTitle(spec.title, builder.pageCount)
      const headerImage = isWinAnsi(title) ? null : await titleImage(title, plan)
      await builder.addPage({
        title,
        format: pageFormat,
        widthPx: bounds.w,
        heightPx: bounds.h,
        image: { bytes: new Uint8Array(await blob.arrayBuffer()), type: format },
        ...(headerImage ? { headerImage } : {}),
        texts: textsFor(editor, ids, bounds),
      })
    }
    if (builder.pageCount === 0) throw new Error('Nothing to export: the frames were removed.')
    opts.onProgress?.({ done: total, total })
    await nextTask()
    const bytes = await builder.finish()
    return new Blob([bytes as BlobPart], { type: 'application/pdf' })
  } finally {
    builder.dispose()
  }
}
