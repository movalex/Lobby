// Sharing state for the board header badge (PRS-03), the detailed "who has access and why" list for
// the Share dialog (PRS-02), and transfer of ownership.

import { type ShareMember, TransferOwnershipInput } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  BOARD_ROLES,
  type BoardRole,
  can,
  resolveBoardRole,
  type WorkspaceRole,
} from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { isUserId, requireBoardAction } from '../../access.ts'
import { audit } from '../../audit.ts'
import { roleRequiresCreator } from '../../auth/identity.ts'
import type { Params } from '../../context.ts'
import { badRequest, notFound, parse } from '../../errors.ts'
import { actorOf } from '../../notifier.ts'
import { listBoardMembers } from '../../routes/members.ts'
import { toUser, type UserRow } from '../../serialize.ts'
import type { FeatureContext } from '../context.ts'
import { publishSharingChanged } from './shared.ts'

const RANK = Object.fromEntries(BOARD_ROLES.map((r, i) => [r, BOARD_ROLES.length - i])) as Record<
  BoardRole,
  number
>

/** M1 routes that change who can open a board, and what makes each one a sharing change. */
const M1_SHARING_ROUTES: Record<string, (method: string, body: unknown) => boolean> = {
  '/api/boards/:bid': (method, body) =>
    method === 'PATCH' && typeof body === 'object' && body !== null && 'visibility' in body,
  '/api/boards/:bid/members/:uid': (method) => method === 'PUT' || method === 'DELETE',
}

