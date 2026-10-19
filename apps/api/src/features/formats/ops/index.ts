// OWNER: WS2 (wave W; WS4 uses these as they are). docs/WAVE-W-CONTRACTS.md §3.4.
//
//   GET  /api/file-ops/:op          → FileOpState   the requester only (404 for anyone else)       W2-2
//   POST /api/file-ops/:op/cancel   → FileOpState   the requester only; queued only (running: 409)  W2-2
//
// Open while DRAFTROOM_REMOVE_BACKGROUND or DRAFTROOM_DECK_IMPORT is on (the gate); an op whose own kind's switch is
// off is then an unknown op (404). An op is its requester's alone: anyone else, a requester who can no longer view the
// op's board, an op without a requester (WS3's extract-text) and a malformed id all get the same 404, so an op id
// reveals nothing. A cancel of a queued op ends it `cancelled CANCELLED` and sends the requester's `file.op`; a running
// one is already on a worker (409 FILE_OP_RUNNING: it finishes or fails on its own); a finished one answers its state.

import { type FileOpState, FORMAT_ROUTE_KEYS, WORKER_OP_SWITCH } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { loadBoardAccess } from '../../../access.ts'
import type { Params } from '../../../context.ts'
import { conflict, notFound } from '../../../errors.ts'
import type { FeatureContext } from '../../context.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../../pending-routes.ts'
import { fileOpState, publishOpChange } from '../op-state.ts'
import { formatsOn, formatsRoute } from '../switch.ts'

/** The switches of the op kinds a person can request (any one on opens the op routes). */
export const REQUESTABLE_OP_SWITCHES = ['removeBackground', 'deckImport'] as const

const OP_RE = /^wop_[0-9A-Za-z]{10,40}$/

export const FILE_OP_RUNNING = 'FILE_OP_RUNNING'
export const RUNNING_MESSAGE = 'This is already being worked on and can no longer be cancelled.'

/** The op's state when `userId` may see it (its requester, still able to view its board, its kind switched on). */
async function ownOp(
  ctx: FeatureContext,
  q: Queryable,
  req: FastifyRequest,
): Promise<{ state: FileOpState; userId: string; workspaceId: string }> {
  const user = await ctx.requireUser(req)
  const opId = (req.params as Params).op
  if (typeof opId !== 'string' || !OP_RE.test(opId)) throw notFound()
  const found = await fileOpState(q, opId, ctx.now())
  if (!found?.requestedBy || found.requestedBy !== user.id) throw notFound()
  if (!formatsOn(ctx, WORKER_OP_SWITCH[found.state.kind])) throw notFound()
  const access = await loadBoardAccess(q, found.state.boardId, user.id)
  if (!access || !can(access.role, 'view', access.board.status)) throw notFound()
  return { state: found.state, userId: user.id, workspaceId: access.board.workspace_id }
}

export async function registerFileOps(
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  const route = (key: string) => key.split(' ') as [PendingMethod, string]

  const [getMethod, getUrl] = route(FORMAT_ROUTE_KEYS.opState)
  formatsRoute(
    app,
    ctx,
    REQUESTABLE_OP_SWITCHES,
    getMethod,
    getUrl,
    async (req) => (await ownOp(ctx, ctx.db, req)).state,
    pending,
  )

  const [cancelMethod, cancelUrl] = route(FORMAT_ROUTE_KEYS.opCancel)
  formatsRoute(
    app,
    ctx,
    REQUESTABLE_OP_SWITCHES,
    cancelMethod,
    cancelUrl,
    async (req): Promise<FileOpState> => {
      const own = await ownOp(ctx, ctx.db, req)
      if (own.state.status === 'running') throw conflict(FILE_OP_RUNNING, RUNNING_MESSAGE)
      if (own.state.status !== 'queued') return own.state
      const now = ctx.now()
      const r = await ctx.db.query(
        `UPDATE worker_ops SET status = 'cancelled', error_code = 'CANCELLED', finished_at = $2, updated_at = $2,
                lease_owner = NULL, lease_until = NULL
          WHERE id = $1 AND status = 'queued'`,
        [own.state.id, now],
      )
      if (r.rowCount === 1)
        await publishOpChange(
          ctx.db,
          ctx.events,
          {
            opId: own.state.id,
            kind: own.state.kind,
            boardId: own.state.boardId,
            workspaceId: own.workspaceId,
            requestedBy: own.userId,
            status: 'cancelled',
          },
          now,
        )
      const after = await fileOpState(ctx.db, own.state.id, now)
      if (!after) throw notFound()
      // claimed in between: it is running now, and it was not cancelled
      if (after.state.status === 'running') throw conflict(FILE_OP_RUNNING, RUNNING_MESSAGE)
      return after.state
    },
    pending,
  )
}
