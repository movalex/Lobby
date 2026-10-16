// OWNER: WS3 (wave T). The storyboard PDF sheet (the design §3.2) with the client PDF pipeline, as the review summary
// does (../review-summary/build.ts): the pages of ./layout.ts go to the PDF worker (pdf-client.ts
// createPdfBuilderOffThread: pdf-lib never loads on the board's thread) as VECTOR pages (real, searchable text in the
// PDF's Helvetica, the pictures as image objects); a page the vector drawing cannot make is an image page with the
// invisible text layer instead, and the result says which. Pictures are drawn one page at a time (a 600-panel
// storyboard never holds more than one page of pictures).
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import type { StoryboardView } from '../../storyboard-play/model.ts'
import { bookmarkTitle } from '../pdf-text.ts'
import { ExportCancelled } from '../ported/exporter.ts'
import type { MeasureText, SummaryPage } from '../review-summary/layout.ts'
import { pageToSvg } from '../review-summary/svg.ts'
import {
  layoutSheet,
  placePictures,
  type SheetInput,
  type SheetPage,
  type SheetPerPage,
  type SheetPicture,
} from './layout.ts'
import { sheetPicture } from './pictures.ts'

/** The longest side a picture is printed from, per layout (px). */
export const SHEET_PICTURE_SIDE: Readonly<Record<SheetPerPage, number>> = { 2: 1400, 3: 1000, 6: 700 }

export interface SheetResult {
  readonly blob: Blob
  readonly pageCount: number
  /** panels not printed because of the page limit */
  readonly notShown: number
  /** the 1-based pages drawn as images instead of vector pages, with why */
  readonly imagePages: readonly { readonly page: number; readonly reason: string }[]
}

/** What the sheet prints of a storyboard. */
export function sheetInput(view: StoryboardView, boardTitle: string, date: string): SheetInput {
  return {
    title: view.title,
    boardTitle,
    date,
    totalMs: view.totalMs,
    ratio: view.ratio,
    panels: view.panels.map((p) => ({
      number: p.number,
      name: p.name,
      startMs: p.startMs,
      durationMs: p.durationMs,
      fields: p.fields,
      hasPicture: p.picture !== null,
    })),
  }
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export async function makeStoryboardSheet(args: {
  readonly canvas: LobbyCanvas
  readonly view: StoryboardView
  readonly perPage: SheetPerPage
  readonly boardTitle: string
  readonly date: string
  readonly measure: MeasureText
  readonly signal?: AbortSignal
  readonly onProgress?: (p: { done: number; total: number }) => void
}): Promise<SheetResult> {
  const { canvas, view, perPage, signal } = args
  const { pages, notShown } = layoutSheet(sheetInput(view, args.boardTitle, args.date), perPage, args.measure)
  if (signal?.aborted) throw new ExportCancelled()
  const [{ createPdfBuilderOffThread }, { pageTexts, pageToPng }] = await Promise.all([
    import('../pdf-client.ts'),
    import('../review-summary/raster.ts'),
  ])
  const builder = await createPdfBuilderOffThread({ title: view.title })
  const stop = () => builder.dispose()
  signal?.addEventListener('abort', stop, { once: true })
  const imagePages: { page: number; reason: string }[] = []
  try {
    for (const [i, page] of pages.entries()) {
      args.onProgress?.({ done: i, total: pages.length })
      await nextTask()
      if (signal?.aborted) throw new ExportCancelled()
      const pictures = await pagePictures(canvas, view, page, SHEET_PICTURE_SIDE[perPage], signal)
      const drawn: SummaryPage = {
        title: page.title,
        width: page.width,
        height: page.height,
        ops: placePictures(page.ops, (n) => pictures.get(n) ?? null),
      }
      pictures.clear()
      const title = bookmarkTitle(page.title, builder.pageCount)
      const outcome = await builder.addVectorPage({
        title,
        format: 'fit',
        widthPx: page.width,
        heightPx: page.height,
        svg: pageToSvg(drawn),
      })
      if (signal?.aborted) throw new ExportCancelled()
      if (outcome.vector) continue
      imagePages.push({ page: builder.pageCount + 1, reason: outcome.reason })
      await builder.addPage({
        title,
        format: 'fit',
        widthPx: page.width,
        heightPx: page.height,
        image: { bytes: await pageToPng(drawn), type: 'png' },
        texts: pageTexts(drawn, args.measure),
      })
    }
    args.onProgress?.({ done: pages.length, total: pages.length })
    if (signal?.aborted) throw new ExportCancelled()
    const pageCount = builder.pageCount
    const bytes = await builder.finish()
    return {
      blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
      pageCount,
      notShown,
      imagePages,
    }
  } catch (e) {
    if (signal?.aborted) throw new ExportCancelled()
    throw e
  } finally {
    signal?.removeEventListener('abort', stop)
    builder.dispose()
  }
}

/** The pictures of one page's panels (by panel index). */
async function pagePictures(
  canvas: LobbyCanvas,
  view: StoryboardView,
  page: SheetPage,
  maxSide: number,
  signal: AbortSignal | undefined,
): Promise<Map<number, SheetPicture>> {
  const out = new Map<number, SheetPicture>()
  for (const n of page.panels) {
    if (signal?.aborted) throw new ExportCancelled()
    const picture = view.panels[n]?.picture
    if (!picture) continue
    const drawn = await sheetPicture(canvas, picture, maxSide)
    if (drawn) out.set(n, drawn)
  }
  return out
}
