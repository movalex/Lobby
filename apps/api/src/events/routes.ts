// GET /api/boards/:bid/events — the board's server-sent event stream (view permission).
// Wire format: default "message" events whose data is JSON { type, data, seq, at }. The first event
// is { type: 'hello', data: { serverNow, role } } so clients can compute a clock offset (timers) and
// know to resynchronize. Every HEARTBEAT_MS it sends { type: 'ping' } as a data event, not an SSE
// comment: a comment never reaches the page's JS, and the client (apps/web/src/features/events.ts)
// replaces a stream that has been silent for a while (a proxy can keep the browser's side open after
// this process died).
//
// Reaching the browser live: the stream is the one long-lived response that crosses the static site's
// /api/* rewrite (Render's edge, Cloudflare in front), and measured on staging 2026-10-05 an
// intermediary held it, so events only arrived through the 40 s stale-stream reconnect. Three things
// here keep an intermediary from sitting on it: `cache-control: no-cache, no-transform` (no-transform
// forbids compressing or rewriting the body, and a compressor is the likeliest thing that buffers),
// headers flushed at once, and a comment of STREAM_PADDING bytes before the hello (a buffer that waits
// for a minimum amount before it forwards has that much to chew on). The padding is an SSE comment: the
// browser's parser discards it, so it never reaches features/events.ts. The api compresses nothing
// itself (no compression plugin), so there is nothing to exclude here.
//
// The server ends a stream with one last event (docs/SECURITY-REVIEW-2026-09-27.md authz-003/005):
// - 'access-lost': the person can no longer view the board (checked at once when access changes,
//   and for every stream at least every ACCESS_RECHECK_MS);
// - 'session-ended': the session was revoked (logout, sign out everywhere, an operator) or expired;
// - 'replaced': the same person opened more streams than their cap (EventHub): this, their oldest,
//   gave way. It carries `retry: 60000` so the browser does not reconnect straight away and push out
//   the person's next tab in turn.
// Refusals happen before the stream starts, as JSON errors: 429 RATE_LIMITED (too many opens by one
// person) and 503 TOO_MANY_SUBSCRIBERS (the board or process is full), both with Retry-After.
//
// Two ways in (wave H1, ./tickets.ts): the session cookie, same-origin (through the static site's rewrite:
// it never streams on Render, but every page built before H1 uses it and keeps working), or a ticket in
// `Authorization: Bearer`, cross-origin straight to DRAFTROOM_EVENTS_ORIGIN (the page mints it with
// POST /api/boards/:bid/events/ticket). A ticketed request is run as the session that minted the ticket,
// through this same route and every hook bound to it. CORS (only with DRAFTROOM_EVENTS_ORIGIN set, and
// only on this route): Access-Control-Allow-Origin is exactly PUBLIC_ORIGIN, never credentials; the
// preflight allows GET with the Authorization header.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { connectionRole, loadBoardAccessMany, pairKey, requireBoardAction } from '../access.ts'
import { isSecretToken, SESSION_COOKIE } from '../auth/session.ts'
import type { Params } from '../context.ts'
import { ApiError, unauthenticated } from '../errors.ts'
import type { FeatureContext } from '../features/context.ts'
import { keyedLimit } from '../rate-limit.ts'
import type { DeliveredEvent, StreamEndReason, StreamInfo } from './hub.ts'
import { createEventTicketStore, type EventTicketClaims, type EventTicketStore } from './tickets.ts'

export const HEARTBEAT_MS = 15_000
/** Every open stream's session and board access are re-checked at least this often (≤ 10 s). */
export const ACCESS_RECHECK_MS = 10_000
/** The browser's reconnect delay after 'replaced'. */
const REPLACED_RETRY_MS = 60_000
const BUSY_RETRY_AFTER_S = 30
/**
 * The first bytes of every stream: one SSE comment line of about 2 KB, then the blank line that ends
 * the field block. A comment (a line starting with ':') is dropped by every SSE parser, EventSource
 * included, and the blank line after it dispatches nothing (no data). It is padding for a proxy that
 * buffers up to some size before forwarding; see the header comment.
 */
export const STREAM_PADDING = `:${' '.repeat(2048)}\n\n`

export const EVENTS_ROUTE = '/api/boards/:bid/events'
export const EVENTS_TICKET_ROUTE = '/api/boards/:bid/events/ticket'
/** How long a browser may reuse the stream route's preflight answer (Chromium caps it at 2 hours). */
const PREFLIGHT_MAX_AGE_S = 600

/** The answer of POST /api/boards/:bid/events/ticket. */
export type EventsTicketResponse =
  | { url: string; ticket: string; expiresAt: string }
  /** DRAFTROOM_EVENTS_ORIGIN is not set: open the same-origin stream with the cookie. */
  | { url: null }

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{1,200})$/

