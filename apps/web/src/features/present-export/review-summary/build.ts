// OWNER: WS4 (wave S, the review summary PDF). Makes the summary PDF (docs/WAVE-S-CONTRACTS.md §6) with the client PDF
// pipeline: the pages from ./layout.ts go to the PDF worker (pdf-client.ts createPdfBuilderOffThread, so pdf-lib never
// loads on the board's thread) as VECTOR pages (./svg.ts: real, selectable, searchable text in the PDF's Helvetica,
// the pictures as image objects). A page the vector drawing cannot make is added as an image page with the invisible
// text layer instead, and the result says which. The caller supplies the input (the model, the pictures) and the
// measuring function; nothing here knows the canvas or the api.
import type { ReviewSummaryModel } from '@draftroom/contracts'
import { bookmarkTitle } from '../pdf-text.ts'
import { layoutSummary, type MeasureText, type SummaryPage, type SummaryPicture } from './layout.ts'
import { pageToSvg } from './svg.ts'

export interface SummaryPdfArgs {
  readonly model: ReviewSummaryModel
  /** the picture of the n-th item, or null (a box saying there is no preview) */
  readonly pictures: (index: number) => SummaryPicture | null
  /** the PDF's title (document properties) */
  readonly title: string
  readonly measure: MeasureText
  readonly formatDate?: (iso: string) => string
  readonly signal?: AbortSignal
  readonly onProgress?: (p: { done: number; total: number }) => void
}

export interface SummaryPdfResult {
  readonly blob: Blob
  readonly pageCount: number
  /** items not printed because of the page limit */
  readonly notShown: number
  /** open comments not printed because an item ran past its pages */
  readonly cutThreads: number
  /** the 1-based pages drawn as images instead of vector pages, with why */
  readonly imagePages: readonly { readonly page: number; readonly reason: string }[]
}

export class SummaryCancelled extends Error {
  constructor() {
    super('Summary cancelled')
    this.name = 'SummaryCancelled'
  }
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** The pages of the summary PDF (also what the tests read). */
export function summaryPages(args: Pick<SummaryPdfArgs, 'model' | 'pictures' | 'measure' | 'formatDate'>): {
  pages: SummaryPage[]
  notShown: number
  cutThreads: number
} {
  return layoutSummary(args.model, args.pictures, args.measure, {
    ...(args.formatDate ? { formatDate: args.formatDate } : {}),
  })
}

export async function makeSummaryPdf(args: SummaryPdfArgs): Promise<SummaryPdfResult> {
  const { pages, notShown, cutThreads } = summaryPages(args)
  const signal = args.signal
  if (signal?.aborted) throw new SummaryCancelled()
  const [{ createPdfBuilderOffThread }, { pageTexts, pageToPng }] = await Promise.all([
    import('../pdf-client.ts'),
    import('./raster.ts'),
  ])
  const builder = await createPdfBuilderOffThread({ title: args.title })
  const stop = () => builder.dispose()
  signal?.addEventListener('abort', stop, { once: true })
  const imagePages: { page: number; reason: string }[] = []
  try {
    for (const [i, page] of pages.entries()) {
      args.onProgress?.({ done: i, total: pages.length })
      await nextTask()
      if (signal?.aborted) throw new SummaryCancelled()
      const title = bookmarkTitle(page.title, builder.pageCount)
      const outcome = await builder.addVectorPage({
        title,
        format: 'fit',
        widthPx: page.width,
        heightPx: page.height,
        svg: pageToSvg(page),
      })
      if (signal?.aborted) throw new SummaryCancelled()
      if (outcome.vector) continue
      imagePages.push({ page: builder.pageCount + 1, reason: outcome.reason })
      const bytes = await pageToPng(page)
      await builder.addPage({
        title,
        format: 'fit',
        widthPx: page.width,
        heightPx: page.height,
        image: { bytes, type: 'png' },
        texts: pageTexts(page, args.measure),
      })
    }
    args.onProgress?.({ done: pages.length, total: pages.length })
    if (signal?.aborted) throw new SummaryCancelled()
    const pageCount = builder.pageCount
    const bytes = await builder.finish()
    return {
      blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
      pageCount,
      notShown,
      cutThreads,
      imagePages,
    }
  } catch (e) {
    if (signal?.aborted) throw new SummaryCancelled()
    throw e
  } finally {
    signal?.removeEventListener('abort', stop)
    builder.dispose()
  }
}
