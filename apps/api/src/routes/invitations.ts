// Invitation links (docs/M1-CONTRACTS.md §5). The token is shown once, in the returned URL; only its
// sha256 is stored. A link is single-use: the first account that accepts it owns it (accepting again
// is a no-op for that account; anyone else gets 410), and it expires after 7 days.

import {
  CreateBoardInvitationInput,
  CreateWorkspaceInvitationInput,
  type InvitationGoneBody,
  type InvitationGuestAccess,
  InvitationId,
  type InvitationPreview,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import { type BoardRole, can, canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { connectionRole, loadBoardAccess, requireBoardAction, requireWorkspaceRole } from '../access.ts'
import { audit } from '../audit.ts'
import { isSecretToken, newSecretToken, sha256hex } from '../auth/session.ts'
import { userKind } from '../auth/users.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError, forbidden, gone, notFound, parse } from '../errors.ts'
import { assertGuestRoomOnLink } from '../features/guests/limits.ts'
import { keyedLimit } from '../rate-limit.ts'

const GONE_MESSAGE = gone().message

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface InvitationRow {
  id: string
  workspace_id: string
  board_id: string | null
  role: string
  created_by: string
  created_at: Date
  expires_at: Date
  redeemed_by: string | null
  revoked_at: Date | null
  multi_use: boolean
  /** 0009_guests: people can join through this (multi-use) link with just a name. */
  allow_guests: boolean
}
export const INVITATION_COLUMNS =
  'i.id, i.workspace_id, i.board_id, i.role, i.created_by, i.created_at, i.expires_at, i.redeemed_by, i.revoked_at, i.multi_use, i.allow_guests'

type InvitationState = 'usable' | 'redeemed_by_caller' | 'gone'

/** Name-only guests (wave 3) may only use guest links; everything else needs an account. */
export const guestAccountRequired = (message = 'Sign in with an account to accept this invitation.') =>
  new ApiError(403, 'GUEST_ACCOUNT_REQUIRED', message)

export function stateFor(inv: InvitationRow, callerId: string | null, now: Date): InvitationState {
  if (inv.redeemed_by !== null) return inv.redeemed_by === callerId ? 'redeemed_by_caller' : 'gone'
  if (inv.revoked_at !== null || inv.expires_at.getTime() <= now.getTime()) return 'gone'
  return 'usable'
}

// Ranks for "never downgrade on accept": accepting a guest link must not demote an existing member.
// `column` is always a column reference written in this file, never input.
const wsRank = (column: string) =>
  `array_position(ARRAY['guest', 'member', 'admin', 'owner']::text[], ${column})`
const boardRank = (column: string) =>
  `array_position(ARRAY['viewer', 'commenter', 'editor', 'owner']::text[], ${column})`

/**
 * Creates a single-use invitation (the one code path for M1 links and the dashboard's email
 * invitations). `via` only annotates the audit event.
 */
export async function createInvitation(
  tx: Queryable,
  ctx: AppContext,
  input: { workspaceId: string; boardId: string | null; role: string; userId: string; via?: 'email' },
) {
  // Wave 3: a name-only guest never hands out access (whatever board role they were given).
  if ((await userKind(tx, input.userId)) === 'guest')
    throw guestAccountRequired('Sign in with an account to invite people.')
  const token = newSecretToken()
  const id = newId('inv')
  const createdAt = ctx.now()
  const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS)
  await tx.query(
    `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, sha256hex(token), input.workspaceId, input.boardId, input.role, input.userId, createdAt, expiresAt],
  )
  await audit(tx, {
    workspaceId: input.workspaceId,
    actorId: input.userId,
    action: 'invitation.create',
    target: id,
    detail: { boardId: input.boardId, role: input.role, ...(input.via ? { via: input.via } : {}) },
    at: createdAt,
  })
  return { id, url: `${ctx.config.publicOrigin}/invite/${token}`, expiresAt: expiresAt.toISOString() }
}

/**
 * 410 for a link that expired, was revoked or was used by someone else (PRI-04). It names who sent it
 * (the token holder saw that while it was valid) so the page can say whom to ask, and gives the board
 * id only to a signed-in caller who can open that board right now: they are sent to the board instead
 * of a dead end, and nobody else learns anything about it.
 */
export async function sendGone(
  q: Queryable,
  reply: FastifyReply,
  inv: Pick<InvitationRow, 'board_id' | 'created_by'>,
  callerId: string | null,
) {
  const inviter = await q.maybeOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [inv.created_by])
  let boardId: string | null = null
  if (callerId && inv.board_id && connectionRole(await loadBoardAccess(q, inv.board_id, callerId)))
    boardId = inv.board_id
  const body: InvitationGoneBody = {
    error: { code: 'GONE', message: GONE_MESSAGE },
    gone: { invitedBy: inviter ? { name: inviter.name } : null, boardId },
  }
  return reply.code(410).send(body)
}

/**
 * Redeems a usable invitation (stateFor === 'usable') for `userId`: the one redemption path of
 * accepting and of joining as a guest (wave 3). Call inside the transaction that locked the
 * invitation row FOR UPDATE. It adds the workspace membership (a board link makes an outsider a
 * workspace guest), raises the board grant to the link's role (never lowers it), records the use (for
 * a multi-use link the 0005 trigger counts it and closes the link at max_uses) and audits it.
 */
export async function redeemInvitation(
  tx: Queryable,
  inv: InvitationRow,
  userId: string,
  at: Date,
  opts: { via?: 'guest' } = {},
): Promise<void> {
  // What a multi-use link replaces (0006): its sweep puts a raised grant back, and removes one
  // it created (again: someone removed earlier who rejoins must not keep access past its end).
  const prior =
    inv.board_id !== null && inv.multi_use
      ? ((
          await tx.maybeOne<{ role: BoardRole }>(
            'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2 FOR UPDATE',
            [inv.board_id, userId],
          )
        )?.role ?? null)
      : null

  if (inv.board_id === null) {
    await tx.query(
      `INSERT INTO workspace_members AS m (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = CASE
         WHEN ${wsRank('EXCLUDED.role')} > ${wsRank('m.role')} THEN EXCLUDED.role
         ELSE m.role END`,
      [inv.workspace_id, userId, inv.role as WorkspaceRole, at],
    )
  } else {
    // A board link makes an outsider a workspace guest: guests see only boards granted to them.
    await tx.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [inv.workspace_id, userId, at],
    )
    await tx.query(
      `INSERT INTO board_members AS bm (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (board_id, user_id) DO UPDATE SET role = CASE
         WHEN ${boardRank('EXCLUDED.role')} > ${boardRank('bm.role')} THEN EXCLUDED.role
         ELSE bm.role END`,
      [inv.board_id, userId, inv.role as BoardRole, inv.created_by, at],
    )
  }
  await tx.query('UPDATE invitations SET redeemed_by = $2, redeemed_at = $3 WHERE id = $1', [
    inv.id,
    userId,
    at,
  ])
  if (inv.board_id !== null && inv.multi_use) {
    const rank = ['viewer', 'commenter', 'editor', 'owner']
    if (prior === null) {
      // Created now: stamp the redemption with the grant's creation time (the sweep's test).
      await tx.query(
        `UPDATE invitation_redemptions SET redeemed_at = $3, previous_role = NULL
          WHERE invitation_id = $1 AND user_id = $2`,
        [inv.id, userId, at],
      )
    } else if (rank.indexOf(prior) < rank.indexOf(inv.role)) {
      await tx.query(
        'UPDATE invitation_redemptions SET previous_role = $3 WHERE invitation_id = $1 AND user_id = $2',
        [inv.id, userId, prior],
      )
    }
  }
  await audit(tx, {
    workspaceId: inv.workspace_id,
    actorId: userId,
    action: 'invitation.accept',
    target: inv.id,
    detail: { boardId: inv.board_id, role: inv.role, ...(opts.via ? { via: opts.via } : {}) },
    at,
  })
}

export function registerInvitationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, notifier, now, sessions } = ctx
  // SCA-2 (docs/SECURITY-REVIEW-2026-09-27.md): the tokens are 256-bit, so guessing is not the threat;
  // one shared per-IP bucket was (a whole office behind one NAT locked out of its workshop link).
  // Previews are limited per link, with a generous per-IP backstop against floods of made-up tokens;
  // accepting is limited per signed-in user.
  const { previewPerToken, previewPerIp, acceptPerUser } = ctx.limits.invitations
  const perToken = keyedLimit(previewPerToken, now)
  const perUser = keyedLimit(acceptPerUser, now)

  app.post('/api/workspaces/:wid/invitations', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const { role } = parse(CreateWorkspaceInvitationInput, req.body)
    const created = await db.transaction(async (tx) => {
      const workspaceRole = await requireWorkspaceRole(tx, wid, user.id)
      if (!canManageWorkspace(workspaceRole)) throw forbidden()
      return createInvitation(tx, ctx, { workspaceId: wid, boardId: null, role, userId: user.id })
    })
    reply.code(201)
    return created
  })

  app.post('/api/boards/:bid/invitations', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const { role } = parse(CreateBoardInvitationInput, req.body)
    const created = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access')
      return createInvitation(tx, ctx, {
        workspaceId: access.board.workspace_id,
        boardId: bid,
        role,
        userId: user.id,
      })
    })
    reply.code(201)
    return created
  })

  // Public: the invitee may not have an account yet.
  const previewRoute = { config: { rateLimit: previewPerIp } }
  app.get(
    '/api/invitations/:token',
    previewRoute,
    async (req, reply): Promise<(InvitationPreview & InvitationGuestAccess) | undefined> => {
      const { token } = req.params as Params
      if (!isSecretToken(token)) throw notFound()
      const tokenHash = sha256hex(token)
      perToken.take(tokenHash)
      const row = await db.maybeOne<
        InvitationRow & { workspace_name: string; board_title: string | null; inviter_name: string }
      >(
        `SELECT ${INVITATION_COLUMNS}, w.name AS workspace_name, b.title AS board_title, u.name AS inviter_name
         FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id
         LEFT JOIN boards b ON b.id = i.board_id
         JOIN users u ON u.id = i.created_by
        WHERE i.token_hash = $1`,
        [tokenHash],
      )
      if (!row) throw notFound()
      const caller = await sessions.user(req)
      if (stateFor(row, caller?.id ?? null, now()) === 'gone') {
        await sendGone(db, reply, row, caller?.id ?? null)
        return
      }
      return {
        workspace: { id: row.workspace_id, name: row.workspace_name },
        board: row.board_id && row.board_title !== null ? { id: row.board_id, title: row.board_title } : null,
        role: row.role,
        invitedBy: { name: row.inviter_name },
        expiresAt: row.expires_at.toISOString(),
        // Wave 3: the invite page offers "Join as a guest" (name only) for such links.
        allowGuests: row.multi_use && row.allow_guests,
      }
    },
  )

  app.post('/api/invitations/:token/accept', async (req, reply) => {
    const user = await ctx.requireUser(req)
    perUser.take(user.id)
    const { token } = req.params as Params
    if (!isSecretToken(token)) throw notFound()
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE: two accounts accepting the same link at once cannot both redeem it.
      const inv = await tx.maybeOne<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM invitations i WHERE i.token_hash = $1 FOR UPDATE`,
        [sha256hex(token)],
      )
      if (!inv) throw notFound()
      // A name-only guest (wave 3) can only use guest links (joining one more board); a normal
      // invitation needs an account.
      const guest = (await userKind(tx, user.id)) === 'guest'
      if (guest) {
        if (!(inv.multi_use && inv.allow_guests)) throw guestAccountRequired()
        // The guest sweep takes this lock before it ends a guest's sessions (features/guests).
        await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id])
      }
      const at = now()
      const state = stateFor(inv, user.id, at)
      if (state === 'gone') return { gone: true as const, inv }
      const accepted = { workspaceId: inv.workspace_id, boardId: inv.board_id }
      if (state === 'redeemed_by_caller') return { gone: false as const, accepted, changed: false }
      // The same per-link guest cap as joining through POST /api/invitations/:token/guest.
      if (guest) await assertGuestRoomOnLink(tx, inv.id, user.id)
      await redeemInvitation(tx, inv, user.id, at)
      return { gone: false as const, accepted, changed: true }
    })
    if (result.gone) return sendGone(db, reply, result.inv, user.id)
    // Workspace links change no board grant; live sessions pick up role increases on the next periodic check.
    if (result.changed && result.accepted.boardId)
      notifier.accessChanged({ boardId: result.accepted.boardId, userId: user.id })
    return result.accepted
  })

  app.delete('/api/invitations/:id', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { id = '' } = req.params as Params
    if (!InvitationId.safeParse(id).success) throw notFound()
    await db.transaction(async (tx) => {
      const inv = await tx.maybeOne<InvitationRow & { caller_ws_role: WorkspaceRole | null }>(
        `SELECT ${INVITATION_COLUMNS}, m.role AS caller_ws_role
           FROM invitations i
           LEFT JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = $2
          WHERE i.id = $1 FOR UPDATE OF i`,
        [id, user.id],
      )
      if (!inv) throw notFound()
      let allowed = inv.caller_ws_role !== null && inv.created_by === user.id
      if (!allowed && inv.board_id === null) allowed = canManageWorkspace(inv.caller_ws_role)
      if (!allowed && inv.board_id !== null) {
        const access = await loadBoardAccess(tx, inv.board_id, user.id)
        allowed = !!access && can(access.role, 'manage_access', access.board.status)
      }
      // Same answer as a nonexistent id: an invitation someone cannot manage stays invisible to them.
      if (!allowed) throw notFound()
      if (inv.revoked_at !== null) return
      const at = now()
      await tx.query('UPDATE invitations SET revoked_at = $2 WHERE id = $1', [id, at])
      await audit(tx, {
        workspaceId: inv.workspace_id,
        actorId: user.id,
        action: 'invitation.revoke',
        target: id,
        detail: { boardId: inv.board_id },
        at,
      })
    })
    return reply.code(204).send()
  })
}
