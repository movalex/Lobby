// Per-link caps for name-only guests (SEAM-05; docs/WAVE3-CONTRACTS.md §2 guests).
//
// A guest identity costs nothing but a name (60 per address per 10 minutes, 200 per link), so every
// cap that is counted per person multiplies by the guests one person can create. What reaches everyone
// on a board is therefore also capped per LINK, shared by the name-only guests who joined through it:
// - open event streams on its board (GUEST_LINK_STREAMS): past it, 503 TOO_MANY_SUBSCRIBERS (the
//   stream route's own answer for a full board), so one link never holds more than its share of the
//   board's slots (authz-003: the owner's stream must still open);
// - reactions (GUEST_LINK_REACTIONS) and "Bring everyone to me" (GUEST_LINK_SUMMONS): past them,
//   429 RATE_LIMITED with Retry-After. Only what the route accepted (202) counts, so a request refused
//   for another reason (the person's own limit, a bad body) never uses up the link's share.
// People with an account are never counted. A guest's link on a board is the first one they joined
// it through (a guest with no recorded link there has no link cap; their per-person caps still apply).
//
// Not capped per link, and why:
// - uploads: capped per workspace (bytes, files) and per person; guests' share of the quota is its own
//   finding (SEAM-02, in the files feature);
// - private-brainstorm drafts: each author's drafts are theirs alone (never broadcast before reveal),
//   capped per author, and the live counts are one event per change, rate-limited per person;
// - comments, votes and hands: rate-limited per person, stored, and removed with the guest's access.
//
// These are root hooks for other features' routes (like guard.ts), bound to every root route when the
// app is ready. They run before the route: a request refused here never reaches it.

import { GUEST_LINK_REACTIONS, GUEST_LINK_STREAMS, GUEST_LINK_SUMMONS } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isBoardId } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError } from '../../errors.ts'
import { rateLimited, SlidingWindowLimiter } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'

/** Read when an app is built: tests lower them first. */
export const guestLinkCapSettings: {
  streams: number
  reactions: { max: number; windowMs: number }
  summons: { max: number; windowMs: number }
} = {
  streams: GUEST_LINK_STREAMS,
  reactions: { ...GUEST_LINK_REACTIONS },
  summons: { ...GUEST_LINK_SUMMONS },
}

const EVENTS = 'GET /api/boards/:bid/events'
const REACTIONS = 'POST /api/boards/:bid/reactions'
const SUMMON = 'POST /api/boards/:bid/summon'

/** The stream route's refusal for a full board, with its Retry-After. */
const STREAMS_FULL_RETRY_AFTER_S = 30
const linkStreamsFull = () =>
  new ApiError(
    503,
    'TOO_MANY_SUBSCRIBERS',
    'Too many people who joined with this link are connected right now. Try again in a minute.',
    { 'retry-after': String(STREAMS_FULL_RETRY_AFTER_S) },
  )

const REACTIONS_MESSAGE = 'That is a lot of reactions from this link. Wait a moment.'
const SUMMON_MESSAGE = 'Someone who joined with this link just asked everyone to follow. Wait a moment.'

/** The link (invitation id) through which `userId` first joined `boardId`, if any. */
async function linkOf(q: Queryable, boardId: string, userId: string): Promise<string | null> {
  const row = await q.maybeOne<{ invitation_id: string }>(
    `SELECT invitation_id FROM invitation_redemptions
      WHERE board_id = $1 AND user_id = $2
      ORDER BY redeemed_at, invitation_id
      LIMIT 1`,
    [boardId, userId],
  )
  return row?.invitation_id ?? null
}

/** The name-only guests who joined through `invitationId` (at most GUESTS_PER_LINK). */
async function guestsOf(q: Queryable, invitationId: string): Promise<Set<string>> {
  const rows = await q.query<{ user_id: string }>(
    `SELECT r.user_id FROM invitation_redemptions r JOIN users u ON u.id = r.user_id AND u.kind = 'guest'
      WHERE r.invitation_id = $1`,
    [invitationId],
  )
  return new Set(rows.rows.map((r) => r.user_id))
}

const routeKey = (req: FastifyRequest) =>
  `${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions.url ?? ''}`

export function registerGuestLinkCaps(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, sessions, events, now } = ctx
  const caps = structuredClone(guestLinkCapSettings)
  const limiters = {
    [REACTIONS]: {
      limiter: new SlidingWindowLimiter(caps.reactions.max, caps.reactions.windowMs),
      message: REACTIONS_MESSAGE,
    },
    [SUMMON]: {
      limiter: new SlidingWindowLimiter(caps.summons.max, caps.summons.windowMs),
      message: SUMMON_MESSAGE,
    },
  } as const
  /** Requests that passed a link's rate check: counted once the route accepted them. */
  const pending = new WeakMap<FastifyRequest, { limiter: SlidingWindowLimiter; link: string }>()

  app.addHook('preHandler', async (req) => {
    const key = routeKey(req)
    if (key !== EVENTS && key !== REACTIONS && key !== SUMMON) return
    const { bid } = req.params as Params
    if (!isBoardId(bid)) return // the route answers 404
    // Not signed in: the route answers 401 itself. (sessions.user is cached for the request.)
    const caller = await sessions.user(req)
    if (!caller || (await userKind(db, caller.id)) !== 'guest') return
    const link = await linkOf(db, bid, caller.id)
    if (!link) return

    if (key === EVENTS) {
      const mates = await guestsOf(db, link)
      let held = 0
      for (const s of events.streams()) if (s.boardId === bid && mates.has(s.userId)) held++
      if (held >= caps.streams) throw linkStreamsFull()
      return
    }
    const { limiter, message } = limiters[key]
    const wait = limiter.retryAfterMs(link, now().getTime())
    if (wait > 0) throw rateLimited(wait, message)
    pending.set(req, { limiter, link })
  })

  app.addHook('onResponse', async (req, reply) => {
    const p = pending.get(req)
    if (!p) return
    pending.delete(req)
    if (reply.statusCode === 202) p.limiter.take(p.link, now().getTime())
  })
}
