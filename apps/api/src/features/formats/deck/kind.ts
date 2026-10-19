// OWNER: WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6, §3.2). The api side of the `render-pages` worker op:
// what a lease holder may reserve, and the completer that turns the op's page outputs into `page` derivatives of the
// SOURCE version, exactly like a preview job's pages (worker/jobs.ts completeJob), so the meta route, the loader, the
// page viewer and a 7e5b4d6 web read pages 9..100 as they read pages 1..8.
//
// There is no unique (version, role, page) index on asset_derivatives (§12 departure 5), so idempotence is this file's:
//   - a reservation of a page the version already has is refused (409 PAGE_EXISTS: the worker skips that page), as is
//     a second reservation of one page in one attempt (409 DUPLICATE_PAGE), a page outside the op's run or past the
//     document's page count (400 PAGE_OUT_OF_RANGE), and anything but a `page` of the preview pages' width;
//   - the completer takes the version's row lock and skips every page that has a row by then, so a double complete
//     (answered `repeated` by ops-jobs before it gets here), a re-run and two overlapping ops all leave one row a page;
//     a skipped page's output is returned `unpublished`, so ops-jobs deletes its blob after COMMIT (review m9).
// The stored result lists the pages of the run the version has after this commit (RenderPagesResult), which is what
// the requester's `file.op` reports as `pagesReady` (features/formats/op-state.ts).

import { DECK_LIMITS, RenderPagesParams, RenderPagesResult } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { type LockedOp, type OpKindHandler, OpRefused } from '../../../worker/ops-kinds.ts'

/** The pdf child's longest page edge (apps/worker config PREVIEW.pdfMaxEdge): a tall page is narrower, never taller. */
const PAGE_MAX_EDGE = 4096

const refused = (status: number, code: string, message: string) => new OpRefused(status, code, message)

function runOf(op: LockedOp): { from: number; to: number } {
  const p = RenderPagesParams.safeParse(op.params)
  if (!p.success) throw refused(400, 'BAD_PARAMS', 'This op has no valid page run.')
  return p.data
}

async function pageCountOf(tx: Queryable, versionId: string): Promise<number | null> {
  const row = await tx.maybeOne<{ pages: number | null }>(
    `SELECT CASE WHEN jsonb_typeof(probe -> 'pageCount') = 'number' THEN (probe ->> 'pageCount')::int END AS pages
       FROM asset_versions WHERE id = $1`,
    [versionId],
  )
  return row?.pages ?? null
}

export const renderPagesKind: OpKindHandler = {
  kind: 'render-pages',

  async checkOutput(tx, op, input) {
    const { from, to } = runOf(op)
    if (input.role !== 'page' || typeof input.page !== 'number')
      throw refused(400, 'OUTPUT_REFUSED', 'This op makes page renderings only.')
    const page = input.page
    const pages = await pageCountOf(tx, op.sourceVersionId)
    if (page < from || page > to || (pages !== null && page > pages))
      throw refused(400, 'PAGE_OUT_OF_RANGE', 'This page is outside the op’s run.')
    // the previews' page rendering: DECK_LIMITS.pageEdge wide (one more for the child's rounding up), never taller
    // than the child's cap
    if (input.width > DECK_LIMITS.pageEdge + 1 || input.height > PAGE_MAX_EDGE)
      throw refused(400, 'OUTPUT_REFUSED', 'A page rendering is at most the preview pages’ size.')
    const twice = await tx.maybeOne(
      `SELECT 1 AS ok FROM worker_op_outputs WHERE op_id = $1 AND attempt = $2 AND page = $3`,
      [op.id, op.attempt, page],
    )
    if (twice) throw refused(409, 'DUPLICATE_PAGE', 'This page was reserved already.')
    const exists = await tx.maybeOne(
      `SELECT 1 AS ok FROM asset_derivatives WHERE version_id = $1 AND role = 'page' AND page = $2 LIMIT 1`,
      [op.sourceVersionId, page],
    )
    if (exists) throw refused(409, 'PAGE_EXISTS', 'This page exists already.')
  },

  async acceptText() {
    throw refused(400, 'TEXT_REFUSED', 'This op makes no text.')
  },

  async complete(tx, op, done) {
    const { from, to } = runOf(op)
    const reported = RenderPagesResult.safeParse(done.result)
    if (!reported.success) throw refused(400, 'BAD_RESULT', 'The op result is not valid.')
    const pages = done.outputs.map((o) => o.page)
    if (done.outputs.some((o) => o.role !== 'page' || o.page === null || o.page < from || o.page > to))
      throw refused(400, 'OUTPUT_REFUSED', 'This op publishes page renderings of its run only.')
    const listed = [...reported.data.rendered].sort((a, b) => a - b)
    const published = [...(pages as number[])].sort((a, b) => a - b)
    if (listed.length !== published.length || listed.some((p, i) => p !== published[i]))
      throw refused(400, 'BAD_RESULT', 'The op result does not match its outputs.')

    // the version's row lock: the request route takes it too, and two completes of one version serialize here
    const v = await tx.maybeOne<{ pages: number | null }>(
      `SELECT CASE WHEN jsonb_typeof(probe -> 'pageCount') = 'number' THEN (probe ->> 'pageCount')::int END AS pages
         FROM asset_versions WHERE id = $1 FOR UPDATE`,
      [op.sourceVersionId],
    )
    if (!v) throw refused(409, 'SOURCE_MISSING', 'The file is gone.')
    const have = new Set(
      (
        await tx.query<{ page: number }>(
          `SELECT DISTINCT page FROM asset_derivatives WHERE version_id = $1 AND role = 'page' AND page IS NOT NULL`,
          [op.sourceVersionId],
        )
      ).rows.map((r) => Number(r.page)),
    )
    const { last } = await tx.one<{ last: number }>(
      'SELECT COALESCE(MAX(position), -1)::int AS last FROM asset_derivatives WHERE version_id = $1',
      [op.sourceVersionId],
    )
    let position = Number(last)
    const unpublished: string[] = []
    for (const o of [...done.outputs].sort((a, b) => (a.page ?? 0) - (b.page ?? 0))) {
      const page = o.page as number
      if (have.has(page)) {
        // made meanwhile (a re-run, another op): one row a page; this output's blob goes (review m9)
        unpublished.push(o.id)
        continue
      }
      await tx.query(
        `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key,
                                        created_at)
         VALUES ($1, $2, $3, 'page', $4, $5, $6, $7, $8, $9, $10)`,
        [
          o.derivativeId,
          op.sourceVersionId,
          ++position,
          page,
          o.width,
          o.height,
          o.mimeType,
          o.bytes,
          o.blobKey,
          done.now,
        ],
      )
      have.add(page)
    }
    const total = v.pages ?? reported.data.pageCount
    const ready: number[] = []
    for (let n = from; n <= Math.min(to, total); n++) if (have.has(n)) ready.push(n)
    return { result: { pageCount: total, rendered: ready }, unpublished }
  },
}
