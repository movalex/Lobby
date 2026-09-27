// Board members: who has access and why, plus grant/change/revoke (docs/M1-CONTRACTS.md §5).

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
import type { AppContext, Params } from '../context.ts'
import { conflict, notFound, parse } from '../errors.ts'
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

interface TargetRow {
  workspace_role: WorkspaceRole
  board_grant: BoardRole | null
}

/** The target must already belong to the board's workspace: outsiders are added through invitations. */
async function loadTarget(tx: Queryable, access: BoardAccess, userId: string): Promise<TargetRow> {
  const row = await tx.maybeOne<TargetRow>(
    `SELECT wm.role AS workspace_role, bm.role AS board_grant
       FROM workspace_members wm
       LEFT JOIN board_members bm ON bm.board_id = $1 AND bm.user_id = wm.user_id
      WHERE wm.workspace_id = $2 AND wm.user_id = $3`,
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
    const result = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if (!isUserId(uid)) throw notFound()
      const target = await loadTarget(tx, access, uid)
      if (target.board_grant === 'owner' && role !== 'owner' && (await otherOwners(tx, access, uid)) === 0)
        throw conflict('LAST_OWNER', LAST_OWNER_MESSAGE)
      const changed = target.board_grant !== role
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
    if (result.changed) notifier.accessChanged({ boardId: bid, userId: uid })
    return { members: result.members }
  })

  app.delete('/api/boards/:bid/members/:uid', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', uid = '' } = req.params as Params
    const result = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if (!isUserId(uid)) throw notFound()
      const target = await loadTarget(tx, access, uid)
      if (target.board_grant === 'owner' && (await otherOwners(tx, access, uid)) === 0)
        throw conflict('LAST_OWNER', LAST_OWNER_MESSAGE)
      const changed = target.board_grant !== null
      if (changed) {
        const at = now()
        await tx.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [bid, uid])
        await audit(tx, {
          workspaceId: access.board.workspace_id,
          actorId: user.id,
          action: 'board.member.remove',
          target: bid,
          detail: { userId: uid, previousRole: target.board_grant },
          at,
        })
      }
      return { changed, members: await listBoardMembers(tx, access.board) }
    })
    if (result.changed) notifier.accessChanged({ boardId: bid, userId: uid })
    return { members: result.members }
  })
}
