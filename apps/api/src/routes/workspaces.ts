// Workspace members and projects (docs/M1-CONTRACTS.md §5). "member+" = owner, admin or member:
// guests belong to a workspace only to reach the boards they were invited to.
//
// Managing members (authz-006): owners and admins change a member's role (PATCH) or remove them
// (DELETE). Only an owner changes or removes an owner, or makes someone one; the last owner, and the
// person whose personal workspace it is, stay owners. Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md D4,
// D5): raising a role hands out access, so it is creator-only, and admin and owner go to creators only;
// lowering and removing stay open to every manager, as on boards. Removing a member also removes every
// board grant they hold in the workspace, in the same transaction. Both changes are pushed to sync and
// the event streams (`accessChanged`) for every board whose access they change, so the person's open
// tabs lose what they lost at once (the sync server's periodic re-check, ACCESS_RECHECK_MS, is the
// backstop).
//
// Offboarding (the removal's other half, docs/DOMAIN-ACCESS-CONTRACTS.md §13): what the leaver still had
// in flight in this workspace ends in the same transaction, decided per kind:
//   - single-use invitations they SENT that nobody has used yet: revoked (an unused link from someone
//     who is gone is an open door nobody answers for; the invitee asks the workspace again). Used ones
//     stand: those grants are the invitee's own;
//   - access requests they MADE that are still pending: denied (approving one later would hand a removed
//     person a fresh guest membership and board grant). It is a decision like any other, so the usual
//     one-day pause before asking again applies;
//   - multi-use links they made (review, workshop and guest links): KEPT. A link belongs to its board,
//     whose managers see it in the Share dialog (the maker's name stays on the row) and can revoke it;
//     it ends by itself within 24 hours (workshop) to 30 days (review). The audit entry names the links
//     kept, so nobody has to go looking;
//   - their own grants: removed, as above.
//
// Locks: the workspace row first, FOR NO KEY UPDATE (as uploads and board creation take it), so the
// member changes of one workspace run one at a time (the last-owner count) while rows that reference the
// workspace are not blocked. A removal then takes the leaver's pending request rows and unused invitation
// rows (an approval that holds a request finishes first; one that comes later finds it answered), then
// their workspace_members row (the DELETE), and only then their board_members rows. The membership goes
// before the grants because a grant given to "a member" holds the membership row until it commits
// (members.ts `loadTarget` reads it FOR SHARE): the removal waits for it and then sweeps what it added,
// or goes first and the grant finds nobody (404). With the grants first, such a grant could land after the
// sweep and outlive the membership. The membership row is not locked before the requests and invitations:
// an approval holding the request has the board, and its guest-membership insert waits for a membership row
// a removal has already deleted, which the removal's wait for that request would turn into a deadlock.
//
// Not closed from here: the two grant paths that insert the guest membership with ON CONFLICT DO NOTHING
// (invitations.ts redeemInvitation, dashboard/email-invites.ts grant) take no lock on an existing
// membership row, so one that has read the membership just before a removal began can still insert its
// grant after the sweep. The fix is theirs (DO UPDATE SET role = workspace_members.role locks the row;
// redeemInvitation must also read its `prior` grant after that insert so both paths lock membership, then
// grant). Until then, a person removed in exactly that window is left with an orphan grant: it gives
// nothing while they are no member (resolveBoardRole needs a workspace role, and the board's member list
// joins workspace members), but it comes back to life if they join the workspace again.

