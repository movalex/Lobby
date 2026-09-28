// Per-link caps for name-only guests (SEAM-05; docs/WAVE3-CONTRACTS.md §2 guests).
//
// A guest identity costs nothing but a name (60 per address per 10 minutes, 200 per link), so every
// cap that is counted per person multiplies by the guests one person can create. What reaches everyone
// on a board is therefore also capped per LINK, shared by the name-only guests who joined through it:
// - open event streams on its board (GUEST_LINK_STREAMS): past it, 503 TOO_MANY_SUBSCRIBERS (the
//   stream route's own answer for a full board), so one link never holds more than its share of the
//   board's slots (authz-003: the owner's stream must still open);
// - reactions (GUEST_LINK_REACTIONS) and "Bring everyone to me" (GUEST_LINK_SUMMONS): past them,
//   429 RATE_LIMITED with Retry-After. Only what the route accepted (202) counts: a request refused
//   for another reason (the person's own limit, a bad body) gives its share back.
// Simultaneous requests cannot all slip past a cap: the check reserves in the same tick in which it
// decides (a Postgres pool interleaves requests between their checks and their effects). A stream
// counts from its check until the route has answered it (then the hub counts it); a reaction or summon
// takes its share at the check and gives it back if the route refuses it.
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

import type { ServerResponse } from 'node:http'
import { GUEST_LINK_REACTIONS, GUEST_LINK_STREAMS, GUEST_LINK_SUMMONS } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isBoardId } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError } from '../../errors.ts'
import { rateLimited } from '../../rate-limit.ts'
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

/**
 * A sliding window per link whose takes can be given back. The check TAKES (in the same tick as the
 * decision), so simultaneous requests cannot all pass it; a request the route then refuses gives its
 * take back. Bounded like SlidingWindowLimiter: past `maxKeys` links the least recently used is dropped.
 */
class LinkWindow {
  private readonly hits = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private readonly maxKeys: number

  constructor(max: number, windowMs: number, maxKeys = 10_000) {
    this.max = max
    this.windowMs = windowMs
    this.maxKeys = maxKeys
  }

  /** Takes one for `key` at `atMs`: 0, or (taking nothing) how long until one frees. */
  take(key: string, atMs: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => atMs - t < this.windowMs)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return Math.max(1, (list[0] ?? atMs) + this.windowMs - atMs)
    }
    list.push(atMs)
    this.hits.delete(key) // re-inserted: the Map's order is least recently used first
    this.hits.set(key, list)
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value
      if (oldest === undefined) break
      this.hits.delete(oldest)
    }
    return 0
  }

  /** Gives back the take made for `key` at `atMs`. */
  giveBack(key: string, atMs: number): void {
    const list = this.hits.get(key)
    const i = list ? list.lastIndexOf(atMs) : -1
    if (!list || i < 0) return
    list.splice(i, 1)
    if (list.length === 0) this.hits.delete(key)
  }
}

/**
 * Calls `settle` once: when the response head is written, or when the response closes first (the
 * client went away). The stream route writes its head in the same tick in which the hub admits the
 * stream (routes.ts: openStream, then writeHead), and every refusal writes one too (Node writes the
 * head through writeHead even for an implicit one), so from then on the hub's own count covers it.
 */
function onHeadWritten(reply: FastifyReply, settle: () => void): void {
  const res = reply.raw
  const writeHead = res.writeHead
  let done = false
  const once = () => {
    if (done) return
    done = true
    if (res.writeHead === watched) res.writeHead = writeHead
    res.off('close', once)
    settle()
  }
  const watched = function (this: ServerResponse, ...args: unknown[]) {
    once()
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args)
  } as ServerResponse['writeHead']
  res.writeHead = watched
  res.once('close', once)
}

export function registerGuestLinkCaps(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, sessions, events, now } = ctx
  const caps = structuredClone(guestLinkCapSettings)
  const windows = {
    [REACTIONS]: {
      window: new LinkWindow(caps.reactions.max, caps.reactions.windowMs),
      message: REACTIONS_MESSAGE,
    },
    [SUMMON]: {
      window: new LinkWindow(caps.summons.max, caps.summons.windowMs),
      message: SUMMON_MESSAGE,
    },
  } as const
  /** Takes of requests still in the route: given back unless it accepts them (202). */
  const taken = new WeakMap<FastifyRequest, { window: LinkWindow; link: string; at: number }>()
  /** Per link: streams that passed the check and that the route has not answered yet. */
  const admitting = new Map<string, number>()

  app.addHook('preHandler', async (req, reply) => {
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
      // No await from here on: the count and the reservation happen in one tick, so simultaneous
      // opens by the link's guests (a Postgres pool interleaves them) see each other.
      let held = admitting.get(link) ?? 0
      for (const s of events.streams()) if (s.boardId === bid && mates.has(s.userId)) held++
      if (held >= caps.streams) throw linkStreamsFull()
      admitting.set(link, (admitting.get(link) ?? 0) + 1)
      onHeadWritten(reply, () => {
        const n = (admitting.get(link) ?? 1) - 1
        if (n > 0) admitting.set(link, n)
        else admitting.delete(link)
      })
      return
    }
    const { window, message } = windows[key]
    const at = now().getTime()
    const wait = window.take(link, at)
    if (wait > 0) throw rateLimited(wait, message)
    taken.set(req, { window, link, at })
  })

  app.addHook('onResponse', async (req, reply) => {
    const t = taken.get(req)
    if (!t) return
    taken.delete(req)
    if (reply.statusCode !== 202) t.window.giveBack(t.link, t.at)
  })
}
