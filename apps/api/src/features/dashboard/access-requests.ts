// Access requests (PRS-04): a signed-in user without access (or a viewer/commenter wanting more) asks
// the board's owners for a role. Owners list, approve (creates the grant, pushes access-changed to
// sync, and puts an 'access_granted' item in the requester's bell: PRI-09b) or deny them in the Share
// dialog.
//
// Privacy: POST answers the same 202 whether or not the board exists, whether a row was written, and
// whether a per-board limit swallowed it, so a request never reveals a board. Only the per-user
// limit (independent of the board) answers 429.

import {
  AccessRequestId,
  type AccessRequest as ApiAccessRequest,
  ApproveAccessRequestInput,
  CreateAccessRequestInput,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  type BoardRole,
  type BoardVisibility,
  can,
  resolveBoardRole,
  roleAtLeast,
  type WorkspaceRole,
} from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { isBoardId, loadBoardAccess, requireBoardAction } from '../../access.ts'
import { audit } from '../../audit.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, notFound, parse } from '../../errors.ts'
import { actorOf } from '../../notifier.ts'
import { toUser } from '../../serialize.ts'
import type { FeatureContext } from '../context.ts'
import { DAY_MS, newAccessRequestId, publishSharingChanged, trySavepoint, UserRateLimiter } from './shared.ts'

/** Per user, across all boards: 10 requests per 10 minutes. */
export const ACCESS_REQUEST_USER_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 }
/**
 * J2 / INV-6: per board, across everyone who asks: at most this many NEW requests in any 24 hours. The
 * per-user limit cannot see a crowd of accounts (verified sign-ups are cheap: plus-addressing), and each
 * new requester is a pending row and a bell item for every owner. Past it a new request is swallowed like
 * the per-board denial pause (the same 202, nothing written, nobody notified), so the owners' list and
 * bell stay readable; a request that is already pending is still updated (its re-notification is limited
 * per person). Counted under the board row lock, so simultaneous requests cannot all slip past it.
 */
export const ACCESS_REQUEST_BOARD_LIMIT = { max: 50, windowMs: DAY_MS }
/** Owners hear about the same person's request on one board at most this often (unless the role rises). */
const RENOTIFY_MS = DAY_MS
/** After a denial, new requests from that person for that board are ignored this long. */
const DENIED_COOLDOWN_MS = DAY_MS
const MAX_LISTED = 200

type RequestRole = Exclude<BoardRole, 'owner'>

interface RequestRow {
  id: string
  workspace_id: string
  board_id: string
  user_id: string
  role_requested: RequestRole
  message: string | null
  status: 'pending' | 'approved' | 'denied'
  created_at: Date
  updated_at: Date
  notified_at: Date | null
  decided_at: Date | null
  role_granted: RequestRole | null
}

/** A request joined with its requester and the inputs of their current board role. */
interface ListedRow extends RequestRow {
  u_name: string
  u_handle: string | null
  u_color: string
  u_avatar_url: string | null
  workspace_role: WorkspaceRole | null
  board_grant: BoardRole | null
}

const REQUEST_COLUMNS =
  'r.id, r.workspace_id, r.board_id, r.user_id, r.role_requested, r.message, r.status, r.created_at, r.updated_at, r.notified_at, r.decided_at, r.role_granted'
const LISTED_SELECT = `SELECT ${REQUEST_COLUMNS}, u.name AS u_name, u.handle AS u_handle, u.color AS u_color,
         u.avatar_url AS u_avatar_url, wm.role AS workspace_role, bm.role AS board_grant
    FROM access_requests r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN workspace_members wm ON wm.workspace_id = r.workspace_id AND wm.user_id = r.user_id
    LEFT JOIN board_members bm ON bm.board_id = r.board_id AND bm.user_id = r.user_id`

const RANK: Record<BoardRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 }
// Mirrors routes/invitations.ts: approving never lowers a role someone already has.
const boardRank = (column: string) =>
  `array_position(ARRAY['viewer', 'commenter', 'editor', 'owner']::text[], ${column})`

function serialize(r: ListedRow, visibility: BoardVisibility): ApiAccessRequest {
  return {
    id: r.id,
    boardId: r.board_id,
    user: toUser({
      id: r.user_id,
      name: r.u_name,
      handle: r.u_handle,
      color: r.u_color,
      avatar_url: r.u_avatar_url,
    }),
    roleRequested: r.role_requested,
    message: r.message,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    currentRole: resolveBoardRole({
      workspaceRole: r.workspace_role,
      boardGrant: r.board_grant,
      visibility,
    }),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    roleGranted: r.role_granted,
  }
}

/**
 * Best-effort in-app notification for the board's owners (explicit owner grants of people still in
 * the workspace; the workspace's owners/admins when the board has none). Uses the comments feature's
 * `notifications` table when it exists; a missing table or a failed insert never fails the request.
 */
