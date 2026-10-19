// OWNER: WS4 (wave W, deck import). docs/WAVE-W-CONTRACTS.md §6.
//
//   POST /api/files/:ver/render-pages {boardId}   → 202 FileOpState   edit + an account   W4-1
//
// "Insert as slides" on a deck with more pages than a preview renders (DECK_LIMITS.eagerPages, 8) asks for the rest,
// pages 9..min(N, DECK_LIMITS.maxSlides), as render-pages worker ops: one op per contracts deckRenderRuns(pageCount)
// run (params {from, to}, params_key `${from}-${to}`), made in one transaction. The checks, in order:
//   - the switch (formatsRoute's onRequest gate) AND a worker that reported WORKER_CAPABILITIES['render-pages'] within
//     WORKER_OP_LIMITS.capabilityFreshMs (the auth config's offer, features/formats/offer.ts): else the unknown route's
//     404, so a stale tab whose offer predates a worker leaving hears the same as a switch off (§12 departure 14);
//   - a session (401); name-only guests were refused by the root guest guard already (403 GUEST_ACCOUNT_REQUIRED,
//     FORMAT_GUESTS_MESSAGE: making slides costs worker time; a guest may still place a deck's first 8 pages);
//   - the board: 404 when the caller cannot see it, 409 BOARD_ARCHIVED on an archived one, 403 below edit;
//   - the version, locked FOR UPDATE (two requests for one deck, and the completer, serialize on it): served on that
//     board (uploaded there, or linked: files-auth.ts), else 404; a PDF, PowerPoint or OpenDocument presentation (kind
//     pdf; a PSD, TIFF or text document is not a deck), else 400 FILE_OP_UNSUPPORTED; `ready`, else 409 FILE_NOT_READY;
//   - the runs that still miss a page: none (8 pages or fewer, or every page made already) is 409 NOTHING_TO_RENDER,
//     and the web places the slides at once; a run already queued or running (anyone's) is left to finish, and when
//     every missing run is active the answer is 409 FILE_OP_ACTIVE (the web then waits for the pages on the meta
//     route: a run made for someone else is not theirs to see, features/formats/op-state.ts);
// then one worker_ops row per missing, inactive run (requested_by = the caller) and 202 with the FIRST op's state; the
// requester follows each by its `file.op` events (after COMMIT, to their own streams only) and GET /api/file-ops/:op.
//
// Quota: the pages are previews of an original already counted, bounded per original (at most 92 pages of a 1024 px
// rendering), and like every preview they are written without a quota check of their own (files/usage.ts).
// The completer is ./kind.ts (registered in worker/ops-kinds.ts).

import {
  DECK_LIMITS,
  deckRenderRuns,
  FileOpInput,
  FORMAT_ERROR_CODES,
  FORMAT_ROUTE_KEYS,
  RenderPagesParams,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireBoardAction } from '../../../access.ts'
import type { Params } from '../../../context.ts'
import { ApiError, conflict, forbidden, notFound, parse } from '../../../errors.ts'
import { isAssetLinked } from '../../../files-auth.ts'
import type { FeatureContext } from '../../context.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../../pending-routes.ts'
import { fileOpState } from '../op-state.ts'
import { formatsRoute } from '../switch.ts'

/** The confirmed types a deck may have (dev-assets OFFICE_FORMATS' presentations, and PDF). */
export const DECK_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
])

const VERSION_RE = /^ver_[0-9A-Za-z]{10,40}$/

export const DECK_MESSAGES = {
  unsupported: 'Only PDF and PowerPoint or OpenDocument presentations can be made into slides.',
  notReady: 'This file is still being processed. Try again when its preview is ready.',
  nothing: 'Every slide of this file is ready to place.',
  active: 'The slides of this file are being made already. They can be placed when they are ready.',
  archived: 'This board is archived. Restore it to add slides.',
} as const

const runKey = (r: { from: number; to: number }) => `${r.from}-${r.to}`

interface VersionRow {
  id: string
  asset_id: string
  board_id: string
  workspace_id: string
  kind: string
  mime_type: string
  status: string
  pages: number | null
}

