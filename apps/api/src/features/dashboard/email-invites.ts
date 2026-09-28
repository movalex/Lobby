// Invite by email: POST /api/boards/:bid/invitations/email {email, role} (manage_access).
//
// With Clerk sign-in:
//  1. the address is a VERIFIED address of a Clerk account that already has a Draftroom identity
//     (identities 'clerk' + Clerk user id): that person gets the board role now, by the rules of
//     PUT /api/boards/:bid/members/:uid (audit event, access-changed push to sync), plus the guest
//     membership an accepted board invitation would give an outsider. An invite never lowers a role
//     someone already has;
//  2. a Clerk account that has not opened Draftroom yet: the inviter gets a link to send (Clerk emails
//     invitations only to addresses without an account);
//  3. anyone else: a normal single-use board invitation (routes/invitations.ts, 7 days, never
//     ownership), and Clerk emails it with the invitation link as its redirect URL. The link keeps
//     every rule of an invitation link: one use, expiry, accepted with the accepting person's own
//     session, guest membership. If Clerk refuses or fails, the inviter gets the link instead.
// With the development sign-in provider nothing is emailed: the inviter gets the link.
//
// The address itself is never logged: log lines carry its domain and a keyed hash.

import { createHmac } from 'node:crypto'
import {
  EmailInviteInput,
  type EmailInviteResult,
  type RequestableRole,
  type User,
} from '@draftroom/contracts'
import { type BoardRole, resolveBoardRole, roleAtLeast } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { loadBoardAccess, requireBoardAction } from '../../access.ts'
import { audit } from '../../audit.ts'
import type { Params } from '../../context.ts'
import { ApiError, notFound, parse } from '../../errors.ts'
import { createInvitation, INVITATION_TTL_MS } from '../../routes/invitations.ts'
import { toUser, type UserRow } from '../../serialize.ts'
import type { FeatureContext } from '../context.ts'
import { classifyClerkError, createClerkDirectory } from './clerk-directory.ts'
import { DAY_MS, publishSharingChanged, UserRateLimiter } from './shared.ts'

/** Per inviter, across all boards: 20 email invitations an hour (email costs, and address probing). */
export const EMAIL_INVITE_USER_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 }

type LinkReason = Extract<EmailInviteResult, { mode: 'link' }>['reason']

