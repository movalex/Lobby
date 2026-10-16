// OWNER: WS1 (wave R, R1-4). The import job routes (@draftroom/contracts imports.ts; docs/WAVE-R-CONTRACTS.md §2.1),
// over the shared runner (./runner.ts), for every source (Miro, WS4's backup restore):
//
//   GET  /api/imports/:id                 the job's view (its starter; the workspace's owners and admins)
//   GET  /api/workspaces/:wid/imports     recent jobs, 30 days, newest first (?mine=1; members see only their own)
//   POST /api/imports/:id/cancel          202, its starter: the board in hand is discarded, finished boards stay
//   POST /api/imports/:id/pause           202, its starter: stops at the next step boundary, keeps what it stored
//   POST /api/imports/:id/resume          202, its starter, a creator: `{ token }` for a Miro job (never stored)
//   GET  /api/imports/:id/report.csv      its starter and the owners of the boards it made: one row per item
//
// A name-only guest is refused all six first (guests/guard.ts IMPORT_GUESTS); resume needs a creator (the guard,
// 'always', and again here: it makes boards). Anyone who may not see a job gets 404, as for a job that does not
// exist. Answers hold ids, codes, counts and the person's own board titles; never a token, a URL or file names.

import { csvTextCell } from '@draftroom/board-ops/elements'
import {
  IMPORT_ROUTES,
  type ImportBoardReport,
  ImportJobId,
  type ImportJobView,
  ListImportJobsQuery,
  type ListImportJobsResponse,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireWorkspaceRole } from '../../access.ts'
import type { Params } from '../../context.ts'
import { badRequest, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { isPendingRoute } from '../pending-routes.ts'
import { jobRows } from './jobs.ts'
import { MiroClient } from './miro/client.ts'
import { miroReachOf } from './miro/source.ts'
import { answering, takeMiroToken, tokenRefusal } from './miro/token.ts'
import type { ImportRunner } from './runner.ts'

const CSV_COLUMNS = ['board', 'source_id', 'type', 'result', 'element_id', 'note']

const idOf = (raw: string) => {
  if (!ImportJobId.safeParse(raw).success) throw notFound()
  return raw
}

export async function registerImportRoutes(
  app: FastifyInstance,
  ctx: FeatureContext,
  runner: ImportRunner,
): Promise<void> {
  const { db } = ctx
  const live = (method: string, url: string) => !isPendingRoute(`${method} ${url}`)

  const viewOrNotFound = async (importId: string, userId: string): Promise<ImportJobView> => {
    const view = await runner.view(importId, userId)
    if (!view) throw notFound()
    return view
  }

  if (live('GET', IMPORT_ROUTES.job))
    app.get(IMPORT_ROUTES.job, async (req): Promise<ImportJobView> => {
      const user = await ctx.requireUser(req)
      const { id = '' } = req.params as Params
      return viewOrNotFound(idOf(id), user.id)
    })

  if (live('GET', IMPORT_ROUTES.list))
    app.get(IMPORT_ROUTES.list, async (req): Promise<ListImportJobsResponse> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const query = parse(ListImportJobsQuery, req.query ?? {})
      await requireWorkspaceRole(db, wid, user.id)
      return { imports: await runner.list(wid, user.id, { mine: query.mine === '1' }) }
    })

  if (live('POST', IMPORT_ROUTES.cancel))
    app.post(IMPORT_ROUTES.cancel, async (req, reply): Promise<ImportJobView> => {
      const user = await ctx.requireUser(req)
      const id = idOf((req.params as Params).id ?? '')
      await runner.cancel(id, user.id)
      reply.code(202)
      return viewOrNotFound(id, user.id)
    })

  if (live('POST', IMPORT_ROUTES.pause))
    app.post(IMPORT_ROUTES.pause, async (req, reply): Promise<ImportJobView> => {
      const user = await ctx.requireUser(req)
      const id = idOf((req.params as Params).id ?? '')
      await runner.pause(id, user.id)
      reply.code(202)
      return viewOrNotFound(id, user.id)
    })

  if (live('POST', IMPORT_ROUTES.resume))
    app.post(IMPORT_ROUTES.resume, async (req, reply): Promise<ImportJobView> => {
      const user = await ctx.requireUser(req)
      const id = idOf((req.params as Params).id ?? '')
      const { secret, invalid, rest } = takeMiroToken(req)
      // resuming makes boards: a creator (stored status), whatever the job; only its starter learns that it exists
      await ctx.identity.requireCreator(db, user.id, 'create', {
        route: req.routeOptions.url ?? '',
        by: 'route',
      })
      const first = (await jobRows(db, id))[0]
      if (!first || first.created_by !== user.id) throw notFound()
      if (invalid) throw tokenRefusal()
      if (Object.keys(rest).length) throw badRequest('Only a token may be sent to resume an import.')
      const miro = first.source === 'miro'
      if (secret && miro) {
        // the token is checked now, so a wrong one is said here and not as a failed board later
        const reach = miroReachOf(ctx)
        await answering(secret, () =>
          new MiroClient(reach.egress, secret, { apiOrigin: reach.apiOrigin }).tokenContext(),
        )
      }
      await runner.resume(id, user.id, secret && miro ? [secret] : [])
      reply.code(202)
      return viewOrNotFound(id, user.id)
    })

  if (live('GET', IMPORT_ROUTES.report))
    app.get(IMPORT_ROUTES.report, async (req, reply) => {
      const user = await ctx.requireUser(req)
      const id = idOf((req.params as Params).id ?? '')
      const rows = await jobRows(db, id)
      const first = rows[0]
      if (!first) throw notFound()
      if (first.created_by !== user.id) {
        // the owners of the boards it made (still there to own) may read it too
        const made = rows.filter((r) => r.status === 'done' && r.board_id).map((r) => r.board_id as string)
        const owner = made.length
          ? await db.maybeOne(
              `SELECT 1 AS ok FROM board_members m JOIN boards b ON b.id = m.board_id
                WHERE m.board_id = ANY($1::text[]) AND m.user_id = $2 AND m.role = 'owner'
                  AND b.status IN ('active', 'archived')`,
              [made, user.id],
            )
          : null
        if (!owner) throw notFound()
      }
      const lines = [CSV_COLUMNS.join(',')]
      for (const r of rows) {
        const report = r.report as ImportBoardReport | null
        for (const row of report?.rows ?? [])
          lines.push(
            [r.title, row.sourceId, row.type, row.result, row.elementId ?? '', row.note ?? '']
              .map((v) => csvTextCell(String(v)))
              .join(','),
          )
      }
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="lobby-import-${id}.csv"`)
        .header('cache-control', 'no-store')
      return `${lines.join('\r\n')}\r\n`
    })
}
