// Invitation links (docs/M1-CONTRACTS.md §5). The token is shown once, in the returned URL; only its
// sha256 is stored. A link is single-use: the first account that accepts it owns it (accepting again
// is a no-op for that account; anyone else gets 410), and it expires after 7 days.
//
// Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §6.1): every single-use invitation is locked to one
// address (invitations.invited_email). Only an account with that VERIFIED address (primary or
// secondary, confirmed at most 5 minutes before accepting) can accept it; anyone else gets 403
// INVITATION_EMAIL_MISMATCH with a masked hint, nothing is redeemed and the link stays usable for the
// invitee. Only creators create invitations, and nobody invites an outside address as a workspace
// admin. An unbound single-use link (from before the lock, or made by an older build during a
// rollback) is gone. The full address appears only in the manager-only pending list; logs and audit
// rows carry its domain.

import {
  BOARD_IN_TRASH,
  CreateBoardInvitationInput,
  CreateWorkspaceInvitationInput,
  DOMAIN_ACCESS_CODES,
  DOMAIN_ACCESS_MESSAGES,
  type InvitationBoardState,
  type InvitationEmailLock,
  type InvitationEmailMismatchBody,
  type InvitationGoneBody,
  type InvitationGuestAccess,
  InvitationId,
  type InvitationPreview,
  invitationEmailMismatchMessage,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import { type BoardRole, can, canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  connectionRole,
  loadBoardAccess,
  lockBoardRow,
  requireBoardAction,
  requireWorkspaceRole,
} from '../access.ts'
import { audit } from '../audit.ts'
import { distinctDomains, emailDomain, isCreatorEmail, normalizeEmail } from '../auth/creators.ts'
import { roleRequiresCreator } from '../auth/identity.ts'
import { isSecretToken, newSecretToken, sha256hex } from '../auth/session.ts'
import { storedEmails, userKind } from '../auth/users.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError, badRequest, forbidden, gone, notFound, parse } from '../errors.ts'
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
  /** 0021_domain_access: the one address that may accept this single-use invitation (null: unbound, gone). */
  invited_email: string | null
}
export const INVITATION_COLUMNS =
  'i.id, i.workspace_id, i.board_id, i.role, i.created_by, i.created_at, i.expires_at, i.redeemed_by, i.revoked_at, i.multi_use, i.allow_guests, i.invited_email'

type InvitationState = 'usable' | 'redeemed_by_caller' | 'gone'

/** Name-only guests (wave 3) may only use guest links; everything else needs an account. */
export const guestAccountRequired = (message = 'Sign in with an account to accept this invitation.') =>
  new ApiError(403, 'GUEST_ACCOUNT_REQUIRED', message)

/**
 * 409 INVITATION_TO_SELF (fixer round 3, contracts doc §21): a locked invitation to an address of the
 * inviter's own account would let only the inviter in, and accepting it would use it up for nothing.
 */
export const invitationToSelf = () =>
  new ApiError(409, DOMAIN_ACCESS_CODES.invitationToSelf, DOMAIN_ACCESS_MESSAGES.invitationToSelf)

/**
 * 409 BOARD_IN_TRASH (fixer round 3, §21): accepting an invitation whose board is in the trash. Nothing
 * is redeemed; once the board is restored the link works again, until it expires.
 */
export const boardInTrash = () => new ApiError(409, BOARD_IN_TRASH.code, BOARD_IN_TRASH.message)

/**
 * The invitation behind `token`, locked FOR UPDATE for redeeming it (accepting, joining as a guest),
 * or null when there is none. A board invitation's board row is locked first (the lock order in
 * access.ts): a revoke or "+1 h" holds the board and then takes the link, so taking the link first and
 * then the board (which redeeming needs: its grant references the board) deadlocks with them. The
 * board is found through an unlocked read (an invitation's board never changes), and the row is read
 * again under the lock, so the caller always decides on its current state.
 */