export function registerSharingRoutes(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, now, notifier } = ctx

  // M1's visibility and member routes publish nothing, so everyone else's header badge would wait
  // for its slow refresh. A root hook (bound to every route at ready time, like the starred flag in
  // stars.ts) sends the same identity-free hint once such a change succeeded. onResponse runs after
  // the reply, i.e. after the route's transaction committed.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url
    const isChange = route ? M1_SHARING_ROUTES[route] : undefined
    if (!isChange || reply.statusCode >= 300 || !isChange(req.method, req.body)) return
    const { bid } = req.params as Params
    if (bid) publishSharingChanged(ctx, bid, req.method === 'PATCH' ? 'visibility' : 'grant')
  })

  app.get('/api/boards/:bid/sharing', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const { board } = access
    const links = await db.query<{ role: 'viewer' | 'commenter'; expires_at: Date }>(
      `SELECT role, expires_at FROM invitations
        WHERE board_id = $1 AND multi_use AND revoked_at IS NULL AND expires_at > $2
        ORDER BY expires_at, id LIMIT 20`,
      [board.id, now()],
    )
    const direct = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM board_members bm
         JOIN workspace_members wm ON wm.workspace_id = $2 AND wm.user_id = bm.user_id
        WHERE bm.board_id = $1`,
      [board.id, board.workspace_id],
    )
    let pendingRequests: number | null = null
    if (can(access.role, 'manage_access', board.status)) {
      const row = await db.one<{ n: number }>(
        "SELECT count(*)::int AS n FROM access_requests WHERE board_id = $1 AND status = 'pending'",
        [board.id],
      )
      pendingRequests = row.n
    }
    return {
      visibility: board.visibility,
      links: links.rows.map((l) => ({ role: l.role, expiresAt: l.expires_at.toISOString() })),
      directCount: direct.n,
      pendingRequests,
    }
  })

  app.get('/api/boards/:bid/sharing/members', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'manage_access')
    // Domain access (§4.2): the caller is freshened like at /api/me (a background refresh after 1 h), so a
    // manager who never loads /api/me still loses a removed company address. After the permission check:
    // nobody else makes Lobby call the provider from here. Fixer round 4 (§22): the list (canOwn included)
    // is read before a due background refresh starts (freshenThen), so it is stored data on a pool too.
    return ctx.identity.freshenThen(req, user, async () => {
      const { board } = access
      const rows = await db.query<
        UserRow & {
          workspace_role: WorkspaceRole
          board_grant: BoardRole | null
          via_link: boolean
          link_ends_at: Date | null
        }
      >(
        `SELECT u.id, u.name, u.handle, u.color, u.avatar_url, wm.role AS workspace_role, bm.role AS board_grant,
              EXISTS (
                SELECT 1 FROM invitation_redemptions r JOIN invitations i ON i.id = r.invitation_id
                 WHERE r.board_id = $1 AND r.user_id = u.id AND i.multi_use
                   AND r.redeemed_at = bm.created_at AND i.role = bm.role
              ) AS via_link,
              (SELECT max(i.expires_at) FROM invitation_redemptions r JOIN invitations i ON i.id = r.invitation_id
                WHERE r.board_id = $1 AND r.user_id = u.id AND i.multi_use AND i.swept_at IS NULL
              ) AS link_ends_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
        WHERE wm.workspace_id = $2
          AND (wm.role IN ('owner', 'admin') OR bm.role IS NOT NULL
               OR (wm.role = 'member' AND $3::text <> 'private'))`,
        [board.id, board.workspace_id, board.visibility],
      )
      // Domain access (D5): who may be made an owner. One query; true while someone was never checked
      // (the server refreshes and decides at PUT).
      const canOwn = await ctx.identity.canOwnAmong(
        db,
        rows.rows.map((r) => r.id),
      )
      const members: ShareMember[] = []
      for (const { workspace_role, board_grant, via_link, link_ends_at, ...u } of rows.rows) {
        const role = resolveBoardRole({
          workspaceRole: workspace_role,
          boardGrant: board_grant,
          visibility: board.visibility,
        })
        if (!role) continue
        const viaReviewLink = board_grant !== null && via_link
        members.push({
          user: toUser(u),
          role,
          source: board_grant && board_grant === role ? 'grant' : 'workspace',
          grant: board_grant,
          workspaceRole: workspace_role,
          withoutGrant: resolveBoardRole({
            workspaceRole: workspace_role,
            boardGrant: null,
            visibility: board.visibility,
          }),
          viaReviewLink,
          linkEndsAt: viaReviewLink && link_ends_at ? link_ends_at.toISOString() : null,
          canOwn: canOwn.get(u.id) ?? false,
        })
      }
      members.sort((a, b) => RANK[b.role] - RANK[a.role] || a.user.name.localeCompare(b.user.name))
      return { members }
    })
  })

  // Makes someone in the workspace an owner and steps the caller's own owner grant down to editor, in
  // one transaction (so the board never has zero owners in between). A workspace owner/admin keeps
  // owning every board through the workspace; only their direct grant changes.
  // Domain access (D4, D5): the caller must be a creator, and so must the target. The target's stored
  // addresses are confirmed first (identity.refreshTarget) when unknown or older than 24 h, after the
  // route's own permission checks and outside any transaction; it never throws or signs anyone out.
  app.post('/api/boards/:bid/transfer-ownership', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const { userId } = parse(TransferOwnershipInput, req.body)
    const route = req.routeOptions.url ?? ''
    const findTarget = (q: Queryable, workspaceId: string) =>
      q.maybeOne<{ board_grant: BoardRole | null }>(
        `SELECT bm.role AS board_grant FROM workspace_members wm
           LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
          WHERE wm.workspace_id = $2 AND wm.user_id = $3`,
        [bid, workspaceId, userId],
      )
    // 1) Unlocked pre-check: today's answers (404/403/400), then the caller's creator status.
    const seen = await requireBoardAction(db, bid, user.id, 'manage_access')
    if (userId === user.id) throw badRequest('Pick someone else to transfer ownership to.')
    if (!isUserId(userId)) throw notFound()
    if (!(await findTarget(db, seen.board.workspace_id))) throw notFound()
    await ctx.identity.requireCreator(db, user.id, 'share', { route, by: 'route' })
    // 2) The target's identity, when unknown or stale (no lock held).
    await ctx.identity.refreshTarget(userId)
    // 3) The change, deciding on stored data.
    const result = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      await ctx.identity.requireCreator(tx, user.id, 'share', { route, by: 'route' })
      const target = await findTarget(tx, access.board.workspace_id)
      if (!target) throw notFound() // outsiders are added through invitations first
      if (!(await ctx.identity.isCreatorUser(tx, userId))) throw roleRequiresCreator()
      const at = now()
      await tx.query(
        `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'owner', $3, $4)
         ON CONFLICT (board_id, user_id) DO UPDATE SET role = 'owner', added_by = EXCLUDED.added_by`,
        [bid, userId, user.id, at],
      )
      await audit(tx, {
        workspaceId: access.board.workspace_id,
        actorId: user.id,
        action: 'board.member.put',
        target: bid,
        detail: { userId, role: 'owner', previousRole: target.board_grant, via: 'transfer_ownership' },
        at,
      })
      const stepDown = access.grant === 'owner'
      if (stepDown) {
        await tx.query("UPDATE board_members SET role = 'editor' WHERE board_id = $1 AND user_id = $2", [
          bid,
          user.id,
        ])
        await audit(tx, {
          workspaceId: access.board.workspace_id,
          actorId: user.id,
          action: 'board.member.put',
          target: bid,
          detail: { userId: user.id, role: 'editor', previousRole: 'owner', via: 'transfer_ownership' },
          at,
        })
      }
      return { members: await listBoardMembers(tx, access.board), stepDown }
    })
    // REVIEW-6: the new owner hears who made them one; the step-down is the actor's own (no name)
    notifier.accessChanged({ boardId: bid, userId, actor: actorOf(user) })
    if (result.stepDown) notifier.accessChanged({ boardId: bid, userId: user.id })
    publishSharingChanged(ctx, bid, 'ownership-transferred')
    return { members: result.members }
  })
}