export async function registerDeckImport(
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  const [method, url] = FORMAT_ROUTE_KEYS.renderPages.split(' ') as [PendingMethod, string]

  async function renderPages(req: FastifyRequest, reply: FastifyReply) {
    // the switch is the gate; a worker that can do it must have asked recently too (else nothing would run it)
    if (!(await ctx.formatsOffer()).deckImport) throw notFound()
    const user = await ctx.requireUser(req)
    const ver = (req.params as Params).ver
    if (typeof ver !== 'string' || !VERSION_RE.test(ver)) throw notFound()
    const input = parse(FileOpInput, req.body ?? {})
    const now = ctx.now()
    const first = await ctx.db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, input.boardId, user.id, 'view')
      if (access.board.status === 'archived') throw conflict('BOARD_ARCHIVED', DECK_MESSAGES.archived)
      if (!can(access.role, 'edit', access.board.status)) throw forbidden()
      const v = await tx.maybeOne<VersionRow>(
        `SELECT id, asset_id, board_id, workspace_id, kind, mime_type, status,
                CASE WHEN jsonb_typeof(probe -> 'pageCount') = 'number' THEN (probe ->> 'pageCount')::int END AS pages
           FROM asset_versions WHERE id = $1 FOR UPDATE`,
        [ver],
      )
      if (!v || v.workspace_id !== access.board.workspace_id) throw notFound()
      if (
        v.board_id !== access.board.id &&
        !(await isAssetLinked(tx, access.board.workspace_id, access.board.id, {
          assetId: v.asset_id,
          versionId: v.id,
          ownerBoardId: v.board_id,
        }))
      )
        throw notFound()
      if (v.kind !== 'pdf' || !DECK_MIME_TYPES.has(v.mime_type))
        throw new ApiError(400, FORMAT_ERROR_CODES.unsupported, DECK_MESSAGES.unsupported)
      if (v.status !== 'ready') throw conflict(FORMAT_ERROR_CODES.notReady, DECK_MESSAGES.notReady)
      const pageCount = v.pages ?? 0
      if (pageCount <= DECK_LIMITS.eagerPages)
        throw conflict(FORMAT_ERROR_CODES.nothingToRender, DECK_MESSAGES.nothing)
      const have = new Set(
        (
          await tx.query<{ page: number }>(
            `SELECT DISTINCT page FROM asset_derivatives WHERE version_id = $1 AND role = 'page' AND page IS NOT NULL`,
            [v.id],
          )
        ).rows.map((r) => Number(r.page)),
      )
      const missing = deckRenderRuns(pageCount).filter((r) => {
        for (let n = r.from; n <= r.to; n++) if (!have.has(n)) return true
        return false
      })
      if (!missing.length) throw conflict(FORMAT_ERROR_CODES.nothingToRender, DECK_MESSAGES.nothing)
      const active = new Set(
        (
          await tx.query<{ params_key: string }>(
            `SELECT params_key FROM worker_ops
              WHERE kind = 'render-pages' AND source_version_id = $1 AND status IN ('queued', 'running')`,
            [v.id],
          )
        ).rows.map((r) => r.params_key),
      )
      const todo = missing.filter((r) => !active.has(runKey(r)))
      if (!todo.length) throw conflict(FORMAT_ERROR_CODES.opActive, DECK_MESSAGES.active)
      const ids: string[] = []
      for (const [i, r] of todo.entries()) {
        const params = RenderPagesParams.parse(r)
        const id = newId('wop')
        // a millisecond apart: ops due together are claimed by created_at, so the runs go in page order
        const created = new Date(now.getTime() + i)
        await tx.query(
          `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key, requested_by,
                                   run_after, created_at, updated_at)
           VALUES ($1, $2, $3, 'render-pages', $4, $5::jsonb, $6, $7, $8, $9, $9)`,
          [
            id,
            access.board.workspace_id,
            access.board.id,
            v.id,
            JSON.stringify(params),
            runKey(r),
            user.id,
            now,
            created,
          ],
        )
        ids.push(id)
      }
      return ids[0] as string
    })
    const s = await fileOpState(ctx.db, first, now)
    if (!s) throw notFound()
    return reply.code(202).send(s.state)
  }

  formatsRoute(app, ctx, 'deckImport', method, url, renderPages, pending)
}
