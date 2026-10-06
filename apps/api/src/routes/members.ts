// Board members: who has access and why, plus grant/change/revoke (docs/M1-CONTRACTS.md §5).
//
// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md D4, D5, §4.2): PUT gives access only when the caller
// is a creator (adding a grant, raising one, owner). Lowering a direct grant, keeping it, and DELETE
// stay open to every manager, a creator's grant included (the last-owner rule is unchanged). Nobody
// makes a non-creator a board owner.
//
// Removing someone (DELETE) also denies their pending access request for the board and revokes unused
// invitations to it addressed to them (J2: `endPendingOnBoard` below), as removing a workspace member does
// for the whole workspace.

import { type BoardMember, PutMemberInput } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  BOARD_ROLES,
  type BoardRole,
  type BoardVisibility,
  resolveBoardRole,
  type WorkspaceRole,
} from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { type BoardAccess, isUserId, requireBoardAction } from '../access.ts'
import { audit } from '../audit.ts'
import { roleRequiresCreator } from '../auth/identity.ts'
import { storedEmails } from '../auth/users.ts'
import type { AppContext, Params } from '../context.ts'
import { conflict, notFound, parse } from '../errors.ts'
import { actorOf } from '../notifier.ts'
import { toUser, type UserRow } from '../serialize.ts'

const RANK = Object.fromEntries(BOARD_ROLES.map((r, i) => [r, BOARD_ROLES.length - i])) as Record<
  BoardRole,
  number
>

/**
 * Everyone who can open the board: explicit grants plus access that comes from the workspace
 * (owners/admins everywhere; members through workspace_view/workspace_edit visibility).
 */
export async function listBoardMembers(
  q: Queryable,
  board: { id: string; workspace_id: string; visibility: BoardVisibility },
): Promise<BoardMember[]> {
  const rows = await q.query<UserRow & { workspace_role: WorkspaceRole; board_grant: BoardRole | null }>(
    `SELECT u.id, u.name, u.handle, u.color, u.avatar_url, wm.role AS workspace_role, bm.role AS board_grant
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
      WHERE wm.workspace_id = $2
        AND (wm.role IN ('owner', 'admin') OR bm.role IS NOT NULL
             OR (wm.role = 'member' AND $3::text <> 'private'))`,
    [board.id, board.workspace_id, board.visibility],
  )
  const members: BoardMember[] = []
  for (const { workspace_role, board_grant, ...user } of rows.rows) {
    const role = resolveBoardRole({
      workspaceRole: workspace_role,
      boardGrant: board_grant,
      visibility: board.visibility,
    })
    if (!role) continue
    members.push({
      user: toUser(user),
      role,
      source: board_grant && board_grant === role ? 'grant' : 'workspace',
    })
  }
  return members.sort((a, b) => RANK[b.role] - RANK[a.role] || a.user.name.localeCompare(b.user.name))
}

export interface TargetRow {
  workspace_role: WorkspaceRole
  board_grant: BoardRole | null
}

/**
 * The target must already belong to the board's workspace: outsiders are added through invitations.
 * The membership row is read FOR SHARE and held to the end of the transaction: removing the member
 * (routes/workspaces.ts) deletes that row before it sweeps their grants, so it waits for a grant that
 * was given just now and then sweeps it, or goes first and this finds nobody (404). Without the lock the
 * grant could land after the removal's sweep and outlive the membership (authz-006 follow-up 6). Lock
 * order: the board row (the caller's FOR UPDATE), then this row, then board_members.
 */
export async function loadTarget(tx: Queryable, access: BoardAccess, userId: string): Promise<TargetRow> {
  const row = await tx.maybeOne<TargetRow>(
    `SELECT wm.role AS workspace_role, bm.role AS board_grant
       FROM workspace_members wm
       LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
      WHERE wm.workspace_id = $2 AND wm.user_id = $3
        FOR SHARE OF wm`,
    [access.board.id, access.board.workspace_id, userId],
  )
  if (!row) throw notFound()
  return row
}

