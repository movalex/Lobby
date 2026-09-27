// Invitation links (docs/M1-CONTRACTS.md §5). The token is shown once, in the returned URL; only its
// sha256 is stored. A link is single-use: the first account that accepts it owns it (accepting again
// is a no-op for that account; anyone else gets 410), and it expires after 7 days.

import {
  CreateBoardInvitationInput,
  CreateWorkspaceInvitationInput,
  type InvitationGoneBody,
  InvitationId,
  type InvitationPreview,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import { type BoardRole, can, canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { connectionRole, loadBoardAccess, requireBoardAction, requireWorkspaceRole } from '../access.ts'
import { audit } from '../audit.ts'
import { isSecretToken, newSecretToken, sha256hex } from '../auth/session.ts'
import type { AppContext, Params } from '../context.ts'
import { forbidden, gone, notFound, parse } from '../errors.ts'

const GONE_MESSAGE = gone().message

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface InvitationRow {
  id: string
  workspace_id: string
  board_id: string | null
  role: string
  created_by: string
  expires_at: Date
  redeemed_by: string | null
  revoked_at: Date | null
  multi_use: boolean
}
const INVITATION_COLUMNS =
  'i.id, i.workspace_id, i.board_id, i.role, i.created_by, i.expires_at, i.redeemed_by, i.revoked_at, i.multi_use'

type InvitationState = 'usable' | 'redeemed_by_caller' | 'gone'

function stateFor(inv: InvitationRow, callerId: string | null, now: Date): InvitationState {
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

async function createInvitation(
  tx: Queryable,
  ctx: AppContext,
  input: { workspaceId: string; boardId: string | null; role: string; userId: string },
) {
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
    detail: { boardId: input.boardId, role: input.role },
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
async function sendGone(
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

export function registerInvitationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, notifier, now, sessions } = ctx
  const limited = { config: { rateLimit: ctx.authRateLimit } }

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

  // Public: the invitee may not have an account yet. Rate limited because the path holds a secret.
  app.get('/api/invitations/:token', limited, async (req, reply): Promise<InvitationPreview | undefined> => {
    const { token } = req.params as Params
    if (!isSecretToken(token)) throw notFound()
    const row = await db.maybeOne<
      InvitationRow & { workspace_name: string; board_title: string | null; inviter_name: string }
    >(
      `SELECT ${INVITATION_COLUMNS}, w.name AS workspace_name, b.title AS board_title, u.name AS inviter_name
         FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id
         LEFT JOIN boards b ON b.id = i.board_id
         JOIN users u ON u.id = i.created_by
        WHERE i.token_hash = $1`,
      [sha256hex(token)],
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
    }
  })

  app.post('/api/invitations/:token/accept', limited, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { token } = req.params as Params
    if (!isSecretToken(token)) throw notFound()
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE: two accounts accepting the same link at once cannot both redeem it.
      const inv = await tx.maybeOne<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM invitations i WHERE i.token_hash = $1 FOR UPDATE`,
        [sha256hex(token)],
      )
      if (!inv) throw notFound()
      const at = now()
      const state = stateFor(inv, user.id, at)
      if (state === 'gone') return { gone: true as const, inv }
      const accepted = { workspaceId: inv.workspace_id, boardId: inv.board_id }
      if (state === 'redeemed_by_caller') return { gone: false as const, accepted, changed: false }
      // What a multi-use link replaces (0006): its sweep puts a raised grant back, and removes one
      // it created (again: someone removed earlier who rejoins must not keep access past its end).
      const prior =
        inv.board_id !== null && inv.multi_use
          ? ((
              await tx.maybeOne<{ role: BoardRole }>(
                'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2 FOR UPDATE',
                [inv.board_id, user.id],
              )
            )?.role ?? null)
          : null

      if (inv.board_id === null) {
        await tx.query(
          `INSERT INTO workspace_members AS m (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = CASE
             WHEN ${wsRank('EXCLUDED.role')} > ${wsRank('m.role')} THEN EXCLUDED.role
             ELSE m.role END`,
          [inv.workspace_id, user.id, inv.role as WorkspaceRole, at],
        )
      } else {
        // A board link makes an outsider a workspace guest: guests see only boards granted to them.
        await tx.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', $3)
           ON CONFLICT (workspace_id, user_id) DO NOTHING`,
          [inv.workspace_id, user.id, at],
        )
        await tx.query(
          `INSERT INTO board_members AS bm (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (board_id, user_id) DO UPDATE SET role = CASE
             WHEN ${boardRank('EXCLUDED.role')} > ${boardRank('bm.role')} THEN EXCLUDED.role
             ELSE bm.role END`,
          [inv.board_id, user.id, inv.role as BoardRole, inv.created_by, at],
        )
      }
      await tx.query('UPDATE invitations SET redeemed_by = $2, redeemed_at = $3 WHERE id = $1', [
        inv.id,
        user.id,
        at,
      ])
      if (inv.board_id !== null && inv.multi_use) {
        const rank = ['viewer', 'commenter', 'editor', 'owner']
        if (prior === null) {
          // Created now: stamp the redemption with the grant's creation time (the sweep's test).
          await tx.query(
            `UPDATE invitation_redemptions SET redeemed_at = $3, previous_role = NULL
              WHERE invitation_id = $1 AND user_id = $2`,
            [inv.id, user.id, at],
          )
        } else if (rank.indexOf(prior) < rank.indexOf(inv.role)) {
          await tx.query(
            'UPDATE invitation_redemptions SET previous_role = $3 WHERE invitation_id = $1 AND user_id = $2',
            [inv.id, user.id, prior],
          )
        }
      }
      await audit(tx, {
        workspaceId: inv.workspace_id,
        actorId: user.id,
        action: 'invitation.accept',
        target: inv.id,
        detail: { boardId: inv.board_id, role: inv.role },
        at,
      })
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