import {
  CreateProjectInput,
  PatchProjectInput,
  PatchWorkspaceMemberInput,
  ProjectId,
  WORKSPACE_MEMBER_CODES,
  type WorkspaceMember,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import {
  type BoardRole,
  type BoardVisibility,
  canCreateInWorkspace,
  canManageWorkspace,
  resolveBoardRole,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isUserId, isWorkspaceId, requireWorkspaceRole } from '../access.ts'
import { audit } from '../audit.ts'
import { roleRequiresCreator } from '../auth/identity.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError, badRequest, conflict, forbidden, notFound, parse } from '../errors.ts'
import { type ProjectRow, toProject, toUser, type UserRow } from '../serialize.ts'

const PROJECT_COLUMNS = 'id, workspace_id, name, created_at, archived_at'
const WS_RANK = Object.fromEntries(WORKSPACE_ROLES.map((r, i) => [r, i])) as Record<WorkspaceRole, number>

/**
 * The most boards one member change tells sync about (the most recently opened first). Past it, the
 * sync server's periodic re-check (ACCESS_RECHECK_MS) ends what is open on the rest.
 */
export const MAX_ACCESS_NOTIFICATIONS = 500

const LAST_OWNER_MESSAGE = 'A workspace needs at least one owner. Make someone else an owner first.'
const OWNER_ONLY_MESSAGE = 'Only a workspace owner can change, remove or add an owner.'
const PERSONAL_OWNER_MESSAGE = 'A personal workspace always keeps the person it belongs to as its owner.'

/** The workspace's people, owners first. */
export async function listWorkspaceMembers(q: Queryable, workspaceId: string): Promise<WorkspaceMember[]> {
  // Wave 3: name-only guests (users.kind 'guest') are left out. They reach boards only through guest
  // links, so this list (the Share dialog's picker) could only offer an add the server refuses.
  const rows = await q.query<UserRow & { role: WorkspaceRole }>(
    `SELECT u.id, u.name, u.handle, u.color, u.avatar_url, m.role
       FROM workspace_members m JOIN users u ON u.id = m.user_id AND u.kind <> 'guest'
      WHERE m.workspace_id = $1`,
    [workspaceId],
  )
  const members: WorkspaceMember[] = rows.rows.map(({ role, ...u }) => ({ user: toUser(u), role }))
  members.sort((a, b) => WS_RANK[a.role] - WS_RANK[b.role] || a.user.name.localeCompare(b.user.name))
  return members
}

interface BoardAccessRow {
  id: string
  visibility: BoardVisibility
  grant: BoardRole | null
}

/** The workspace's boards that can be opened, with `userId`'s grant on each (most recently opened first). */
async function boardsWithGrant(q: Queryable, workspaceId: string, userId: string): Promise<BoardAccessRow[]> {
  const rows = await q.query<BoardAccessRow>(
    `SELECT b.id, b.visibility, bm.role AS grant
       FROM boards b LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = $2
      WHERE b.workspace_id = $1 AND b.status <> 'trashed'
      ORDER BY b.last_opened_at DESC NULLS LAST, b.id`,
    [workspaceId, userId],
  )
  return rows.rows
}

/** The boards on which the role of the person holding these grants differs before and after (null: gone). */
function changedBoards(
  boards: readonly BoardAccessRow[],
  before: WorkspaceRole,
  after: WorkspaceRole | null,
): string[] {
  const out: string[] = []
  for (const b of boards) {
    const was = resolveBoardRole({ workspaceRole: before, boardGrant: b.grant, visibility: b.visibility })
    const is =
      after === null
        ? null
        : resolveBoardRole({ workspaceRole: after, boardGrant: b.grant, visibility: b.visibility })
    if (was !== is) out.push(b.id)
  }
  return out
}

/** `uid`'s role in the workspace, unlocked; null for a non-member and for a name-only guest account. */
const readMember = (q: Queryable, wid: string, uid: string) =>
  q.maybeOne<{ role: WorkspaceRole }>(
    `SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id AND u.kind <> 'guest'
      WHERE m.workspace_id = $1 AND m.user_id = $2`,
    [wid, uid],
  )

/** The most multi-use links one removal names in its audit entry (the count is always exact). */
const MAX_LINKS_NAMED = 20

/** What a removal ended or left of the leaver's in-flight business in the workspace. */
interface Offboarded {
  /** Their unused single-use invitations, revoked. */
  invitations: { id: string; boardId: string | null }[]
  /** Their pending access requests, denied. */
  requests: { id: string; boardId: string }[]
  /** Multi-use links they made that stay open (the count, and the first MAX_LINKS_NAMED ids). */
  linksKept: { count: number; ids: string[] }
}

interface MemberChange {
  members: WorkspaceMember[]
  /** Boards whose access changed for the target (empty: nothing changed). */
  boards: string[]
}

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, notifier, now } = ctx

  /**
   * A removal's first step: ends what the leaver had in flight in this workspace (the decisions are at the
   * top of this file). Run before their membership row is touched.
   */
  async function endPendingOf(
    tx: Queryable,
    wid: string,
    uid: string,
    actorId: string,
    at: Date,
  ): Promise<Offboarded> {
    // Their pending requests: denied, by whoever removed them. The pending-only filter is re-evaluated
    // after waiting for a request an approval holds, so one approved meanwhile is left as approved (its
    // grant is removed with the rest below).
    const requests = await tx.query<{ id: string; board_id: string }>(
      `UPDATE access_requests
          SET status = 'denied', decided_by = $3, decided_at = $4, updated_at = $4
        WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING id, board_id`,
      [wid, uid, actorId, at],
    )
    // Their unused single-use invitations: revoked. Used ones stand (their grants are the invitee's own
    // and are left alone), and so do expired ones (nothing to revoke).
    const invitations = await tx.query<{ id: string; board_id: string | null }>(
      `UPDATE invitations SET revoked_at = $3
        WHERE workspace_id = $1 AND created_by = $2 AND NOT multi_use
          AND redeemed_by IS NULL AND revoked_at IS NULL AND expires_at > $3
        RETURNING id, board_id`,
      [wid, uid, at],
    )
    for (const inv of invitations.rows)
      await audit(tx, {
        workspaceId: wid,
        actorId,
        action: 'invitation.revoke',
        target: inv.id,
        detail: { boardId: inv.board_id, via: 'member_removed', userId: uid },
        at,
      })
    // Their multi-use links stay open (see the top of this file); only counted and named.
    const links = await tx.query<{ id: string; total: number }>(
      `SELECT id, count(*) OVER ()::int AS total FROM invitations
        WHERE workspace_id = $1 AND created_by = $2 AND multi_use AND revoked_at IS NULL AND expires_at > $3
        ORDER BY created_at, id LIMIT ${MAX_LINKS_NAMED}`,
      [wid, uid, at],
    )
    return {
      invitations: invitations.rows.map((r) => ({ id: r.id, boardId: r.board_id })),
      requests: requests.rows.map((r) => ({ id: r.id, boardId: r.board_id })),
      linksKept: { count: links.rows[0]?.total ?? 0, ids: links.rows.map((r) => r.id) },
    }
  }

  /** After the change committed: sync and this process's event streams hear about the target. */
  const tell = (change: MemberChange, userId: string) => {
    for (const boardId of change.boards.slice(0, MAX_ACCESS_NOTIFICATIONS))
      notifier.accessChanged({ boardId, userId })
  }

  /** Unlocked pre-check: today's answers (404 outside the workspace, 403 for a member or guest). */
  async function precheck(
    req: FastifyRequest,
    callerId: string,
  ): Promise<{ wid: string; uid: string; callerRole: WorkspaceRole }> {
    const { wid = '', uid = '' } = req.params as Params
    if (!isWorkspaceId(wid)) throw notFound()
    const callerRole = await requireWorkspaceRole(db, wid, callerId)
    if (!canManageWorkspace(callerRole)) throw forbidden()
    if (!isUserId(uid)) throw notFound()
    return { wid, uid, callerRole }
  }

  /**
   * The checks every member change shares, inside its transaction: the workspace row locked, the caller
   * still an owner or admin, the target a member (a name-only guest or an unknown id is a 404), and an
   * owner target only for an owner caller.
   */
  async function lockAndLoad(tx: Queryable, wid: string, callerId: string, uid: string) {
    const ws = await tx.maybeOne<{ personal_of: string | null }>(
      'SELECT personal_of FROM workspaces WHERE id = $1 FOR NO KEY UPDATE',
      [wid],
    )
    if (!ws) throw notFound()
    const callerRole = await requireWorkspaceRole(tx, wid, callerId)
    if (!canManageWorkspace(callerRole)) throw forbidden()
    const target = await readMember(tx, wid, uid)
    if (!target) throw notFound()
    if (target.role === 'owner' && callerRole !== 'owner')
      throw new ApiError(403, WORKSPACE_MEMBER_CODES.ownerOnly, OWNER_ONLY_MESSAGE)
    return { callerRole, targetRole: target.role, personalOf: ws.personal_of }
  }

  /** The owner rules for taking `uid` out of the owners (a demotion or a removal). */
  async function mayStopOwning(tx: Queryable, wid: string, uid: string, personalOf: string | null) {
    if (personalOf === uid) throw conflict(WORKSPACE_MEMBER_CODES.personalOwner, PERSONAL_OWNER_MESSAGE)
    const others = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM workspace_members
        WHERE workspace_id = $1 AND role = 'owner' AND user_id <> $2`,
      [wid, uid],
    )
    if (others.n === 0) throw conflict(WORKSPACE_MEMBER_CODES.lastOwner, LAST_OWNER_MESSAGE)
  }

  app.get('/api/workspaces/:wid/members', async (req) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!canCreateInWorkspace(role)) throw forbidden()
    return { members: await listWorkspaceMembers(db, wid) }
  })

  app.patch('/api/workspaces/:wid/members/:uid', async (req) => {
    const user = await ctx.requireUser(req)
    const { role } = parse(PatchWorkspaceMemberInput, req.body)
    const { wid, uid, callerRole } = await precheck(req, user.id)
    const route = req.routeOptions.url ?? ''
    // The target is a member, and the owner rule holds, BEFORE the identity provider is asked anything:
    // a manager naming an id that is no member of this workspace, or a change that is refused anyway,
    // makes Lobby call nobody (authz-006 follow-up 6; the transaction below decides again, locked).
    const seen = await readMember(db, wid, uid)
    if (!seen) throw notFound()
    if (callerRole !== 'owner' && (seen.role === 'owner' || role === 'owner'))
      throw new ApiError(403, WORKSPACE_MEMBER_CODES.ownerOnly, OWNER_ONLY_MESSAGE)
    // D5: admin and owner go to creators only, so only a RAISE to one of them needs the target's creator
    // status. Their stored addresses are confirmed first when unknown or stale (outside any transaction,
    // never throwing), and only for a creator's request, so nobody else makes Lobby call the provider
    // from here.
    if (
      (role === 'admin' || role === 'owner') &&
      WS_RANK[role] < WS_RANK[seen.role] &&
      (await ctx.identity.isCreatorUser(db, user.id))
    )
      await ctx.identity.refreshTarget(uid)
    const result = await db.transaction(async (tx): Promise<MemberChange> => {
      const { callerRole, targetRole, personalOf } = await lockAndLoad(tx, wid, user.id, uid)
      if (targetRole === role) return { members: await listWorkspaceMembers(tx, wid), boards: [] }
      if (role === 'owner' && callerRole !== 'owner')
        throw new ApiError(403, WORKSPACE_MEMBER_CODES.ownerOnly, OWNER_ONLY_MESSAGE)
      if (targetRole === 'owner') await mayStopOwning(tx, wid, uid, personalOf)
      // D4: raising a role hands out access (creator-only); lowering stays open to every manager.
      if (WS_RANK[role] < WS_RANK[targetRole]) {
        await ctx.identity.requireCreator(tx, user.id, 'share', { route, by: 'route' })
        if ((role === 'admin' || role === 'owner') && !(await ctx.identity.isCreatorUser(tx, uid)))
          throw roleRequiresCreator()
      }
      const boards = await boardsWithGrant(tx, wid, uid)
      await tx.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2', [
        wid,
        uid,
        role,
      ])
      await audit(tx, {
        workspaceId: wid,
        actorId: user.id,
        action: 'workspace.member.role',
        target: wid,
        detail: { userId: uid, role, previousRole: targetRole },
        at: now(),
      })
      return { members: await listWorkspaceMembers(tx, wid), boards: changedBoards(boards, targetRole, role) }
    })
    tell(result, uid)
    return { members: result.members }
  })

  app.delete('/api/workspaces/:wid/members/:uid', async (req) => {
    const user = await ctx.requireUser(req)
    const { wid, uid } = await precheck(req, user.id)
    const result = await db.transaction(async (tx): Promise<MemberChange> => {
      const { targetRole, personalOf } = await lockAndLoad(tx, wid, user.id, uid)
      if (targetRole === 'owner') await mayStopOwning(tx, wid, uid, personalOf)
      const at = now()
      // 1) What they had in flight (requests and invitations; see the lock notes at the top).
      const left = await endPendingOf(tx, wid, uid, user.id, at)
      // 2) The membership, THEN their grants: whoever still gives them a grant through the membership
      // row finishes first, and what it added goes with the rest.
      const removed = await tx.query(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [wid, uid],
      )
      if (removed.rowCount === 0) throw notFound()
      // read after the membership is gone, so every grant committed up to here is seen
      const boards = await boardsWithGrant(tx, wid, uid)
      // Every grant of theirs on a board of this workspace (trashed ones too).
      const grants = await tx.query<{ board_id: string }>(
        `DELETE FROM board_members bm USING boards b
          WHERE bm.board_id = b.id AND b.workspace_id = $1 AND bm.user_id = $2
          RETURNING bm.board_id`,
        [wid, uid],
      )
      await audit(tx, {
        workspaceId: wid,
        actorId: user.id,
        action: 'workspace.member.remove',
        target: wid,
        detail: {
          userId: uid,
          previousRole: targetRole,
          boardGrantsRemoved: grants.rows.length,
          invitationsRevoked: left.invitations.length,
          accessRequestsDenied: left.requests.length,
          // multi-use links stay: who made them is on each row and here, so a manager can revoke them
          linksKept: left.linksKept.count,
          ...(left.linksKept.count ? { linkIdsKept: left.linksKept.ids } : {}),
        },
        at,
      })
      return { members: await listWorkspaceMembers(tx, wid), boards: changedBoards(boards, targetRole, null) }
    })
    tell(result, uid)
    return { members: result.members }
  })

  app.get('/api/workspaces/:wid/projects', async (req) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!canCreateInWorkspace(role)) throw forbidden()
    const rows = await db.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE workspace_id = $1 ORDER BY created_at, id`,
      [wid],
    )
    return { projects: rows.rows.map(toProject) }
  })

  app.post('/api/workspaces/:wid/projects', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const input = parse(CreateProjectInput, req.body)
    const role = await requireWorkspaceRole(db, wid, user.id)
    if (!canCreateInWorkspace(role)) throw forbidden()
    // Domain access: only creators create projects.
    await ctx.identity.requireCreator(db, user.id, 'create', {
      route: req.routeOptions.url ?? '',
      by: 'route',
    })
    const row = await db.one<ProjectRow>(
      `INSERT INTO projects (id, workspace_id, name, created_at) VALUES ($1, $2, $3, $4) RETURNING ${PROJECT_COLUMNS}`,
      [newId('prj'), wid, input.name, now()],
    )
    reply.code(201)
    return toProject(row)
  })

  app.patch('/api/projects/:pid', async (req) => {
    const user = await ctx.requireUser(req)
    const { pid = '' } = req.params as Params
    const input = parse(PatchProjectInput, req.body)
    if (input.name === undefined && input.archived === undefined) throw badRequest('nothing to update')
    if (!ProjectId.safeParse(pid).success) throw notFound()
    const row = await db.transaction(async (tx) => {
      const project = await tx.maybeOne<{ workspace_id: string; role: WorkspaceRole | null }>(
        `SELECT p.workspace_id, m.role FROM projects p
           LEFT JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
          WHERE p.id = $1 FOR UPDATE OF p`,
        [pid, user.id],
      )
      // Guests cannot list projects, so for them a project id is as invisible as another tenant's.
      if (!project || !canCreateInWorkspace(project.role)) throw notFound()
      // Domain access (D6): renaming, archiving and unarchiving a project lobby is creator-only.
      await ctx.identity.requireCreator(tx, user.id, 'create', {
        route: req.routeOptions.url ?? '',
        by: 'route',
      })
      return tx.one<ProjectRow>(
        `UPDATE projects
            SET name = COALESCE($2::text, name),
                archived_at = CASE WHEN $3::boolean IS NULL THEN archived_at
                                   WHEN $3::boolean THEN COALESCE(archived_at, $4) ELSE NULL END
          WHERE id = $1 RETURNING ${PROJECT_COLUMNS}`,
        [pid, input.name ?? null, input.archived ?? null, now()],
      )
    })
    return toProject(row)
  })
}