/** Owner grants other than `userId` held by people still in the workspace. */
async function otherOwners(tx: Queryable, access: BoardAccess, userId: string): Promise<number> {
  const row = await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM board_members bm
       JOIN workspace_members wm ON wm.workspace_id = $2 AND wm.user_id = bm.user_id
      WHERE bm.board_id = $1 AND bm.role = 'owner' AND bm.user_id <> $3`,
    [access.board.id, access.board.workspace_id, userId],
  )
  return row.n
}

const LAST_OWNER_MESSAGE = 'A board needs at least one owner. Make someone else an owner first.'

export function registerMemberRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, notifier, now } = ctx

  /**
   * J2: removing someone from a board also ends what they still had in flight ON THAT BOARD, in the same
   * transaction (the board-level half of routes/workspaces.ts `endPendingOf`):
   *   - their pending access request for it: denied, by whoever removed them (INV-5). Approving it later
   *     would hand the board straight back to the person just removed, with nothing on the card saying
   *     so; as with any denial, the one-day pause before asking again applies;
   *   - unused single-use invitations to the board locked to one of their stored addresses (INV-3): revoked
   *     and audited, or they open the one they still hold and are back.
   * Multi-use links are bearer links addressed to nobody: they stay (a manager revokes those). Call with
   * the board row locked and before the membership row is read (`loadTarget`): these are rows of the
   * board (step 2 of the lock order in access.ts), which accepting and approving take after the board too.
   */
  async function endPendingOnBoard(
    tx: Queryable,
    access: BoardAccess,
    uid: string,
    actorId: string,
    at: Date,
  ): Promise<{ requests: number; invitations: number }> {
    const { id: boardId, workspace_id: workspaceId } = access.board
    const requests = await tx.query(
      `UPDATE access_requests SET status = 'denied', decided_by = $3, decided_at = $4, updated_at = $4
        WHERE board_id = $1 AND user_id = $2 AND status = 'pending'`,
      [boardId, uid, actorId, at],
    )
    const emails = await storedEmails(tx, uid, ctx.identity.lookup.source)
    const invitations = emails.length
      ? await tx.query<{ id: string }>(
          `UPDATE invitations SET revoked_at = $4
            WHERE board_id = $1 AND workspace_id = $2 AND invited_email = ANY($3::text[]) AND NOT multi_use
              AND redeemed_by IS NULL AND revoked_at IS NULL AND expires_at > $4
            RETURNING id`,
          [boardId, workspaceId, emails, at],
        )
      : { rows: [] }
    for (const inv of invitations.rows)
      await audit(tx, {
        workspaceId,
        actorId,
        action: 'invitation.revoke',
        target: inv.id,
        detail: { boardId, via: 'member_removed', userId: uid, invitee: true },
        at,
      })
    return { requests: requests.rowCount, invitations: invitations.rows.length }
  }

  app.get('/api/boards/:bid/members', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const members = await listBoardMembers(db, access.board)
    // A guest (an outside reviewer who joined through a link) sees who else is on the board, but not
    // the workspace's @handles: those are how people are found and invited inside the workspace.
    if (access.workspaceRole === 'guest' || access.workspaceRole === null)
      return {
        members: members.map((m) =>
          m.user.id === user.id ? m : { ...m, user: { ...m.user, handle: null } },
        ),
      }
    return { members }
  })

  app.put('/api/boards/:bid/members/:uid', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', uid = '' } = req.params as Params
    const { role } = parse(PutMemberInput, req.body)
    const route = req.routeOptions.url ?? ''
    if (role === 'owner') {
      // Unlocked pre-check (today's 404/403 answers), then the target's identity when unknown or
      // stale: outside any transaction, never throwing, never signing anyone out. Only a creator's
      // request can make an owner, so nobody else triggers a provider call here.
      const seen = await requireBoardAction(db, bid, user.id, 'manage_access')
      if (!isUserId(uid)) throw notFound()
      const member = await db.maybeOne(
        'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [seen.board.workspace_id, uid],
      )
      if (!member) throw notFound()
      if (await ctx.identity.isCreatorUser(db, user.id)) await ctx.identity.refreshTarget(uid)
    }
    const result = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if (!isUserId(uid)) throw notFound()
      const target = await loadTarget(tx, access, uid)
      const changed = target.board_grant !== role
      // D5: nobody makes a non-creator an owner (whoever asks). Keeping an existing grant is a no-op.
      if (changed && role === 'owner' && !(await ctx.identity.isCreatorUser(tx, uid)))
        throw roleRequiresCreator()
      if (target.board_grant === 'owner' && role !== 'owner' && (await otherOwners(tx, access, uid)) === 0)
        throw conflict('LAST_OWNER', LAST_OWNER_MESSAGE)
      // D4: lowering a direct grant is open to every manager; adding or raising one needs a creator.
      const lowering = target.board_grant !== null && RANK[role] < RANK[target.board_grant]
      if (changed && !lowering)
        await ctx.identity.requireCreator(tx, user.id, 'share', { route, by: 'route' })
      if (changed) {
        const at = now()
        await tx.query(
          `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role, added_by = EXCLUDED.added_by`,
          [bid, uid, role, user.id, at],
        )
        await audit(tx, {
          workspaceId: access.board.workspace_id,
          actorId: user.id,
          action: 'board.member.put',
          target: bid,
          detail: { userId: uid, role, previousRole: target.board_grant },
          at,
        })
      }
      return { changed, members: await listBoardMembers(tx, access.board) }
    })
    // REVIEW-6: only a change that changed something is told, and with who made it (the session's user)
    if (result.changed) notifier.accessChanged({ boardId: bid, userId: uid, actor: actorOf(user) })
    return { members: result.members }
  })

  app.delete('/api/boards/:bid/members/:uid', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', uid = '' } = req.params as Params
    const result = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if (!isUserId(uid)) throw notFound()
      const at = now()
      // What they still had in flight on this board ends with the removal, BEFORE their membership row is
      // read (lock order, access.ts: the board row, then rows of the board, then the membership, then the
      // grant). A refused removal (404, LAST_OWNER) rolls it back with the rest.
      const left = await endPendingOnBoard(tx, access, uid, user.id, at)
      const target = await loadTarget(tx, access, uid)
      if (target.board_grant === 'owner' && (await otherOwners(tx, access, uid)) === 0)
        throw conflict('LAST_OWNER', LAST_OWNER_MESSAGE)
      const changed = target.board_grant !== null
      if (changed) {
        await tx.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [bid, uid])
        await audit(tx, {
          workspaceId: access.board.workspace_id,
          actorId: user.id,
          action: 'board.member.remove',
          target: bid,
          detail: {
            userId: uid,
            previousRole: target.board_grant,
            ...(left.invitations ? { invitationsToThemRevoked: left.invitations } : {}),
            ...(left.requests ? { accessRequestsDenied: left.requests } : {}),
          },
          at,
        })
      }
      return { changed, members: await listBoardMembers(tx, access.board) }
    })
    if (result.changed) notifier.accessChanged({ boardId: bid, userId: uid, actor: actorOf(user) })
    return { members: result.members }
  })
}
