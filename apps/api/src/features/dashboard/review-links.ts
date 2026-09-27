// Review links (multi-use board invitations) and the board's pending-invitation list.
//
// A review link is an `invitations` row with multi_use = true (0005_dashboard): viewer or commenter
// only, expiry at most 30 days, optional max uses. People accept it through M1's
// POST /api/invitations/:token/accept; the 0005 trigger records each use instead of consuming the link.
//
// The token is derived from the invitation id with a server-side key (HMAC), so managers can copy the
// link again later while the database still stores only its sha256. Access that a review link created
// ends when the link expires (sweeper below), or at once when a manager revokes it with removal.

import { createHmac } from 'node:crypto'
import {
  CreateReviewLinkInput,
  InvitationId,
  type PendingInvitation,
  REVIEW_LINK_MAX_DAYS,
  RevokeReviewLinkInput,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import { audit } from '../../audit.ts'
import { sha256hex } from '../../auth/session.ts'
import type { Params } from '../../context.ts'
import { conflict, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { DAY_MS, publishSharingChanged } from './shared.ts'

/** Open review links per board (a runaway client cannot fill the table). */
export const MAX_ACTIVE_REVIEW_LINKS = 20
const SWEEP_INTERVAL_MS = 60_000
const SWEEP_BATCH = 50

/** Review-link token for an invitation id: HMAC under a key derived from the ticket secret. */
export function reviewLinkToken(secret: string, invitationId: string): string {
  const key = createHmac('sha256', secret).update('draftroom:review-link-token:v1').digest()
  return createHmac('sha256', key).update(invitationId).digest('base64url')
}

interface LinkRow {
  id: string
  workspace_id: string
  board_id: string
  role: 'viewer' | 'commenter'
  created_by: string
  expires_at: Date
  revoked_at: Date | null
  swept_at: Date | null
}

/**
 * Removes the direct grants that review links created for the people who joined through `link`,
 * unless they changed since (another role) or the person still holds another open review link for
 * this board. Returns the affected user ids. Call inside the transaction that marks the link swept.
 */
export async function removeReviewLinkGrants(tx: Queryable, link: LinkRow, at: Date): Promise<string[]> {
  const res = await tx.query<{ user_id: string }>(
    `DELETE FROM board_members bm
      USING invitation_redemptions r
      WHERE r.invitation_id = $1 AND bm.board_id = r.board_id AND bm.user_id = r.user_id
        AND bm.board_id = $2
        AND bm.role IN ('viewer', 'commenter')
        -- the grant was created by a review link of this board and still has that link's role
        AND EXISTS (
          SELECT 1 FROM invitation_redemptions r3 JOIN invitations i3 ON i3.id = r3.invitation_id
           WHERE r3.board_id = bm.board_id AND r3.user_id = bm.user_id AND i3.multi_use
             AND r3.redeemed_at = bm.created_at AND i3.role = bm.role)
        -- and no other open review link of this board keeps it
        AND NOT EXISTS (
          SELECT 1 FROM invitation_redemptions r2 JOIN invitations i2 ON i2.id = r2.invitation_id
           WHERE r2.board_id = bm.board_id AND r2.user_id = bm.user_id AND i2.id <> $1 AND i2.multi_use
             AND i2.swept_at IS NULL AND i2.revoked_at IS NULL AND i2.expires_at > $3)
      RETURNING bm.user_id`,
    [link.id, link.board_id, at],
  )
  return res.rows.map((r) => r.user_id)
}

/** Ends the access of people who joined through review links that have expired. Returns how many. */
export async function sweepExpiredReviewLinks(ctx: FeatureContext): Promise<number> {
  const at = ctx.now()
  const due = await ctx.db.query<{ id: string }>(
    `SELECT id FROM invitations WHERE multi_use AND swept_at IS NULL AND expires_at <= $1
      ORDER BY expires_at LIMIT ${SWEEP_BATCH}`,
    [at],
  )
  let removed = 0
  for (const { id } of due.rows) {
    const out = await ctx.db.transaction(async (tx) => {
      const link = await tx.maybeOne<LinkRow>(
        `SELECT id, workspace_id, board_id, role, created_by, expires_at, revoked_at, swept_at
           FROM invitations WHERE id = $1 AND multi_use FOR UPDATE`,
        [id],
      )
      if (!link || link.swept_at) return null
      // Board row lock: the same order as grant changes (members routes lock the board first).
      await tx.query('SELECT id FROM boards WHERE id = $1 FOR UPDATE', [link.board_id])
      const users = await removeReviewLinkGrants(tx, link, at)
      await tx.query('UPDATE invitations SET swept_at = $2 WHERE id = $1', [id, at])
      if (users.length)
        await audit(tx, {
          workspaceId: link.workspace_id,
          actorId: link.created_by,
          action: 'board.member.remove',
          target: link.board_id,
          detail: { via: 'review_link_expired', invitationId: id, userIds: users },
          at,
        })
      return { boardId: link.board_id, users }
    })
    if (!out) continue
    removed += out.users.length
    for (const userId of out.users) ctx.notifier.accessChanged({ boardId: out.boardId, userId })
    publishSharingChanged(ctx, out.boardId, 'review-link-expired')
  }
  return removed
}

interface InvitationListRow {
  id: string
  role: 'editor' | 'commenter' | 'viewer'
  multi_use: boolean
  max_uses: number | null
  use_count: number
  created_at: Date
  expires_at: Date
  token_hash: string
  creator_id: string
  creator_name: string
}

export function registerReviewLinkRoutes(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, now, notifier, config } = ctx
  const linkUrl = (token: string) => `${config.publicOrigin}/invite/${token}`

  // Pending links of the board: M1 single-use links nobody redeemed yet, and open review links.
  app.get('/api/boards/:bid/invitations', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'manage_access')
    const rows = await db.query<InvitationListRow>(
      `SELECT i.id, i.role, i.multi_use, i.max_uses, i.use_count, i.created_at, i.expires_at, i.token_hash,
              u.id AS creator_id, u.name AS creator_name
         FROM invitations i JOIN users u ON u.id = i.created_by
        WHERE i.board_id = $1 AND i.workspace_id = $2 AND i.revoked_at IS NULL AND i.redeemed_by IS NULL
          AND i.expires_at > $3
        ORDER BY i.multi_use DESC, i.created_at DESC, i.id
        LIMIT 200`,
      [bid, access.board.workspace_id, now()],
    )
    const invitations: PendingInvitation[] = rows.rows.map((r) => {
      let url: string | null = null
      if (r.multi_use) {
        const token = reviewLinkToken(config.ticketSecret, r.id)
        // A rotated secret cannot rebuild the link: say so (null) instead of showing a dead URL.
        if (sha256hex(token) === r.token_hash) url = linkUrl(token)
      }
      return {
        id: r.id,
        kind: r.multi_use ? 'review' : 'invite',
        role: r.role,
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        createdBy: { id: r.creator_id, name: r.creator_name },
        uses: r.use_count,
        maxUses: r.max_uses,
        url,
      }
    })
    return { invitations }
  })

  app.post('/api/boards/:bid/review-links', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateReviewLinkInput, req.body ?? {})
    const created = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      const at = now()
      const open = await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM invitations
          WHERE board_id = $1 AND multi_use AND revoked_at IS NULL AND expires_at > $2`,
        [bid, at],
      )
      if (open.n >= MAX_ACTIVE_REVIEW_LINKS)
        throw conflict(
          'TOO_MANY_LINKS',
          `A board can have at most ${MAX_ACTIVE_REVIEW_LINKS} open review links. Revoke one first.`,
        )
      const id = newId('inv')
      const token = reviewLinkToken(config.ticketSecret, id)
      const days = Math.min(input.expiresInDays, REVIEW_LINK_MAX_DAYS)
      const expiresAt = new Date(at.getTime() + days * DAY_MS)
      await tx.query(
        `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at,
                                  expires_at, multi_use, max_uses)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
        [
          id,
          sha256hex(token),
          access.board.workspace_id,
          bid,
          input.role,
          user.id,
          at,
          expiresAt,
          input.maxUses,
        ],
      )
      await audit(tx, {
        workspaceId: access.board.workspace_id,
        actorId: user.id,
        action: 'invitation.create',
        target: id,
        detail: { boardId: bid, role: input.role, multiUse: true, maxUses: input.maxUses },
        at,
      })
      return {
        id,
        url: linkUrl(token),
        role: input.role,
        expiresAt: expiresAt.toISOString(),
        maxUses: input.maxUses,
      }
    })
    publishSharingChanged(ctx, bid, 'review-link-created')
    reply.code(201)
    return created
  })

  app.post('/api/boards/:bid/review-links/:id/revoke', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', id = '' } = req.params as Params
    const { removeAccess } = parse(RevokeReviewLinkInput, req.body ?? {})
    const result = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if (!InvitationId.safeParse(id).success) throw notFound()
      const link = await tx.maybeOne<LinkRow>(
        `SELECT id, workspace_id, board_id, role, created_by, expires_at, revoked_at, swept_at
           FROM invitations WHERE id = $1 AND board_id = $2 AND multi_use FOR UPDATE`,
        [id, access.board.id],
      )
      if (!link) throw notFound()
      const at = now()
      if (link.revoked_at === null) {
        await tx.query('UPDATE invitations SET revoked_at = $2 WHERE id = $1', [id, at])
        await audit(tx, {
          workspaceId: link.workspace_id,
          actorId: user.id,
          action: 'invitation.revoke',
          target: id,
          detail: { boardId: bid, multiUse: true },
          at,
        })
      }
      let users: string[] = []
      if (removeAccess && link.swept_at === null) {
        users = await removeReviewLinkGrants(tx, link, at)
        await tx.query('UPDATE invitations SET swept_at = $2 WHERE id = $1', [id, at])
        if (users.length)
          await audit(tx, {
            workspaceId: link.workspace_id,
            actorId: user.id,
            action: 'board.member.remove',
            target: bid,
            detail: { via: 'review_link_revoked', invitationId: id, userIds: users },
            at,
          })
      }
      return { users }
    })
    for (const userId of result.users) notifier.accessChanged({ boardId: bid, userId })
    publishSharingChanged(ctx, bid, 'review-link-revoked')
    return { removed: result.users.length }
  })

  // Expiry sweeper: one API instance (docs/DEPLOY.md); with several, the row locks keep sweeps single.
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running) return
      running = sweepExpiredReviewLinks(ctx)
        .then(() => {})
        .catch((e) => app.log.warn({ err: { message: (e as Error)?.message } }, 'review link sweep failed'))
        .finally(() => {
          running = null
        })
    }, SWEEP_INTERVAL_MS)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer)
    timer = null
    await running // the database closes after this hook
  })
}
