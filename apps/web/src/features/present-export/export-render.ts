// Editor-side rendering for exports (browser only), on tldraw 5.4.2's export pipeline
// (`editor.toImage` → `getSvgString` → `getSvgAsImage`, and `copyAs` for the clipboard).
//
// Best image source: tldraw resolves assets for an export with `shouldResolveToOriginal` exactly when
// the export's `pixelRatio` is null/undefined (getSvgJsx: `shouldResolveToOriginal: pixelRatio === null`);
// our asset store then returns the uploaded original instead of the canvas-sized derivative. Every export
// here therefore passes `pixelRatio: undefined` explicitly (toImage would otherwise default it to 2). The
// bitmap is then drawn at tldraw's default 2× pixel ratio, so `scale` is halved to get N× output.
import { Box, copyAs, type Editor, PngHelpers, type TLShape, type TLShapeId } from 'tldraw'
import type { FrameEntry } from './board-ops.ts'
import type { PdfTextItem } from './pdf-build.ts'
import { createPdfBuilderOffThread } from './pdf-client.ts'
import { pdfRasterScale } from './pdf-layout.ts'
import { placedTextFor } from './text-layer.ts'

export type ImageScale = 1 | 2 | 4
export const IMAGE_SCALES: readonly ImageScale[] = [1, 2, 4]

/** tldraw rasterizes exports at this pixel ratio when none is given (getSvgAsImageWithOptions). */
const TLDRAW_DEFAULT_PIXEL_RATIO = 2
const BOARD_PAGE_PADDING = 32

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
  const { blob } = await editor.toImage(ids, {
    format: 'png',
    scale: opts.scale / TLDRAW_DEFAULT_PIXEL_RATIO,
    pixelRatio: undefined, // originals, see the header comment
    background: !opts.transparent,
    darkMode: false,
  })
  // Mark the PNG as N× (pHYs = 72 dpi × N), so apps that honour it show it at board size, N× sharper.
  return PngHelpers.setPhysChunk(new DataView(await blob.arrayBuffer()), opts.scale, { type: 'image/png' })
}

export async function renderSvg(
  editor: Editor,
  ids: TLShapeId[],
  opts: { transparent: boolean },
): Promise<Blob> {
  // SVG exports default to pixelRatio undefined: originals, embedded as data URLs (self-contained file).
  const { blob } = await editor.toImage(ids, {
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
  return copyAs(editor, ids, {
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
  for (const id of editor.getShapeAndDescendantIds(rootIds)) {
    const shape = editor.getShape(id) as TLShape | undefined
    if (!shape) continue
    // Masked = the part inside its frame; undefined when the frame clips it away entirely.
    const bounds = editor.getShapeMaskedPageBounds(id)
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) continue
    const placed = placedTextFor(shape, bounds, origin)
    if (placed) items.push(placed)
  }
  return items
}

/**
 * One PDF page per spec: the frame's content (tldraw's single-frame export: no frame title or border,
 * the frame's fill as background) rendered at `pdfRasterScale` (≥ 2×, 3× for ordinary frames), plus a
 * hidden text layer. Yields to the browser between pages and checks `signal` so a long export stays
 * responsive and can be cancelled.
 */
export async function renderPdf(
  editor: Editor,
  pages: readonly PdfPageSpec[],
  opts: { title: string; lossless: boolean; signal?: AbortSignal; onProgress?(p: PdfProgress): void },
): Promise<Blob> {
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
      const raster = pdfRasterScale(bounds.w, bounds.h)
      const format = opts.lossless ? 'png' : 'jpeg'
      const { blob } = await editor.toImage(ids, {
        format,
        quality: 0.92,
        scale: raster / TLDRAW_DEFAULT_PIXEL_RATIO,
        pixelRatio: undefined, // originals
        background: true,
        darkMode: false,
        bounds: new Box(bounds.x, bounds.y, bounds.w, bounds.h),
      })
      if (opts.signal?.aborted) throw new ExportCancelled()
      await builder.addPage({
        title: spec.title,
        widthPx: bounds.w,
        heightPx: bounds.h,
        image: { bytes: new Uint8Array(await blob.arrayBuffer()), type: format },
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
