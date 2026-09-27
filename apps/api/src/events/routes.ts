// GET /api/boards/:bid/events — the board's server-sent event stream (view permission).
// Wire format: default "message" events whose data is JSON { type, data, seq, at }. The first event
// is { type: 'hello', data: { serverNow, role } } so clients can compute a clock offset (timers) and
// know to resynchronize. The stream re-checks access periodically and ends with 'access-lost'.
// Every HEARTBEAT_MS it sends { type: 'ping' } as a data event, not an SSE comment: a comment never
// reaches the page's JS, and the client (apps/web/src/features/events.ts) replaces a stream that has
// been silent for a while (a proxy can keep the browser's side open after this process died).

import type { FastifyInstance } from 'fastify'
import { connectionRole, loadBoardAccess, requireBoardAction } from '../access.ts'
import type { Params } from '../context.ts'
import type { FeatureContext } from '../features/context.ts'
import type { DeliveredEvent } from './hub.ts'

export const HEARTBEAT_MS = 15_000
const ACCESS_RECHECK_MS = 30_000

export function registerEventRoutes(app: FastifyInstance, ctx: FeatureContext) {
  // Open streams never finish on their own, so app.close() (SIGTERM on deploy) would wait for its
  // force-exit timeout while any client is connected. End them first; clients reconnect on their own.
  const open = new Set<() => void>()
  app.addHook('preClose', async () => {
    for (const end of [...open]) end()
  })

  app.get('/api/boards/:bid/events', async (req, reply) => {
    const { bid } = req.params as Params
    const user = await ctx.requireUser(req)
    const access = await requireBoardAction(ctx.db, bid ?? '', user.id, 'view')
    const boardId = access.board.id

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // disables response buffering in nginx-style proxies (Render's edge included, UNVERIFIED)
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    })
    let closed = false
    const write = (payload: string) => {
      if (!closed) res.write(payload)
    }
    const send = (e: Pick<DeliveredEvent, 'type' | 'data'> & Partial<DeliveredEvent>) =>
      write(`data: ${JSON.stringify({ type: e.type, data: e.data, seq: e.seq ?? 0, at: e.at })}\n\n`)

    const unsubscribe = ctx.events.subscribe(boardId, (e) => send(e))
    if (!unsubscribe) {
      send({ type: 'error', data: { code: 'TOO_MANY_SUBSCRIBERS' } })
      res.end()
      return
    }
    send({ type: 'hello', data: { serverNow: ctx.now().toISOString(), role: connectionRole(access) } })

    const heartbeat = setInterval(() => send({ type: 'ping', data: null }), HEARTBEAT_MS)
    const recheck = setInterval(() => {
      void loadBoardAccess(ctx.db, boardId, user.id)
        .then((a) => {
          if (!connectionRole(a)) {
            send({ type: 'access-lost', data: null })
            cleanup()
            res.end()
          }
        })
        .catch(() => {}) // database hiccup: keep the stream, the next check decides
    }, ACCESS_RECHECK_MS)
    const cleanup = () => {
      if (closed) return
      closed = true
      open.delete(end)
      clearInterval(heartbeat)
      clearInterval(recheck)
      unsubscribe()
    }
    const end = () => {
      cleanup()
      res.end()
    }
    open.add(end)
    req.raw.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  })
}
