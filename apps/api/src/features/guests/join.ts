// POST /api/invitations/:token/guest: join a guest link with just a name (docs/WAVE3-CONTRACTS.md §2).
//
// Someone who is not signed in gets a new guest user: no sign-in identity, a `guest` membership in the
// link's workspace and the link's board role, through the same redemption as accepting (0005's use
// counter, max uses and expiry apply). A guest who is already signed in (they joined through another
// guest link) gets the new grant on the same guest user. Either way the browser ends up with a
// `dr_session` that ends at the link's expiry or after 7 days, whichever comes first (and follows the
// link when a manager extends it: sessions.ts).
//
// Abuse limits:
// - new guests per client address (GUEST_JOINS_PER_ADDRESS: 60 per 10 minutes; an IPv6 client counts
//   by its /64). The address is the office NAT for a room of people, so it is sized for a workshop;
// - new guests per link, whatever their address (GUEST_JOINS_PER_LINK: 60 per 10 minutes), and at most
//   GUESTS_PER_LINK guests per link (limits.ts, which accepting as a signed-in guest applies too);
// - joins per signed-in guest (the accept limit).

import {
  GUEST_JOINS_PER_ADDRESS,
  type GuestJoined,
  GuestJoinInput,
  guestDisplayName,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { isSecretToken } from '../../auth/session.ts'
import { colorFor, userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, conflict, notFound, parse } from '../../errors.ts'
import { keyedLimit, type RouteRateLimit } from '../../rate-limit.ts'
import { lockInvitation, redeemInvitation, sendGone, stateFor } from '../../routes/invitations.ts'
import type { FeatureContext } from '../context.ts'
import { publishSharingChanged } from '../dashboard/shared.ts'
import { assertGuestRoomOnLink, clientAddressKey } from './limits.ts'
import { guestCookieEnd, guestSessionEnd } from './sessions.ts'

/** New guests per client address (an IPv6 client by its /64). */
export const DEFAULT_GUEST_CREATE_LIMIT: RouteRateLimit = {
  max: GUEST_JOINS_PER_ADDRESS.max,
  timeWindow: GUEST_JOINS_PER_ADDRESS.windowMs,
}
/** A signed-in guest's session is replaced by a longer one only when that gains at least this much. */
const SESSION_EXTEND_MIN_MS = 60 * 60 * 1000

export const guestsNotAllowed = () =>
  new ApiError(403, 'GUESTS_NOT_ALLOWED', 'This link needs an account. Sign in to accept it.')

export function registerGuestJoin(
  app: FastifyInstance,
  ctx: FeatureContext,
  opts: { createLimit?: RouteRateLimit } = {},
): void {
  const { db, sessions, notifier, now } = ctx
  const perIp = keyedLimit(
    opts.createLimit ?? DEFAULT_GUEST_CREATE_LIMIT,
    now,
    'Too many guests joined from this network just now. Wait a few minutes and try again.',
  )
  const perUser = keyedLimit(ctx.limits.invitations.acceptPerUser, now)

  app.post('/api/invitations/:token/guest', async (req, reply): Promise<GuestJoined | undefined> => {
    const { token } = req.params as Params
    if (!isSecretToken(token)) throw notFound()
    const input = parse(GuestJoinInput, req.body ?? {})
    const caller = await sessions.user(req)
    let guestId: string | null = null
    if (caller) {
      if ((await userKind(db, caller.id)) !== 'guest')
        throw conflict('SIGNED_IN', "You're signed in with an account. Accept the invitation instead.")
      perUser.take(caller.id)
      guestId = caller.id
    } else {
      if (input.name === undefined) throw badRequest('name: Enter your name.')
      // Counted before the transaction, not after it: simultaneous requests from one address would
      // otherwise all pass a check made before any of them committed. A refused join (a closed link,
      // the per-link cap) counts too.
      perIp.take(clientAddressKey(req.ip))
    }
    const callerSessionId = caller ? sessions.idOf(req) : null

    const result = await db.transaction(async (tx) => {
      // FOR UPDATE: the same locks as accepting (max uses, the per-link guest cap), board row first.
      const inv = await lockInvitation(tx, token)
      if (!inv) throw notFound()
      if (!inv.multi_use || !inv.allow_guests || inv.board_id === null) throw guestsNotAllowed()
      const boardId = inv.board_id
      const at = now()
      if (stateFor(inv, guestId, at) === 'gone') return { gone: true as const, inv }

      // The guest sweep (sweep.ts) takes the same user lock before it ends a guest's sessions or
      // grants, so it can never act on the state from before this join.
      if (guestId)
        await tx.one('SELECT id FROM users WHERE id = $1 AND kind = $2 FOR UPDATE', [guestId, 'guest'])
      await assertGuestRoomOnLink(tx, inv.id, guestId, at)

      let userId = guestId
      let name: string
      if (userId === null) {
        const raw = input.name ?? ''
        userId = newId('usr')
        name = guestDisplayName(raw)
        // Audited below as the invitation.accept of this user, `via: 'guest'`.
        await tx.query(
          `INSERT INTO users (id, name, handle, color, avatar_url, created_at, kind, guest_name)
           VALUES ($1, $2, NULL, $3, NULL, $4, 'guest', $5)`,
          [userId, name, colorFor(userId), at, raw],
        )
      } else {
        name = caller?.name ?? ''
      }
      await redeemInvitation(tx, inv, userId, at, { via: 'guest' })

      // The session: new guests always get one. A signed-in guest keeps theirs unless this link
      // lasts longer (a new session then replaces it) or it ended meanwhile.
      const end = guestSessionEnd(inv, at)
      let session: { token: string; expiresAt: Date } | null = null
      let sessionExpiresAt = end
      if (guestId === null) {
        session = await sessions.create(tx, userId, { expiresAt: end })
      } else {
        const current = callerSessionId
          ? await tx.maybeOne<{ expires_at: Date }>(
              `SELECT expires_at FROM sessions
                WHERE id_hash = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3`,
              [callerSessionId, userId, at],
            )
          : null
        if (!current || current.expires_at.getTime() + SESSION_EXTEND_MIN_MS <= end.getTime())
          session = await sessions.create(tx, userId, { expiresAt: end })
        else sessionExpiresAt = current.expires_at
      }
      if (session) sessionExpiresAt = session.expiresAt
      return {
        gone: false as const,
        joined: {
          workspaceId: inv.workspace_id,
          boardId,
          user: { id: userId, name },
          created: guestId === null,
          sessionExpiresAt: sessionExpiresAt.toISOString(),
        } satisfies GuestJoined,
        session,
        // The cookie outlives the session row as far as the link could be extended (sessions.ts).
        cookieEnd: guestCookieEnd(inv, at),
      }
    })

    if (result.gone) {
      await sendGone(db, reply, result.inv, guestId)
      return
    }
    const { joined, session, cookieEnd } = result
    if (session) {
      // Replacing a signed-in guest's shorter session: end the old one (and its streams).
      if (caller) await sessions.revoke(req)
      const keep = cookieEnd.getTime() > session.expiresAt.getTime() ? cookieEnd : session.expiresAt
      sessions.setCookie(reply, session.token, keep)
    }
    notifier.accessChanged({ boardId: joined.boardId, userId: joined.user.id })
    publishSharingChanged(ctx, joined.boardId, 'guest-joined')
    reply.code(joined.created ? 201 : 200)
    return joined
  })
}
