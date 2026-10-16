// OWNER: WS4 (wave S, the client review page). "Review summary (PDF)": gathers what the summary prints from the page
// (the items as listed, each one's status history, the board's open comments, the versions) and its pictures, and hands
// them to present-export/review-summary, which lays the pages out and makes the PDF with the client pipeline. The
// download is a file download like every export (the button is shown only to people whose export policy allows
// downloads). Loaded on demand: none of this is in the board's first load.
import type { CommentThread, ReviewEvent, ReviewRound } from '@draftroom/contracts'
import { derivativeUrl } from '../../assets/contract.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { mediaMetaStore } from '../../file-card/ported/meta.ts'
import { downloadBlob } from '../present-export/download.ts'
import { exportFilename } from '../present-export/filename.ts'
import { frameTarget, renderPng } from '../present-export/ported/exporter.ts'
import type { SummaryEntry } from '../present-export/review-summary/model.ts'
import { listAssetVersions } from '../review-viewer/versions/client.ts'
import { listReviewEvents } from './client.ts'
import { entryStanding, type PageEntry, resolvedCount, type ThreadScope, threadsFor } from './model.ts'
import { previewDerivative } from './picture.ts'

export interface SummaryProgress {
  readonly done: number
  readonly total: number
  readonly phase: 'collecting' | 'pictures' | 'pages'
}

export interface SummaryOutcome {
  readonly filename: string
  readonly pageCount: number
  readonly notShown: number
  readonly cutThreads: number
}

/** Runs `fn` over `items` with at most `n` at once; results in order. */
async function pool<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export async function downloadReviewSummary(args: {
  ctx: CanvasFeatureContext
  entries: readonly PageEntry[]
  round: ReviewRound | null
  threads: readonly CommentThread[]
  scopeOf(entry: PageEntry): ThreadScope
  signal?: AbortSignal
  onProgress?(p: SummaryProgress): void
}): Promise<SummaryOutcome> {
  const { ctx, entries, signal } = args
  const boardId = ctx.board.id
  const [{ buildSummaryModel }, { makeSummaryPdf }, { toSummaryPicture }, { canvasMeasure }] =
    await Promise.all([
      import('../present-export/review-summary/model.ts'),
      import('../present-export/review-summary/build.ts'),
      import('../present-export/review-summary/pictures.ts'),
      import('../present-export/review-summary/raster.ts'),
    ])
  const total = entries.length
  const report = (phase: SummaryProgress['phase'], done: number) => args.onProgress?.({ phase, done, total })

  // 1. the history of every item, and the versions of every file's asset (WS2's list: absent until it is live)
  report('collecting', 0)
  let collected = 0
  const events = new Map<string, readonly ReviewEvent[]>()
  await pool(entries, 4, async (e) => {
    const page = await listReviewEvents(boardId, e.item.id)
    events.set(e.item.id, page.events)
    report('collecting', ++collected)
  })
  const assetIds = [...new Set(entries.flatMap((e) => (e.file ? [e.file.assetId] : [])))]
  const versions = new Map<string, { id: string; n: number }[]>()
  await pool(assetIds, 4, async (assetId) => {
    const list = await listAssetVersions(boardId, assetId)
    if (list)
      versions.set(
        assetId,
        list.versions.map((v) => ({ id: v.versionId, n: v.n })),
      )
  })
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')

  // 2. the model
  const summaryEntries: SummaryEntry[] = entries.map((e) => {
    const list = e.file ? versions.get(e.file.assetId) : undefined
    // a card that now shows another file: nobody reviewed what the summary pictures (never its old "Approved")
    if (entryStanding(e).kind === 'replaced')
      return {
        item: { ...e.item, status: 'pending', statusBy: null, statusAt: null, statusVersionId: null },
        label: e.label,
        version: null,
      }
    const at = list?.find((v) => v.id === (e.item.statusVersionId ?? e.file?.versionId))
    return { item: e.item, label: e.label, version: list && at ? { n: at.n, of: list.length } : null }
  })
  const byItem = new Map(entries.map((e) => [e.item.id, e]))
  const model = buildSummaryModel({
    boardTitle: ctx.board.title,
    round: args.round,
    entries: summaryEntries,
    events,
    threads: args.threads,
    threadsOf: (s) => {
      const e = byItem.get(s.item.id)
      return e ? threadsFor(args.threads, e, args.scopeOf(e)) : []
    },
    resolvedOf: (s) => {
      const e = byItem.get(s.item.id)
      return e ? resolvedCount(args.threads, e, args.scopeOf(e)) : 0
    },
    generatedBy: ctx.me.user.name,
    now: new Date(),
  })

  // 3. the pictures, one at a time (a frame is drawn on the board's canvas)
  const pictures = new Map<number, Awaited<ReturnType<typeof toSummaryPicture>>>()
  for (const [i, e] of entries.entries()) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    report('pictures', i)
    try {
      if (e.kind === 'frame') {
        const blob = await renderPng(ctx.canvas, frameTarget(ctx.canvas, e.item.elementId), {
          scale: 1,
          transparent: false,
        })
        pictures.set(i, await toSummaryPicture(blob))
      } else if (e.file) {
        const snap = mediaMetaStore.get(boardId, e.file.assetId, e.file.versionId)
        const d = previewDerivative(snap.meta, e.file.kind)
        if (d) {
          const res = await fetch(derivativeUrl(boardId, e.file.assetId, e.file.versionId, d.id), {
            credentials: 'same-origin',
          })
          if (res.ok) pictures.set(i, await toSummaryPicture(await res.blob()))
        }
      }
    } catch {
      // a picture that cannot be made is a box saying so, never a failed summary
    }
  }

  // 4. the PDF
  const title = exportFilename(ctx.board.title, 'pdf', 'Review summary')
  const result = await makeSummaryPdf({
    model,
    pictures: (i) => pictures.get(i) ?? null,
    title: title.replace(/\.pdf$/, ''),
    measure: canvasMeasure(),
    ...(signal ? { signal } : {}),
    onProgress: (p) => report('pages', p.done),
  })
  downloadBlob(result.blob, title)
  return {
    filename: title,
    pageCount: result.pageCount,
    notShown: result.notShown,
    cutThreads: result.cutThreads,
  }
}