export function registerEventRoutes(
  app: FastifyInstance,
  ctx: FeatureContext,
): { tickets: EventTicketStore } {
  const hub = ctx.events
  const { publicOrigin, eventsOrigin } = ctx.config
  // Per signed-in person (reconnects included), never per IP: an office behind one NAT is many people.
  const opens = keyedLimit(
    ctx.limits.streamOpens,
    ctx.now,
    'Too many connections opened. Wait a moment and try again.',
  )
  // Ticket mints, per person, with the same budget as opens (a direct connection is one of each).
  const mints = keyedLimit(
    ctx.limits.streamOpens,
    ctx.now,
    'Too many connections opened. Wait a moment and try again.',
  )
  const tickets = createEventTicketStore({ now: ctx.now })
  /** The claims of the ticket a stream request was let in with (the handler checks the user against them). */
  const ticketed = new WeakMap<FastifyRequest, EventTicketClaims>()

  /**
   * CORS for the stream route, only when pages open it on another origin (DRAFTROOM_EVENTS_ORIGIN):
   * exactly PUBLIC_ORIGIN, never credentials (the ticket authenticates; no cookie crosses origins).
   * Every answer varies by Origin; an answer for any other origin carries no allow header.
   */
  const corsHeaders = (req: FastifyRequest): Record<string, string> => {
    if (!eventsOrigin) return {}
    return req.headers.origin === publicOrigin
      ? { 'access-control-allow-origin': publicOrigin, vary: 'Origin' }
      : { vary: 'Origin' }
  }

  /**
   * Re-checks streams in two queries whatever their number: which sessions are still valid, then
   * board access for each distinct (board, person). A database hiccup keeps the streams; the next
   * check decides.
   */
  async function revalidate(streams: readonly StreamInfo[]): Promise<void> {
    const live = streams.filter((s) => hub.isOpen(s))
    if (!live.length) return
    let active: Set<string>
    try {
      active = await ctx.sessions.activeIds([...new Set(live.map((s) => s.sessionId))])
    } catch {
      return
    }
    const signedIn: StreamInfo[] = []
    for (const s of live) {
      if (active.has(s.sessionId)) signedIn.push(s)
      else hub.end(s, 'session-ended')
    }
    if (!signedIn.length) return
    let access: Awaited<ReturnType<typeof loadBoardAccessMany>>
    try {
      access = await loadBoardAccessMany(ctx.db, signedIn)
    } catch {
      return
    }
    for (const s of signedIn) if (!connectionRole(access.get(pairKey(s)) ?? null)) hub.end(s, 'access-lost')
  }
  hub.setRevalidator(revalidate)

  // REVIEW-6: who changed a person's access (access.changed, named) is told by the notifier of each change
  // that really changed something (notifier.ts, hub.accessChanged), with the actor from the session of its
  // request. There is no hook here: a no-op request (a grant set to what it was) sends nothing.

  // One sweep for every stream of this process, instead of a timer (and two queries) per stream.
  // Tests may check more often; nothing may check less often than ACCESS_RECHECK_MS.
  const recheckMs = Math.max(10, Math.min(ctx.limits.streamRecheckMs, ACCESS_RECHECK_MS))
  let sweeping: Promise<void> | null = null
  const sweep = setInterval(() => {
    if (sweeping) return
    sweeping = revalidate(hub.streams()).finally(() => {
      sweeping = null
    })
  }, recheckMs)
  sweep.unref()

  // Logout, sign-in rotation and sign out everywhere end that session's streams now, and drop its tickets.
  const stopListening = ctx.sessions.onRevoked((ids) => {
    tickets.revokeSessions(ids)
    void hub.endSessions(ids)
  })
  const ticketSweep = setInterval(() => tickets.sweep(), 15_000)
  ticketSweep.unref()

  // Open streams never finish on their own, so app.close() (SIGTERM on deploy) would wait for its
  // force-exit timeout while any client is connected. End them first; clients reconnect on their own.
  const open = new Set<() => void>()
  app.addHook('preClose', async () => {
    clearInterval(sweep)
    clearInterval(ticketSweep)
    stopListening()
    hub.setRevalidator(null)
    for (const end of [...open]) end()
  })
  app.addHook('onClose', async () => {
    await sweeping
  })

  // POST /api/boards/:bid/events/ticket: same-origin, with the session cookie and the api's Origin check
  // (app.ts, every POST); view permission, as for the stream itself. Name-only guests mint the same way.
  app.post(EVENTS_TICKET_ROUTE, async (req): Promise<EventsTicketResponse> => {
    const { bid } = req.params as Params
    const user = await ctx.requireUser(req)
    const sessionId = ctx.sessions.idOf(req)
    const sessionToken = req.cookies[SESSION_COOKIE]
    if (!sessionId || !isSecretToken(sessionToken)) throw unauthenticated()
    mints.take(user.id)
    const access = await requireBoardAction(ctx.db, bid ?? '', user.id, 'view')
    if (!eventsOrigin) return { url: null }
    const minted = tickets.mint({ boardId: access.board.id, userId: user.id, sessionId, sessionToken })
    if (!minted)
      throw new ApiError(
        503,
        'TOO_MANY_SUBSCRIBERS',
        'Too many connections are being opened right now. Try again in a minute.',
        { 'retry-after': String(BUSY_RETRY_AFTER_S) },
      )
    return {
      url: `${eventsOrigin}/api/boards/${encodeURIComponent(access.board.id)}/events`,
      ticket: minted.ticket,
      expiresAt: new Date(minted.expiresAt).toISOString(),
    }
  })

  // The preflight of a ticketed stream request (its Authorization header makes it one).
  app.options(EVENTS_ROUTE, async (req, reply) => {
    const cors = corsHeaders(req)
    reply.headers(cors)
    if (cors['access-control-allow-origin'])
      reply.headers({
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': 'authorization',
        'access-control-max-age': String(PREFLIGHT_MAX_AGE_S),
      })
    return reply.code(204).send()
  })

  /**
   * A ROOT onRequest hook, so that it runs before every hook that reads the stream request's session:
   * root hooks run in registration order, and this one is added after the cookie parser (app.ts) and
   * before every feature's (registerFeatures comes later), among them the workshops' raised-hand tracking
   * (onRequest) and the guests' per-link stream cap (preHandler). A route-level hook would run after all
   * root ones, too late. Sets the CORS headers first, so the page can read refusals too. Then a ticket,
   * if one came, is consumed and the request becomes the minting session's request. A request with an
   * Authorization header is ticketed or refused, never let in by a cookie. A ticket anywhere else (a
   * query string) is never read. Decided by the MATCHED route pattern, like every root guard in app.ts.
   */
  const admitTicket = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routeOptions.url !== EVENTS_ROUTE || (req.method !== 'GET' && req.method !== 'HEAD')) return
    reply.headers(corsHeaders(req))
    const auth = req.headers.authorization
    if (auth === undefined) return
    const { bid } = req.params as Params
    const m = BEARER_RE.exec(auth)
    const claims = m?.[1] ? tickets.consume(m[1]) : null
    if (!claims || claims.boardId !== bid) throw unauthenticated()
    req.cookies[SESSION_COOKIE] = claims.sessionToken
    ticketed.set(req, claims)
  }
  app.addHook('onRequest', admitTicket)

  app.get(EVENTS_ROUTE, async (req, reply) => {
    const { bid } = req.params as Params
    const user = await ctx.requireUser(req)
    const sessionId = ctx.sessions.idOf(req)
    if (!sessionId) throw unauthenticated()
    const claims = ticketed.get(req)
    // A ticket's session is the one that minted it (its cookie value is what admitTicket set): a guard.
    if (claims && (claims.userId !== user.id || claims.sessionId !== sessionId)) throw unauthenticated()
    opens.take(user.id)
    const generation = hub.accessGeneration
    const access = await requireBoardAction(ctx.db, bid ?? '', user.id, 'view')
    const boardId = access.board.id

    const res = reply.raw
    let closed = false
    const write = (payload: string) => {
      if (!closed) res.write(payload)
    }
    const send = (e: Pick<DeliveredEvent, 'type' | 'data'> & Partial<DeliveredEvent>, retryMs?: number) =>
      write(
        `${retryMs === undefined ? '' : `retry: ${retryMs}\n`}data: ${JSON.stringify({ type: e.type, data: e.data, seq: e.seq ?? 0, at: e.at })}\n\n`,
      )
    // Assigned right below, in this same tick (nothing can call it before).
    let cleanup: () => void = () => {}
    const opened = hub.openStream(boardId, {
      userId: user.id,
      sessionId,
      deliver: (e) => send(e),
      end: (reason: StreamEndReason) => {
        send({ type: reason, data: null }, reason === 'replaced' ? REPLACED_RETRY_MS : undefined)
        cleanup()
        res.end()
      },
    })
    if (!opened.ok)
      throw new ApiError(
        503,
        'TOO_MANY_SUBSCRIBERS',
        'This board has too many open connections right now. Try again in a minute.',
        { 'retry-after': String(BUSY_RETRY_AFTER_S) },
      )

    reply.hijack()
    res.writeHead(200, {
      ...corsHeaders(req),
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform: no intermediary may compress or rewrite the body (a compressing proxy holds an
      // event stream back to fill its blocks); no-store, which this was, says nothing about that.
      // no-cache: a stored copy is never reused without asking the api again.
      'cache-control': 'no-cache, no-transform',
      'x-content-type-options': 'nosniff',
      // disables response buffering in nginx-style proxies (not enough on its own behind Render's edge,
      // measured 2026-10-05)
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    // Send the status line and headers now instead of with the first write, then the padding, then hello.
    res.flushHeaders()
    write(STREAM_PADDING)
    send({ type: 'hello', data: { serverNow: ctx.now().toISOString(), role: connectionRole(access) } })

    const heartbeat = setInterval(() => send({ type: 'ping', data: null }), HEARTBEAT_MS)
    cleanup = () => {
      if (closed) return
      closed = true
      open.delete(end)
      clearInterval(heartbeat)
      opened.close()
    }
    const end = () => {
      cleanup()
      res.end()
    }
    open.add(end)
    req.raw.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
    // An access change that committed after our check but before we were subscribed found nothing to
    // re-check: do it for this stream now.
    if (hub.accessGeneration !== generation) void hub.revalidate([opened.stream]).catch(() => {})
  })

  return { tickets }
}
