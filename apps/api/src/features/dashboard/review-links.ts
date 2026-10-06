// Review links (multi-use board invitations) and the board's pending-invitation list.
//
// A review link is an `invitations` row with multi_use = true (0005_dashboard): viewer or commenter,
// expiry at most 30 days, optional max uses. A workshop link (RETRO-04a, 0006) is the same row with
// role editor, 3 h by default and never more than 24 h after creation ("+1 h" extends it up to that).
// People accept either through M1's POST /api/invitations/:token/accept (sign-in required); the 0005
// trigger records each use instead of consuming the link. A link created with `allowGuests` (wave 3,
// 0009) also lets people join with just a name: POST /api/invitations/:token/guest (features/guests).
// A manager can turn that on or off for a link that exists (PATCH /api/boards/:bid/review-links/:id).
//
// The token is derived from the invitation id with a server-side key (HMAC), so managers can copy the
// link again later while the database still stores only its sha256. Access that a review link created
// ends when the link expires (sweeper below), or at once when a manager revokes it with removal.

import { createHmac } from 'node:crypto'
import {
  CreateReviewLinkInput,
  ExtendReviewLinkInput,
  InvitationId,
  type PendingInvitation,
  type ReviewLinkRole,
  RevokeReviewLinkInput,
  reviewLinkLifetimeMs,
  reviewLinkMaxLifetimeMs,
  UpdateReviewLinkInput,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { lockBoardRow, requireBoardAction } from '../../access.ts'
import { audit } from '../../audit.ts'
import { sha256hex } from '../../auth/session.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { conflict, notFound, parse } from '../../errors.ts'
import { actorOf } from '../../notifier.ts'
import { guestAccountRequired } from '../../routes/invitations.ts'
import type { FeatureContext } from '../context.ts'
import { publishExportPolicy } from '../export-control/index.ts'
import { limitExportForClientLink } from '../export-control/policy.ts'
import { extendGuestSessions } from '../guests/sessions.ts'
import { publishSharingChanged } from './shared.ts'

/** Open review links per board (a runaway client cannot fill the table). */
export const MAX_ACTIVE_REVIEW_LINKS = 20
// Short: an expired workshop link must end its edit grants (and, through sync, the open sockets)
// within seconds. One indexed query per tick (invitations_review_links_idx).
const SWEEP_INTERVAL_MS = 5_000
const SWEEP_BATCH = 50
const HOUR_MS = 60 * 60 * 1000

/** Review-link token for an invitation id: HMAC under a key derived from the ticket secret. */
export function reviewLinkToken(secret: string, invitationId: string): string {
  const key = createHmac('sha256', secret).update('draftroom:review-link-token:v1').digest()
  return createHmac('sha256', key).update(invitationId).digest('base64url')
}

interface LinkRow {
  id: string
  workspace_id: string
  board_id: string
  role: ReviewLinkRole
  created_by: string
  created_at: Date
  expires_at: Date
  revoked_at: Date | null
  swept_at: Date | null
  /** 0009_guests: people can join with just a name. */
  allow_guests: boolean
}
const LINK_COLUMNS =
  'id, workspace_id, board_id, role, created_by, created_at, expires_at, revoked_at, swept_at, allow_guests'

const RANK: Record<string, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 }
const higher = (a: string | null, b: string | null) => ((RANK[b ?? ''] ?? 0) > (RANK[a ?? ''] ?? 0) ? b : a)
const lower = (a: string, b: string) => ((RANK[b] ?? 0) < (RANK[a] ?? 0) ? b : a)

interface JoinedRow {
  user_id: string
  grant: ReviewLinkRole | 'owner'
  previous_role: ReviewLinkRole | null
  /** A name-only guest (users.kind 'guest', wave 3): their grants on a board come only from its links. */
  guest: boolean
  /** The grant was created by a multi-use link of this board (any) and still has that link's role. */
  created_by_link: boolean
  /** Other open multi-use links of this board the person joined through. */
  others: { id: string; role: ReviewLinkRole }[] | null
}