export async function lockInvitation(tx: Queryable, token: string): Promise<InvitationRow | null> {
  const tokenHash = sha256hex(token)
  const found = await tx.maybeOne<{ id: string; board_id: string | null }>(
    'SELECT id, board_id FROM invitations WHERE token_hash = $1',
    [tokenHash],
  )
  if (!found) return null
  if (found.board_id !== null) await lockBoardRow(tx, found.board_id)
  return tx.maybeOne<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM invitations i WHERE i.id = $1 AND i.token_hash = $2 FOR UPDATE`,
    [found.id, tokenHash],
  )
}

export function stateFor(
  inv: Pick<InvitationRow, 'redeemed_by' | 'revoked_at' | 'expires_at' | 'multi_use' | 'invited_email'>,
  callerId: string | null,
  now: Date,
): InvitationState {
  if (inv.redeemed_by !== null) return inv.redeemed_by === callerId ? 'redeemed_by_caller' : 'gone'
  // Domain access (D3): a single-use link bound to nobody can no longer be used (migration 0021
  // revoked the open ones; an older build may create more during a rollback).
  if (!inv.multi_use && inv.invited_email === null) return 'gone'
  if (inv.revoked_at !== null || inv.expires_at.getTime() <= now.getTime()) return 'gone'
  return 'usable'
}

/**
 * The address a locked invitation shows before it is accepted: the first character of the local
 * part, then "•••@", then the domain (`jane.doe@client.example` → `j•••@client.example`). Api only.
 */
export function maskEmail(email: string): string {
  return `${email.slice(0, 1)}•••@${emailDomain(email)}`
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
  input: {
    workspaceId: string
    boardId: string | null
    role: string
    userId: string
    via?: 'email'
    /** The one address that may accept it (already through AccountEmail). */
    email: string
    /** The route pattern, for the creator-refusal log. */
    route: string
  },
) {
  // Wave 3: a name-only guest never hands out access (whatever board role they were given).
  if ((await userKind(tx, input.userId)) === 'guest')
    throw guestAccountRequired('Sign in with an account to invite people.')
  // Domain access (D4): only creators hand out access.
  await ctx.identity.requireCreator(tx, input.userId, 'share', { route: input.route, by: 'route' })
  const email = normalizeEmail(input.email)
  if (email === null) throw badRequest('email: Enter a valid email address.')
  // D5: nobody makes an outside address a workspace admin (or owner).
  const { policy, devDomain } = ctx.identity.lookup
  if (
    input.boardId === null &&
    (input.role === 'admin' || input.role === 'owner') &&
    !isCreatorEmail(email, policy, devDomain)
  )
    throw roleRequiresCreator()
  // Fixer round 3 (§21): never a link locked to one of the inviter's own addresses (any stored one of
  // the running provider, as accepting would count it).
  if ((await storedEmails(tx, input.userId, ctx.identity.lookup.source)).includes(email))
    throw invitationToSelf()
  const token = newSecretToken()
  const id = newId('inv')
  const createdAt = ctx.now()
  const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS)
  await tx.query(
    `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at, expires_at, invited_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      sha256hex(token),
      input.workspaceId,
      input.boardId,
      input.role,
      input.userId,
      createdAt,
      expiresAt,
      email,
    ],
  )
  await audit(tx, {
    workspaceId: input.workspaceId,
    actorId: input.userId,
    action: 'invitation.create',
    target: id,
    detail: {
      boardId: input.boardId,
      role: input.role,
      ...(input.via ? { via: input.via } : {}),
      emailLocked: true,
      emailDomain: emailDomain(email),
    },
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
 * 403 INVITATION_EMAIL_MISMATCH (accept): who sent it and the masked address, never the full one.
 * Nothing was redeemed; the link stays usable for the invitee.
 */
async function sendMismatch(
  q: Queryable,
  reply: FastifyReply,
  inv: Pick<InvitationRow, 'created_by' | 'invited_email'>,
) {
  const inviter = await q.maybeOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [inv.created_by])
  const hint = maskEmail(inv.invited_email ?? '')
  const body: InvitationEmailMismatchBody = {
    error: { code: 'INVITATION_EMAIL_MISMATCH', message: invitationEmailMismatchMessage(hint) },
    mismatch: { invitedEmailHint: hint, invitedBy: inviter ? { name: inviter.name } : null },
  }
  return reply.code(403).send(body)
}

/**
 * Redeems a usable invitation (stateFor === 'usable') for `userId`: the one redemption path of
 * accepting and of joining as a guest (wave 3). Call inside the transaction that locked the
 * invitation row FOR UPDATE, board row first (lockInvitation). It adds the workspace membership (a
 * board link makes an outsider a workspace guest), raises the board grant to the link's role (never
 * lowers it), records the use (for a multi-use link the 0005 trigger counts it and closes the link at
 * max_uses) and audits it.
 */
export async function redeemInvitation(
  tx: Queryable,
  inv: InvitationRow,
  userId: string,
  at: Date,
  opts: { via?: 'guest' } = {},
): Promise<void> {
  // Lock order (access.ts): the board and this link are locked; then the workspace_members row, THEN the
  // board_members row. A member removal (routes/workspaces.ts) deletes the membership and then sweeps the
  // grants, so a redeem that took the grant row first and the membership after (or never locked the
  // membership at all) deadlocked with it, or left a grant behind that outlived the membership. The
  // membership insert is a DO UPDATE with no change for that: it locks an existing row (a removal waits for
  // this redeem and then sweeps what it granted), and it waits for a removal that deleted the row first.
  let prior: BoardRole | null = null
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
      `INSERT INTO workspace_members AS m (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = m.role`,
      [inv.workspace_id, userId, at],
    )
    // What a multi-use link replaces (0006): its sweep puts a raised grant back, and removes one
    // it created (again: someone removed earlier who rejoins must not keep access past its end).
    // Read after the membership above, so the grant row is locked after it.
    if (inv.multi_use)
      prior =
        (
          await tx.maybeOne<{ role: BoardRole }>(
            'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2 FOR UPDATE',
            [inv.board_id, userId],
          )
        )?.role ?? null
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
      // J2 / MISS-1: a raise of a grant that a multi-use link of this board CREATED (the link sweep's own
      // test, review-links.ts `created_by_link`: a redemption stamped with the grant's creation time,
      // through a link with the grant's role) is no raise of someone's own access: the grant is still the
      // links'. Stamp this redemption as the grant's creator too (the grant's creation time, nothing to go
      // back to), so the link sweep ends it with the last of those links (removeReviewLinkGrants' keeper),
      // instead of finding a grant no link created and leaving it for good. (The grant row was raised
      // above; its created_at is still the one it was created with.)
      const linkMade = await tx.maybeOne<{ ok: boolean }>(
        `SELECT true AS ok FROM invitation_redemptions r
           JOIN invitations i ON i.id = r.invitation_id
           JOIN board_members bm ON bm.board_id = r.board_id AND bm.user_id = r.user_id
          WHERE r.board_id = $1 AND r.user_id = $2 AND r.invitation_id <> $3 AND i.multi_use
            AND r.redeemed_at = bm.created_at AND i.role = $4
          LIMIT 1`,
        [inv.board_id, userId, inv.id, prior],
      )
      if (linkMade)
        await tx.query(
          `UPDATE invitation_redemptions r SET redeemed_at = bm.created_at, previous_role = NULL
             FROM board_members bm
            WHERE r.invitation_id = $1 AND r.user_id = $2 AND bm.board_id = $3 AND bm.user_id = $2`,
          [inv.id, userId, inv.board_id],
        )
      else
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
    detail: {
      boardId: inv.board_id,
      role: inv.role,
      ...(opts.via ? { via: opts.via } : {}),
      ...(inv.invited_email !== null ? { emailLocked: true } : {}),
    },
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
    const { role, email } = parse(CreateWorkspaceInvitationInput, req.body)
    const created = await db.transaction(async (tx) => {
      const workspaceRole = await requireWorkspaceRole(tx, wid, user.id)
      if (!canManageWorkspace(workspaceRole)) throw forbidden()
      return createInvitation(tx, ctx, {
        workspaceId: wid,
        boardId: null,
        role,
        userId: user.id,
        email,
        route: req.routeOptions.url ?? '',
      })
    })
    reply.code(201)
    return created
  })

  app.post('/api/boards/:bid/invitations', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const { role, email } = parse(CreateBoardInvitationInput, req.body)
    const created = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access')
      return createInvitation(tx, ctx, {
        workspaceId: access.board.workspace_id,
        boardId: bid,
        role,
        userId: user.id,
        email,
        route: req.routeOptions.url ?? '',
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
    async (
      req,
      reply,
    ): Promise<
      (InvitationPreview & InvitationGuestAccess & InvitationEmailLock & InvitationBoardState) | undefined
    > => {
      const { token } = req.params as Params
      if (!isSecretToken(token)) throw notFound()
      const tokenHash = sha256hex(token)
      perToken.take(tokenHash)
      const row = await db.maybeOne<
        InvitationRow & {
          workspace_name: string
          board_title: string | null
          board_status: string | null
          inviter_name: string
        }
      >(
        `SELECT ${INVITATION_COLUMNS}, w.name AS workspace_name, b.title AS board_title, b.status AS board_status,
                u.name AS inviter_name
         FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id
         LEFT JOIN boards b ON b.id = i.board_id
         JOIN users u ON u.id = i.created_by
        WHERE i.token_hash = $1`,
        [tokenHash],
      )
      if (!row) throw notFound()
      const caller = await sessions.user(req)
      const state = stateFor(row, caller?.id ?? null, now())
      if (state === 'gone') {
        await sendGone(db, reply, row, caller?.id ?? null)
        return
      }
      // Domain access: whether the signed-in account has the invited address, from its STORED
      // addresses (no provider call here: accepting re-checks with fresh data).
      const locked = row.invited_email !== null
      let matchesYou: boolean | null = null
      if (locked && caller && caller.kind !== 'guest')
        matchesYou = (await storedEmails(db, caller.id, ctx.identity.lookup.source)).includes(
          row.invited_email ?? '',
        )
      return {
        workspace: { id: row.workspace_id, name: row.workspace_name },
        board: row.board_id && row.board_title !== null ? { id: row.board_id, title: row.board_title } : null,
        role: row.role,
        invitedBy: { name: row.inviter_name },
        expiresAt: row.expires_at.toISOString(),
        // Wave 3: the invite page offers "Join as a guest" (name only) for such links.
        allowGuests: row.multi_use && row.allow_guests,
        emailLocked: locked,
        invitedEmailHint: locked && state === 'usable' ? maskEmail(row.invited_email ?? '') : null,
        matchesYou,
        // The inviter opening their own locked link (to check it) is told whom it is for.
        sentByYou: locked && caller !== null && row.created_by === caller.id,
        // Fixer round 3 (§21): nothing can be accepted while the board is in the trash (the page says
        // so instead of offering to join); restoring it makes the link usable again.
        boardInTrash: row.board_status === 'trashed',
      }
    },
  )

  app.post('/api/invitations/:token/accept', async (req, reply) => {
    let user = await ctx.requireUser(req)
    perUser.take(user.id)
    const { token } = req.params as Params
    if (!isSecretToken(token)) throw notFound()
    // Domain access, BEFORE any transaction (no provider call ever happens while the board or
    // invitation lock is held): an unlocked read of the lock, then the caller's addresses at most
    // 5 minutes old (503 IDENTITY_UNAVAILABLE otherwise, with nothing redeemed).
    const lock = await db.maybeOne<{ invited_email: string | null }>(
      'SELECT invited_email FROM invitations WHERE token_hash = $1',
      [sha256hex(token)],
    )
    let callerEmails: ReadonlySet<string> = new Set()
    if (lock?.invited_email) {
      user = await ctx.identity.freshen(req, user, 'accept')
      callerEmails = new Set(await storedEmails(db, user.id, ctx.identity.lookup.source))
    }
    const caller = user
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE: two accounts accepting the same link at once cannot both redeem it.
      const inv = await lockInvitation(tx, token)
      if (!inv) throw notFound()
      // A name-only guest (wave 3) can only use guest links (joining one more board); a normal
      // invitation needs an account.
      const guest = (await userKind(tx, caller.id)) === 'guest'
      if (guest) {
        if (!(inv.multi_use && inv.allow_guests)) throw guestAccountRequired()
        // The guest sweep takes this lock before it ends a guest's sessions (features/guests).
        await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [caller.id])
      }
      const at = now()
      const state = stateFor(inv, caller.id, at)
      if (state === 'gone') return { outcome: 'gone' as const, inv }
      // Fixer round 3 (§21): never a role on a board in the trash (nobody can open it). Nothing is
      // redeemed, so the link works again once the board is restored (lockInvitation took the board
      // row first, so a restore or trash waits for this answer).
      if (inv.board_id !== null) {
        const board = await tx.maybeOne<{ status: string }>('SELECT status FROM boards WHERE id = $1', [
          inv.board_id,
        ])
        if (board?.status === 'trashed') throw boardInTrash()
      }
      const accepted = { workspaceId: inv.workspace_id, boardId: inv.board_id }
      if (state === 'redeemed_by_caller') return { outcome: 'ok' as const, accepted, changed: false }
      // Domain access: only an account with the invited (verified) address accepts a locked link.
      if (inv.invited_email !== null && !callerEmails.has(inv.invited_email))
        return { outcome: 'mismatch' as const, inv }
      // D5: the exceptions may have changed since a workspace admin invitation was created.
      if (
        inv.board_id === null &&
        (inv.role === 'admin' || inv.role === 'owner') &&
        !(await ctx.identity.isCreatorUser(tx, caller.id))
      )
        throw roleRequiresCreator()
      // The same per-link guest cap and rate as joining through POST /api/invitations/:token/guest.
      if (guest) await assertGuestRoomOnLink(tx, inv.id, caller.id, at)
      await redeemInvitation(tx, inv, caller.id, at)
      return { outcome: 'ok' as const, accepted, changed: true }
    })
    if (result.outcome === 'gone') return sendGone(db, reply, result.inv, user.id)
    if (result.outcome === 'mismatch') {
      req.log.info(
        {
          evt: 'invitation.email_mismatch',
          userId: user.id,
          invitationId: result.inv.id,
          invitedDomain: emailDomain(result.inv.invited_email ?? ''),
          callerDomains: distinctDomains([...callerEmails]),
        },
        'invitation email mismatch',
      )
      return sendMismatch(db, reply, result.inv)
    }
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