export function registerEmailInviteRoutes(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, now, notifier, config } = ctx
  const limiter = new UserRateLimiter({ ...EMAIL_INVITE_USER_LIMIT, now: () => now().getTime() })
  // Email goes out only through Clerk; the development provider has no addresses to send to.
  const directory =
    config.authProvider === 'clerk' && config.clerk ? createClerkDirectory(config.clerk) : null
  const expiresInDays = Math.round(INVITATION_TTL_MS / DAY_MS)

  // A keyed hash lets one address's log lines be correlated without the logs holding (or a guessed
  // list of addresses revealing) the address.
  const logKey = createHmac('sha256', config.ticketSecret).update('draftroom:email-invite-log:v1').digest()
  const logFields = (boardId: string, email: string) => ({
    boardId,
    emailDomain: email.slice(email.lastIndexOf('@') + 1),
    emailRef: createHmac('sha256', logKey).update(email).digest('hex').slice(0, 12),
  })

  /** A single-use board invitation (access re-checked: Clerk calls may have taken a while). */
  const newInvitation = (boardId: string, actorId: string, role: RequestableRole) =>
    db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, boardId, actorId, 'manage_access')
      return createInvitation(tx, ctx, {
        workspaceId: access.board.workspace_id,
        boardId,
        role,
        userId: actorId,
        via: 'email',
      })
    })

  /** Gives someone who already uses Draftroom the role now (never lowering what they have). */
  const grant = (boardId: string, actorId: string, userId: string, role: RequestableRole) =>
    db.transaction(async (tx) => {
      // The board row lock orders this with every other access change (members.ts, access requests).
      const access = await requireBoardAction(tx, boardId, actorId, 'manage_access', { forUpdate: true })
      const target = await loadBoardAccess(tx, boardId, userId)
      const row = await tx.maybeOne<UserRow>(
        'SELECT id, name, handle, color, avatar_url FROM users WHERE id = $1',
        [userId],
      )
      if (!target || !row) throw notFound()
      let after: BoardRole | null = target.role
      let changed = false
      if (!roleAtLeast(target.role, role)) {
        const at = now()
        // An outsider becomes a workspace guest (guests see only boards granted to them), exactly
        // as accepting a board invitation makes them.
        await tx.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', $3)
           ON CONFLICT (workspace_id, user_id) DO NOTHING`,
          [access.board.workspace_id, userId, at],
        )
        // Their current role is below `role`, so any grant they have is too: set it.
        await tx.query(
          `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role, added_by = EXCLUDED.added_by`,
          [boardId, userId, role, actorId, at],
        )
        await audit(tx, {
          workspaceId: access.board.workspace_id,
          actorId,
          action: 'board.member.put',
          target: boardId,
          detail: { userId, role, previousRole: target.grant, via: 'email_invite' },
          at,
        })
        after = resolveBoardRole({
          workspaceRole: target.workspaceRole ?? 'guest',
          boardGrant: role,
          visibility: access.board.visibility,
        })
        changed = true
      }
      const user: User = toUser(row)
      return { user, role: after ?? role, changed }
    })

  app.post(
    '/api/boards/:bid/invitations/email',
    async (req: FastifyRequest, reply: FastifyReply): Promise<EmailInviteResult> => {
      const me = await ctx.requireUser(req)
      const { bid = '' } = req.params as Params
      const { email, role } = parse(EmailInviteInput, req.body)
      // The board's own answer first (404 without access, 403 without manage_access), then the limit.
      await requireBoardAction(db, bid, me.id, 'manage_access')
      if (!limiter.hit(me.id))
        throw new ApiError(429, 'RATE_LIMITED', 'Too many email invitations. Wait a while and try again.')
      const log = logFields(bid, email)

      const asLink = async (reason: LinkReason): Promise<EmailInviteResult> => {
        const inv = await newInvitation(bid, me.id, role)
        req.log.info({ ...log, mode: 'link', reason }, 'board email invitation')
        publishSharingChanged(ctx, bid, 'invitation')
        reply.code(201)
        return { mode: 'link', reason, email, invitationId: inv.id, url: inv.url, expiresAt: inv.expiresAt }
      }

      if (!directory) return asLink('email_not_configured')

      let clerkIds: string[]
      try {
        clerkIds = await directory.verifiedUserIds(email)
      } catch (e) {
        const f = classifyClerkError(e)
        req.log.warn(
          { ...log, step: 'lookup', reason: f.reason, status: f.status, codes: f.codes, traceId: f.traceId },
          'clerk user lookup failed',
        )
        // Without the lookup nobody can tell whether this is a new person: send no email.
        return asLink(f.reason === 'existing_account' ? 'provider_error' : f.reason)
      }

      if (clerkIds.length > 0) {
        const linked = await db.maybeOne<{ user_id: string }>(
          `SELECT user_id FROM identities WHERE provider = 'clerk' AND subject = ANY($1::text[])
            ORDER BY created_at, user_id LIMIT 1`,
          [clerkIds],
        )
        if (!linked) return asLink('existing_account')
        const g = await grant(bid, me.id, linked.user_id, role)
        req.log.info({ ...log, mode: 'granted', changed: g.changed }, 'board email invitation')
        if (g.changed) {
          notifier.accessChanged({ boardId: bid, userId: g.user.id })
          publishSharingChanged(ctx, bid, 'grant')
        }
        return { mode: 'granted', user: g.user, role: g.role, alreadyHadAccess: !g.changed }
      }

      const inv = await newInvitation(bid, me.id, role)
      publishSharingChanged(ctx, bid, 'invitation')
      reply.code(201)
      try {
        await directory.sendInvitation({ email, redirectUrl: inv.url, expiresInDays })
      } catch (e) {
        const f = classifyClerkError(e)
        req.log.warn(
          { ...log, step: 'invite', reason: f.reason, status: f.status, codes: f.codes, traceId: f.traceId },
          'clerk invitation not sent',
        )
        return {
          mode: 'link',
          reason: f.reason,
          email,
          invitationId: inv.id,
          url: inv.url,
          expiresAt: inv.expiresAt,
        }
      }
      req.log.info({ ...log, mode: 'emailed' }, 'board email invitation')
      return { mode: 'emailed', email, invitationId: inv.id, expiresAt: inv.expiresAt }
    },
  )
}