export async function notifyOwners(
  tx: Queryable,
  input: { workspaceId: string; boardId: string; actorId: string; at: Date },
): Promise<number> {
  const exists = await tx.one<{ ok: boolean }>("SELECT to_regclass('notifications') IS NOT NULL AS ok")
  if (!exists.ok) return 0
  const inserted = await trySavepoint(tx, async () => {
    const res = await tx.query(
      `WITH owners AS (
         SELECT bm.user_id FROM board_members bm
           JOIN workspace_members wm ON wm.workspace_id = $1 AND wm.user_id = bm.user_id
          WHERE bm.board_id = $2 AND bm.role = 'owner'
       ), recipients AS (
         SELECT user_id FROM owners
         UNION
         SELECT wm.user_id FROM workspace_members wm
          WHERE wm.workspace_id = $1 AND wm.role IN ('owner', 'admin') AND NOT EXISTS (SELECT 1 FROM owners)
       )
       INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id, created_at)
       SELECT $1, user_id, 'access_request', $2, $3, $4 FROM recipients WHERE user_id <> $3`,
      [input.workspaceId, input.boardId, input.actorId, input.at],
    )
    return res.rowCount
  })
  return inserted ?? 0
}

/**
 * PRI-09b: the requester's bell item when their request is approved (actor = the approver; the role
 * comes from the request row, comments/notifications.ts). Best effort, like notifyOwners: a failed insert
 * never fails the approval. Listed only while the requester can view the board, and only to a web build
 * that knows the kind (LOBBY_CLIENT_REV >= 1).
 */
export async function notifyGranted(
  tx: Queryable,
  input: { workspaceId: string; boardId: string; userId: string; actorId: string; at: Date },
): Promise<boolean> {
  if (input.userId === input.actorId) return false
  const inserted = await trySavepoint(tx, async () => {
    const res = await tx.query(
      `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id, created_at)
       VALUES ($1, $2, 'access_granted', $3, $4, $5)`,
      [input.workspaceId, input.userId, input.boardId, input.actorId, input.at],
    )
    return res.rowCount > 0
  })
  return inserted ?? false
}