/**
 * Ends the access that multi-use links gave the people who joined through `link`:
 * - a grant a link CREATED (still at that link's role) is removed. A grant a link created that a later
 *   link raised counts as created by a link too (redeemInvitation stamps the raise so: J2 / MISS-1), so
 *   it ends when the last of those links ends instead of staying for good;
 * - a grant a workshop (edit) link RAISED goes back to the role it had before (0006 previous_role),
 *   so a viewer who joined a workshop is a viewer again afterwards. (A review link's raise stays, as
 *   before: those links never go above comment.)
 * Another open link the person joined through keeps them at that link's role instead. Grants of people
 * with an account that changed since (the owner gave another role) are left alone.
 * A name-only guest (J2 / INV-2) is different: a guest reaches a board only through its guest links
 * (guard.ts), so whatever role their grant has now (an owner may have lowered or raised it), it lasts
 * only while one of their links on this board is open: it is lowered to the best open link's role (never
 * raised back above what an owner left), or removed when none is left, and the guest sweep then signs
 * out a guest left with no grant at all. Returns the affected user ids. Call inside the transaction that
 * marks the link swept, with the board row locked.
 */
export async function removeReviewLinkGrants(tx: Queryable, link: LinkRow, at: Date): Promise<string[]> {
  const rows = await tx.query<JoinedRow>(
    `SELECT r.user_id, bm.role AS grant, r.previous_role, u.kind = 'guest' AS guest,
            EXISTS (
              SELECT 1 FROM invitation_redemptions r3 JOIN invitations i3 ON i3.id = r3.invitation_id
               WHERE r3.board_id = r.board_id AND r3.user_id = r.user_id AND i3.multi_use
                 AND r3.redeemed_at = bm.created_at AND i3.role = bm.role) AS created_by_link,
            (SELECT json_agg(json_build_object('id', i2.id, 'role', i2.role))
               FROM invitation_redemptions r2 JOIN invitations i2 ON i2.id = r2.invitation_id
              WHERE r2.board_id = r.board_id AND r2.user_id = r.user_id AND i2.id <> r.invitation_id
                AND i2.multi_use AND i2.swept_at IS NULL AND i2.revoked_at IS NULL AND i2.expires_at > $3
            ) AS others
       FROM invitation_redemptions r
       JOIN board_members bm ON bm.board_id = r.board_id AND bm.user_id = r.user_id
       JOIN users u ON u.id = r.user_id
      WHERE r.invitation_id = $1 AND r.board_id = $2`,
    [link.id, link.board_id, at],
  )
  const affected: string[] = []
  for (const row of rows.rows) {
    let keeper: { id: string; role: ReviewLinkRole } | null = null
    for (const o of row.others ?? [])
      if (!keeper || (RANK[o.role] ?? 0) > (RANK[keeper.role] ?? 0)) keeper = o
    let fallback: string | null = null
    let target: string | null
    if (row.guest) {
      // Only another open link keeps a guest in; what they had before this link (previous_role) came
      // from a link too, and that one counts only while it is open (it is then `keeper`).
      target = keeper ? lower(row.grant, keeper.role) : null
    } else {
      if (row.grant !== link.role) continue // changed since: an explicit decision the link must not undo
      const raised = !row.created_by_link && link.role === 'editor' && row.previous_role !== null
      if (!row.created_by_link && !raised) continue // the grant predates the link
      fallback = row.created_by_link ? null : row.previous_role
      target = higher(fallback, keeper?.role ?? null)
    }
    if (target === row.grant) continue // another open link keeps this role
    if (target === null) {
      await tx.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [
        link.board_id,
        row.user_id,
      ])
    } else {
      await tx.query('UPDATE board_members SET role = $3 WHERE board_id = $1 AND user_id = $2', [
        link.board_id,
        row.user_id,
        target,
      ])
      // The grant now lives on through `keeper`: mark it as that link's, so it ends with it.
      if (keeper && target === keeper.role && fallback === null)
        await tx.query(
          `UPDATE invitation_redemptions r SET redeemed_at = bm.created_at
             FROM board_members bm
            WHERE r.invitation_id = $1 AND r.user_id = $2 AND bm.board_id = $3 AND bm.user_id = $2`,
          [keeper.id, row.user_id, link.board_id],
        )
    }
    affected.push(row.user_id)
  }
  return affected
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
      // The board row first, then the link (the lock order in access.ts, which revoke and "+1 h" of the
      // same link follow): its board comes from an unlocked read, and the link is read again locked.
      const found = await tx.maybeOne<{ board_id: string }>(
        'SELECT board_id FROM invitations WHERE id = $1 AND multi_use',
        [id],
      )
      if (!found) return null
      await lockBoardRow(tx, found.board_id)
      const link = await tx.maybeOne<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM invitations WHERE id = $1 AND multi_use FOR UPDATE`,
        [id],
      )
      // Swept meanwhile (a revoke with removal), or no longer due.
      if (!link || link.swept_at || link.expires_at.getTime() > at.getTime()) return null
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
  role: ReviewLinkRole
  multi_use: boolean
  allow_guests: boolean
  max_uses: number | null
  use_count: number
  created_at: Date
  expires_at: Date
  token_hash: string
  creator_id: string
  creator_name: string
  invited_email: string | null
}

export function registerReviewLinkRoutes(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, now, notifier, config } = ctx
  const linkUrl = (token: string) => `${config.publicOrigin}/invite/${token}`

  // Pending links of the board: M1 single-use links nobody redeemed yet, and open review links.
  app.get('/api/boards/:bid/invitations', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'manage_access')
    // Domain access (D4): a manager who is not a creator sees the list, but never a multi-use link's URL,
    // so they cannot hand out a link that already exists. The caller is freshened like at /api/me
    // (confirmed first when unconfirmed, a background refresh after 1 h; after the permission check), so
    // a manager who never loads /api/me still loses a removed company address. The decision reads the
    // database, so an awaited refresh counts at once. Fixer round 4 (§22): the list is read before a due
    // background refresh starts (freshenThen), so `url` follows the stored status on a pool too.
    return ctx.identity.freshenThen(req, user, async () => {
      const mayShare = await ctx.identity.isCreatorUser(db, user.id)
      const rows = await db.query<InvitationListRow>(
        `SELECT i.id, i.role, i.multi_use, i.allow_guests, i.max_uses, i.use_count, i.created_at, i.expires_at, i.token_hash,
              u.id AS creator_id, u.name AS creator_name, i.invited_email
         FROM invitations i JOIN users u ON u.id = i.created_by
        WHERE i.board_id = $1 AND i.workspace_id = $2 AND i.revoked_at IS NULL AND i.redeemed_by IS NULL
          AND i.expires_at > $3
        ORDER BY i.multi_use DESC, i.created_at DESC, i.id
        LIMIT 200`,
        [bid, access.board.workspace_id, now()],
      )
      const invitations: PendingInvitation[] = rows.rows.map((r) => {
        let url: string | null = null
        if (r.multi_use && mayShare) {
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
          maxExpiresAt: r.multi_use
            ? new Date(r.created_at.getTime() + reviewLinkMaxLifetimeMs(r.role)).toISOString()
            : null,
          allowGuests: r.multi_use && r.allow_guests,
          // Domain access: the full address a single-use invitation is locked to (this manager-only list is
          // the one response that carries it).
          email: r.multi_use ? null : r.invited_email,
        }
      })
      return { invitations }
    })
  })

  app.post('/api/boards/:bid/review-links', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateReviewLinkInput, req.body ?? {})
    const created = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      // Wave 3: a name-only guest never hands out links, whatever board role they were given.
      if ((await userKind(tx, user.id)) === 'guest')
        throw guestAccountRequired('Sign in with an account to create links.')
      // Domain access (D4): review, workshop and client guest links are creator-only.
      await ctx.identity.requireCreator(tx, user.id, 'share', {
        route: req.routeOptions.url ?? '',
        by: 'route',
      })
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
      // Review links up to 30 days; workshop (edit) links default to 3 h and never pass 24 h.
      const lifetime = Math.min(reviewLinkLifetimeMs(input), reviewLinkMaxLifetimeMs(input.role))
      const expiresAt = new Date(at.getTime() + lifetime)
      await tx.query(
        `INSERT INTO invitations (id, token_hash, workspace_id, board_id, role, created_by, created_at,
                                  expires_at, multi_use, max_uses, allow_guests)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)`,
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
          input.allowGuests,
        ],
      )
      await audit(tx, {
        workspaceId: access.board.workspace_id,
        actorId: user.id,
        action: 'invitation.create',
        target: id,
        detail: {
          boardId: bid,
          role: input.role,
          multiUse: true,
          maxUses: input.maxUses,
          ...(input.allowGuests ? { allowGuests: true } : {}),
        },
        at,
      })
      // DANA2-01: a client link (view or comment) on a board whose owner never chose an export policy
      // turns exporting and original downloads off for the people it lets in. Workshop (edit) links
      // leave the policy alone; an owner's own choice always stays.
      const limitedExport =
        input.role !== 'editor' && (await limitExportForClientLink(tx, access.board, user.id, at))
      return {
        id,
        url: linkUrl(token),
        role: input.role,
        expiresAt: expiresAt.toISOString(),
        maxUses: input.maxUses,
        allowGuests: input.allowGuests,
        limitedExport,
      }
    })
    const { limitedExport, ...link } = created
    if (limitedExport) publishExportPolicy(ctx, bid, 'editors')
    publishSharingChanged(ctx, bid, 'review-link-created')
    reply.code(201)
    return link
  })

  app.post('/api/boards/:bid/review-links/:id/revoke', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', id = '' } = req.params as Params
    const { removeAccess } = parse(RevokeReviewLinkInput, req.body ?? {})
    const result = await db.transaction(async (tx) => {
      // The board row, then the link (the lock order in access.ts; joining and accepting follow it).
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if (!InvitationId.safeParse(id).success) throw notFound()
      const link = await tx.maybeOne<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM invitations WHERE id = $1 AND board_id = $2 AND multi_use FOR UPDATE`,
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
    // REVIEW-6: whoever revoked the link is named to the guests who lost their access (the session's user)
    for (const userId of result.users) notifier.accessChanged({ boardId: bid, userId, actor: actorOf(user) })
    publishSharingChanged(ctx, bid, 'review-link-revoked')
    return { removed: result.users.length }
  })

  // "+1 h" (RETRO-04a): an open link lasts longer, never past its role's cap counted from creation
  // (24 h for a workshop link, 30 days for a review link). Expired or revoked links stay closed.
  app.post('/api/boards/:bid/review-links/:id/extend', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', id = '' } = req.params as Params
    const { hours } = parse(ExtendReviewLinkInput, req.body ?? {})
    const result = await db.transaction(async (tx) => {
      // The board row, then the link (the lock order in access.ts).
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      // Domain access (D4): extending a link hands out access for longer: creator-only.
      await ctx.identity.requireCreator(tx, user.id, 'share', {
        route: req.routeOptions.url ?? '',
        by: 'route',
      })
      if (!InvitationId.safeParse(id).success) throw notFound()
      const link = await tx.maybeOne<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM invitations WHERE id = $1 AND board_id = $2 AND multi_use FOR UPDATE`,
        [id, access.board.id],
      )
      if (!link) throw notFound()
      const at = now()
      if (link.revoked_at !== null || link.swept_at !== null || link.expires_at.getTime() <= at.getTime())
        throw conflict('LINK_CLOSED', 'This link has expired or was revoked. Create a new one.')
      const cap = link.created_at.getTime() + reviewLinkMaxLifetimeMs(link.role)
      const next = Math.min(link.expires_at.getTime() + hours * HOUR_MS, cap)
      if (next <= link.expires_at.getTime())
        throw conflict(
          'LINK_MAX_EXPIRY',
          link.role === 'editor'
            ? 'Workshop links last at most 24 hours. Create a new one to keep going.'
            : 'Review links last at most 30 days. Create a new one to keep going.',
        )
      const expiresAt = new Date(next)
      await tx.query('UPDATE invitations SET expires_at = $2 WHERE id = $1', [id, expiresAt])
      // Wave 3: guests who joined through the link stay signed in for its new end, too. Whether or not the
      // link still lets NEW guests in (G2: a manager can turn that off after people joined): the guests
      // who are in keep their access until the link's end, so their sessions follow it.
      await extendGuestSessions(tx, id, expiresAt, at)
      await audit(tx, {
        workspaceId: link.workspace_id,
        actorId: user.id,
        action: 'invitation.extend',
        target: id,
        detail: { boardId: bid, from: link.expires_at.toISOString(), to: expiresAt.toISOString() },
        at,
      })
      return { expiresAt: expiresAt.toISOString(), maxExpiresAt: new Date(cap).toISOString() }
    })
    publishSharingChanged(ctx, bid, 'review-link-extended')
    return result
  })

  // Wave G2: "Anyone with the link can join with just a name" for a link that already exists (the Share
  // dialog used to apply that box only to the NEXT link, and said "with just a name" over a link whose
  // invite page still wanted a sign-in). Only this flag: the link's role, expiry and use cap are not
  // touched, so guests keep exactly the access the link always gave (the same role, this board only).
  // - Turning it ON lets anyone with the URL in, so it is creator-only like creating a guest link
  //   (domain access, D4) and never for a name-only guest. Turning it OFF only narrows who can join and
  //   stays open to every manager (lowering access stays open: PUT members, PATCH visibility).
  // - Turning it off stops NEW name-only joins (join.ts and a signed-in guest accepting both read the
  //   flag under the invitation lock). People who already joined keep their access until the link ends
  //   or is revoked ("Revoke…" can remove them): a checkbox must not log people out mid-session.
  // - An expired, revoked or swept link stays closed (409 LINK_CLOSED), like "+1 h".
  app.patch('/api/boards/:bid/review-links/:id', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', id = '' } = req.params as Params
    const { allowGuests } = parse(UpdateReviewLinkInput, req.body ?? {})
    const result = await db.transaction(async (tx) => {
      // The board row, then the link (the lock order in access.ts; joining and accepting follow it).
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if ((await userKind(tx, user.id)) === 'guest')
        throw guestAccountRequired('Sign in with an account to change links.')
      if (allowGuests)
        await ctx.identity.requireCreator(tx, user.id, 'share', {
          route: req.routeOptions.url ?? '',
          by: 'route',
        })
      if (!InvitationId.safeParse(id).success) throw notFound()
      const link = await tx.maybeOne<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM invitations WHERE id = $1 AND board_id = $2 AND multi_use FOR UPDATE`,
        [id, access.board.id],
      )
      if (!link) throw notFound()
      const at = now()
      if (link.revoked_at !== null || link.swept_at !== null || link.expires_at.getTime() <= at.getTime())
        throw conflict('LINK_CLOSED', 'This link has expired or was revoked. Create a new one.')
      const changed = link.allow_guests !== allowGuests
      if (changed) {
        await tx.query('UPDATE invitations SET allow_guests = $2 WHERE id = $1', [id, allowGuests])
        await audit(tx, {
          workspaceId: link.workspace_id,
          actorId: user.id,
          action: 'invitation.update',
          target: id,
          detail: { boardId: bid, multiUse: true, allowGuests },
          at,
        })
      }
      return { allowGuests, changed }
    })
    if (result.changed) publishSharingChanged(ctx, bid, 'review-link-updated')
    return { allowGuests: result.allowGuests }
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
