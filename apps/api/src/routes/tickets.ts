// Board connection tickets (docs/M1-CONTRACTS.md §6) and the sync server's access re-check (§7).
// Both answer with connectionRole(), so a ticket and a later re-check can never disagree.

import { signTicket } from '@draftroom/auth-tickets'
import {
  ACCESS_MANY_PATH,
  AccessManyRequest,
  type AccessManyResponse,
  ASSIGNEE_REFS_ROUTE,
  BoardId,
  NEW_CANVAS_BOARD_MESSAGE,
  NEW_CANVAS_ERROR,
  type TicketResponse,
  UserId,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pairKey as accessPairKey, connectionRole, loadBoardAccess, loadBoardAccessMany } from '../access.ts'
import { onNewCanvas } from '../canvas-engine.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError, notFound, parse } from '../errors.ts'
import { ticketIdentity } from '../features/guests/label.ts'
import { routeUnlessPending } from '../features/pending-routes.ts'

const AccessQuery = z.object({ boardId: BoardId, userId: UserId })

/**
 * The internal POSTs the sync server sends (M7-1): app.ts exempts exactly these route patterns from the
 * web-Origin (CSRF) check, as it does INTERNAL_CHECKPOINT_POSTS. Server to server, no cookie is read, and the
 * internal secret is checked before anything else (registerInternalSecretGuard runs first).
 */
// wave T: the room's assignee check (routes/engine-internal.ts), matched by its route pattern
export const INTERNAL_SYNC_POSTS: ReadonlySet<string> = new Set([ACCESS_MANY_PATH, ASSIGNEE_REFS_ROUTE])

export function registerTicketRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, now } = ctx

  app.post('/api/boards/:bid/ticket', async (req): Promise<TicketResponse> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await loadBoardAccess(db, bid, user.id)
    const role = connectionRole(access)
    // No access, trashed, or unknown: one answer, so a ticket request cannot probe for board ids.
    if (!role) throw notFound()
    // Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4): a board born on the new canvas is not
    // this build's to open. Its sync refuses a file it can read as one; this also covers a board whose
    // file does not exist yet, which R0's sync would otherwise start as a new, empty tldraw board. On the
    // new canvas (canvas-engine.ts) it is this build's own board.
    if (access?.board.new_canvas && !(await onNewCanvas(ctx)))
      throw new ApiError(409, NEW_CANVAS_ERROR, NEW_CANVAS_BOARD_MESSAGE)
    // Wave 3: a name-only guest's long name is shortened so the cursor label keeps "(guest)".
    // A3 (Excalidraw engine): a name-only guest's ticket carries `guest: true`, read from the users
    // row (never from the request); sync enforces the guest limits from it. Everyone else's has none.
    const { name, guest } = await ticketIdentity(db, user)
    const { ticket, claims } = signTicket(config.ticketSecret, {
      bid,
      uid: user.id,
      name,
      color: user.color,
      role,
      guest,
      now: now().getTime(),
    })
    return { ticket, expiresAt: claims.exp, role, user: { id: user.id, name, color: user.color } }
  })

  // Server-to-server only (the web proxy never forwards /internal). Authenticated by the shared secret,
  // checked for every /internal route by the root guard (app.ts registerInternalSecretGuard).
  app.get('/internal/access', async (req) => {
    const { boardId, userId } = parse(AccessQuery, req.query)
    // Unknown board or user: null, the same as "no access" (the caller only needs to know whether to close).
    // RT-01: `signedInSince` (auth/session.ts): the start of the person's oldest live session, or null
    // when they have none; the sync server closes their sockets whose sign-in has ended.
    return {
      role: connectionRole(await loadBoardAccess(db, boardId, userId)),
      signedInSince: await ctx.sessions.signedInSince(userId),
    }
  })

  // Wave M (M7-1, CAP-SYNC-RECHECK): POST /internal/access-many AccessManyRequest → AccessManyResponse
  // (@draftroom/contracts sync-internal.ts). The sync's periodic re-check sends one of these per round (chunks of
  // ACCESS_MANY_MAX_PAIRS) instead of one GET /internal/access per board-user pair: two queries whatever the
  // number of pairs (loadBoardAccessMany, then signedInSinceMany). Each pair's role is exactly what GET
  // /internal/access answers for it (connectionRole over the same access row); `signedInSince` once per person,
  // as that route's field. The root guard checks the internal secret (app.ts registerInternalSecretGuard). A sync
  // from before wave M never calls it; this sync falls back to the per-pair route on a 404 (an older api).
  routeUnlessPending(app, 'POST', ACCESS_MANY_PATH, async (req): Promise<AccessManyResponse> => {
    const { pairs } = parse(AccessManyRequest, req.body)
    const access = await loadBoardAccessMany(db, pairs)
    const users = [...new Set(pairs.map((p) => p.userId))]
    const since = await signedInSinceMany(db, users, now())
    return {
      results: pairs.map((p) => ({
        boardId: p.boardId,
        userId: p.userId,
        role: connectionRole(access.get(accessPairKey(p)) ?? null),
      })),
      signedInSince: Object.fromEntries(users.map((u) => [u, since.get(u) ?? null])),
    }
  })
}

/**
 * auth/session.ts `signedInSince` for many people in ONE query (the batched re-check): per user, when their
 * oldest LIVE session (not revoked, not expired at `at`) started, epoch ms; a user with none is absent from the
 * map (the caller answers null). The same rule and the same index (sessions_user_idx) as the one-user query.
 */
export async function signedInSinceMany(
  q: Queryable,
  userIds: readonly string[],
  at: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!userIds.length) return out
  const r = await q.query<{ user_id: string; since: Date | null }>(
    `SELECT user_id, min(created_at) AS since FROM sessions
      WHERE user_id = ANY($1::text[]) AND revoked_at IS NULL AND expires_at > $2
      GROUP BY user_id`,
    [[...userIds], at],
  )
  for (const row of r.rows) if (row.since) out.set(row.user_id, new Date(row.since).getTime())
  return out
}