export function registerAccessRequestRoutes(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, now, notifier } = ctx
  const limiter = new UserRateLimiter({ ...ACCESS_REQUEST_USER_LIMIT, now: () => now().getTime() })

  app.post('/api/boards/:bid/access-requests', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateAccessRequestInput, req.body ?? {})
    if (!isBoardId(bid)) throw notFound()
    if (!limiter.hit(user.id))
      throw new ApiError(429, 'RATE_LIMITED', 'Too many access requests. Wait a few minutes and try again.')
    const message = input.message ? input.message : null

    const changed = await db.transaction(async (tx) => {
      const access = await loadBoardAccess(tx, bid, user.id, { forUpdate: true })
      // Missing or trashed: nothing to ask for, and nothing to reveal.
      if (!access || access.board.status === 'trashed') return false
      const current = can(access.role, 'view', access.board.status) ? access.role : null
      // Only people who can see the board get this answer, so it reveals nothing.
      if (current && roleAtLeast(current, input.role))
        throw conflict('ALREADY_HAS_ACCESS', 'You already have this access to the board.')
      const at = now()
      const notifyInput = { workspaceId: access.board.workspace_id, boardId: bid, actorId: user.id, at }
      const pending = await tx.maybeOne<RequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM access_requests r
          WHERE r.board_id = $1 AND r.user_id = $2 AND r.status = 'pending' FOR UPDATE`,
        [bid, user.id],
      )
      if (pending) {
        const raised = RANK[input.role] > RANK[pending.role_requested]
        const stale = !pending.notified_at || at.getTime() - pending.notified_at.getTime() >= RENOTIFY_MS
        const notify = raised || stale
        await tx.query(
          `UPDATE access_requests SET role_requested = $2, message = COALESCE($3, message), updated_at = $4,
                  notified_at = CASE WHEN $5::boolean THEN $4 ELSE notified_at END
            WHERE id = $1`,
          [pending.id, input.role, message, at, notify],
        )
        if (notify) await notifyOwners(tx, notifyInput)
        return true
      }
      const denied = await tx.maybeOne<{ ok: boolean }>(
        `SELECT true AS ok FROM access_requests
          WHERE board_id = $1 AND user_id = $2 AND status = 'denied' AND decided_at > $3 LIMIT 1`,
        [bid, user.id, new Date(at.getTime() - DENIED_COOLDOWN_MS)],
      )
      if (denied) return false
      const recent = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM access_requests WHERE board_id = $1 AND created_at > $2',
        [bid, new Date(at.getTime() - ACCESS_REQUEST_BOARD_LIMIT.windowMs)],
      )
      if (recent.n >= ACCESS_REQUEST_BOARD_LIMIT.max) return false
      await tx.query(
        `INSERT INTO access_requests (id, workspace_id, board_id, user_id, role_requested, message,
                                      created_at, updated_at, notified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)`,
        [newAccessRequestId(), access.board.workspace_id, bid, user.id, input.role, message, at],
      )
      await notifyOwners(tx, notifyInput)
      return true
    })
    if (changed) publishSharingChanged(ctx, bid, 'access-request')
    reply.code(202)
    return { status: 'sent' as const }
  })

  // The caller's own pending request (for viewers/commenters who asked for more). Non-viewers get 404
  // like everywhere else; their client remembers "sent" locally instead.
  app.get('/api/boards/:bid/access-requests/mine', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    await requireBoardAction(db, bid, user.id, 'view')
    const row = await db.maybeOne<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM access_requests r
        WHERE r.board_id = $1 AND r.user_id = $2 AND r.status = 'pending'`,
      [bid, user.id],
    )
    return {
      request: row
        ? {
            id: row.id,
            roleRequested: row.role_requested,
            status: row.status,
            createdAt: row.created_at.toISOString(),
          }
        : null,
    }
  })

  app.get('/api/boards/:bid/access-requests', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'manage_access')
    const rows = await db.query<ListedRow>(
      `${LISTED_SELECT}
        WHERE r.board_id = $1 AND r.workspace_id = $2 AND r.status = 'pending'
        ORDER BY r.updated_at DESC, r.id
        LIMIT ${MAX_LISTED}`,
      [bid, access.board.workspace_id],
    )
    return { requests: rows.rows.map((r) => serialize(r, access.board.visibility)) }
  })

  for (const decision of ['approve', 'deny'] as const) {
    app.post(`/api/access-requests/:id/${decision}`, async (req) => {
      const user = await ctx.requireUser(req)
      const { id = '' } = req.params as Params
      if (!AccessRequestId.safeParse(id).success) throw notFound()
      const asked = decision === 'approve' ? parse(ApproveAccessRequestInput, req.body ?? {}).role : undefined
      const result = await db.transaction(async (tx) => {
        const found = await tx.maybeOne<{ board_id: string }>(
          'SELECT board_id FROM access_requests WHERE id = $1',
          [id],
        )
        if (!found) throw notFound()
        // Board first (the lock order of every other access change), then the request row. Someone who
        // cannot manage the board gets the same 404/403 as for the board itself.
        const access = await requireBoardAction(tx, found.board_id, user.id, 'manage_access', {
          forUpdate: true,
        })
        // Domain access (D4): approving hands out access (creator-only); denying stays open.
        if (decision === 'approve')
          await ctx.identity.requireCreator(tx, user.id, 'share', {
            route: req.routeOptions.url ?? '',
            by: 'route',
          })
        const r = await tx.one<RequestRow>(
          `SELECT ${REQUEST_COLUMNS} FROM access_requests r WHERE r.id = $1 FOR UPDATE`,
          [id],
        )
        if (r.status !== 'pending')
          throw conflict('ALREADY_DECIDED', 'Someone already answered this request.')
        const at = now()
        const role: RequestRole | null = decision === 'approve' ? (asked ?? r.role_requested) : null
        if (role) {
          // An outsider becomes a workspace guest (guests see only boards granted to them). The DO UPDATE
          // changes nothing but locks an existing membership row (membership, then grant: access.ts), as
          // in redeemInvitation.
          await tx.query(
            `INSERT INTO workspace_members AS m (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', $3)
             ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = m.role`,
            [r.workspace_id, r.user_id, at],
          )
          await tx.query(
            `INSERT INTO board_members AS bm (board_id, user_id, role, added_by, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (board_id, user_id) DO UPDATE SET
               role = CASE WHEN ${boardRank('EXCLUDED.role')} > ${boardRank('bm.role')} THEN EXCLUDED.role ELSE bm.role END,
               added_by = CASE WHEN ${boardRank('EXCLUDED.role')} > ${boardRank('bm.role')} THEN EXCLUDED.added_by ELSE bm.added_by END`,
            [r.board_id, r.user_id, role, user.id, at],
          )
          await audit(tx, {
            workspaceId: r.workspace_id,
            actorId: user.id,
            action: 'board.member.put',
            target: r.board_id,
            detail: { userId: r.user_id, role, via: 'access_request', requestId: r.id },
            at,
          })
        }
        await tx.query(
          `UPDATE access_requests SET status = $2, decided_by = $3, decided_at = $4, updated_at = $4,
                  role_granted = $5
            WHERE id = $1`,
          [id, role ? 'approved' : 'denied', user.id, at, role],
        )
        if (role)
          await notifyGranted(tx, {
            workspaceId: r.workspace_id,
            boardId: r.board_id,
            userId: r.user_id,
            actorId: user.id,
            at,
          })
        const row = await tx.one<ListedRow>(`${LISTED_SELECT} WHERE r.id = $1`, [id])
        return { request: serialize(row, access.board.visibility), granted: role !== null }
      })
      // REVIEW-6: the approver is named to the person approved (the session's user)
      if (result.granted)
        notifier.accessChanged({
          boardId: result.request.boardId,
          userId: result.request.user.id,
          actor: actorOf(user),
        })
      publishSharingChanged(ctx, result.request.boardId, `access-request-${decision}`)
      return { request: result.request }
    })
  }
}
