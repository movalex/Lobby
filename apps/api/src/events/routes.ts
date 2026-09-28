// GET /api/boards/:bid/events — the board's server-sent event stream (view permission).
// Wire format: default "message" events whose data is JSON { type, data, seq, at }. The first event
// is { type: 'hello', data: { serverNow, role } } so clients can compute a clock offset (timers) and
// know to resynchronize. Every HEARTBEAT_MS it sends { type: 'ping' } as a data event, not an SSE
// comment: a comment never reaches the page's JS, and the client (apps/web/src/features/events.ts)
// replaces a stream that has been silent for a while (a proxy can keep the browser's side open after
// this process died).
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

import type { FastifyInstance } from 'fastify'
import { connectionRole, loadBoardAccessMany, pairKey, requireBoardAction } from '../access.ts'
import type { Params } from '../context.ts'
import { ApiError, unauthenticated } from '../errors.ts'
import type { FeatureContext } from '../features/context.ts'
import { keyedLimit } from '../rate-limit.ts'
import type { DeliveredEvent, StreamEndReason, StreamInfo } from './hub.ts'

export const HEARTBEAT_MS = 15_000
/** Every open stream's session and board access are re-checked at least this often (≤ 10 s). */
export const ACCESS_RECHECK_MS = 10_000
/** The browser's reconnect delay after 'replaced'. */
const REPLACED_RETRY_MS = 60_000
const BUSY_RETRY_AFTER_S = 30

export function registerEventRoutes(app: FastifyInstance, ctx: FeatureContext) {
  const hub = ctx.events
  // Per signed-in person (reconnects included), never per IP: an office behind one NAT is many people.
  const opens = keyedLimit(
    ctx.limits.streamOpens,
    ctx.now,
    'Too many connections opened. Wait a moment and try again.',
  )

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

  // Logout, sign-in rotation and sign out everywhere end that session's streams now.
  const stopListening = ctx.sessions.onRevoked((ids) => void hub.endSessions(ids))

  // Open streams never finish on their own, so app.close() (SIGTERM on deploy) would wait for its
  // force-exit timeout while any client is connected. End them first; clients reconnect on their own.
  const open = new Set<() => void>()
  app.addHook('preClose', async () => {
    clearInterval(sweep)
    stopListening()
    hub.setRevalidator(null)
    for (const end of [...open]) end()
  })
  app.addHook('onClose', async () => {
    await sweeping
  })

  app.get('/api/boards/:bid/events', async (req, reply) => {
    const { bid } = req.params as Params
    const user = await ctx.requireUser(req)
    const sessionId = ctx.sessions.idOf(req)
    if (!sessionId) throw unauthenticated()
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
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // disables response buffering in nginx-style proxies (Render's edge included, UNVERIFIED)
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
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
}
