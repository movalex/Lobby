// OWNER: WS4 (wave N, N4-1, "Since your last visit"). Private visit markers (@draftroom/contracts visits.ts; migration
// 0031_board_visits):
//
//   POST /api/boards/:bid/visit       (no body) → 200 VisitAnswer {previousSeenAt|null, seenAt}   view access
//   POST /api/boards/:bid/visit/seen  (no body) → 204        sendBeacon on pagehide and "Mark all seen"; view access
//
// The owner's condition for storing a visit time: nobody else ever sees who visited when, and there are no read
// receipts. So, by construction (./store.ts, held by test/features/visits/privacy.test.ts):
//  - a route reads and writes only the SESSION's own row, keyed by (board, the session's user id); no route lists,
//    counts, exports or logs visit times; the request log carries the route pattern, status and duration only; the
//    archive export, /internal/usage and the admin views know nothing of this table;
//  - a name-only guest is refused (403 GUEST_ACCOUNT_REQUIRED, before any query; the guest guard refuses it first, this
//    handler again) and keeps the device-local "Catch me up" window;
//  - someone who cannot view the board gets the 404 every board route gives;
//  - at most one write per VISIT_WRITE_MIN_INTERVAL_MS per (person, board) (./gate.ts): a faster visit answers 200 with
//    what the earlier one answered (or the stored time) and writes nothing; a faster "seen" answers 204 and its time is
//    kept and written when the interval ends (wave N.1: the server keeps a Mark all seen, not only the tab);
//  - rows past DRAFTROOM_VISITS_RETENTION_DAYS are deleted (./sweep.ts); the board's and the account's deletion cascade;
//  - (wave N.1) the times are the sync's clock, which stamps every element the page compares them with (./clock.ts;
//    the api's own while the sync's is not known).
//
// Pending (../pending-routes.ts): putting 'POST /api/boards/:bid/visit' and '…/visit/seen' back in PENDING_ROUTES hides
// both (the unknown route's 404), and the web's fetchVisit() then answers null: the chip stays hidden.

import {
  VISIT_ROUTE,
  VISIT_SEEN_ROUTE,
  VISIT_WRITE_MIN_INTERVAL_MS,
  type VisitAnswer,
} from '@draftroom/contracts'
import { pgErrorCode } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { guestRefused, VISITS_GUESTS } from '../guests/guard.ts'
import { routeUnlessPending } from '../pending-routes.ts'
import { startVisitsClock } from './clock.ts'
import { VISIT_TRAIL_TICK_MS, VisitWriteGate } from './gate.ts'
import { markSeen, recordVisit, storedVisit } from './store.ts'
import { startVisitsSweeper } from './sweep.ts'

/** A foreign-key violation: the board (or the account) was deleted between the access check and the write. */
const vanished = (e: unknown) => pgErrorCode(e) === '23503'

/** Read when the feature registers (tests may lower it before building the app, like the sweep's settings). */
export const visitsTrailSettings = { tickMs: VISIT_TRAIL_TICK_MS }

export async function registerVisits(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  // wave N.1, one clock: the sync's, which stamps the elements these times are compared with (./clock.ts); the
  // stored times, the write interval and its tick all read it
  const clock = startVisitsClock(app, ctx)
  const now = () => clock.now()
  const gate = new VisitWriteGate(VISIT_WRITE_MIN_INTERVAL_MS)
  // the "seen" times kept for the end of their interval (./gate.ts) are written by this tick, a later call or the close
  const tick = setInterval(() => gate.flushDue(now().getTime()), visitsTrailSettings.tickMs)
  tick.unref()
  app.addHook('onClose', async () => {
    clearInterval(tick)
    await gate.flushAll() // the database closes after this hook
  })

  routeUnlessPending(app, 'POST', VISIT_ROUTE, async (req, reply): Promise<VisitAnswer> => {
    const user = await ctx.requireUser(req)
    // before any board or visit query: a guest keeps the device-local window
    if (user.kind === 'guest') throw guestRefused(VISITS_GUESTS)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const boardId = access.board.id
    const key = VisitWriteGate.key(user.id, boardId)
    const at = now()
    reply.header('cache-control', 'no-store')

    // a "seen" kept from an interval that has ended is stored first: this visit's previous time includes it
    await gate.settle(key, at.getTime())
    const recent = gate.recent(key, at.getTime())
    if (recent) {
      // inside the interval: nothing is written; the earlier visit's answer (two tabs opened together, or a quick
      // reload, read the same previous time; a tab that marked it seen remembers that, web visits/ack.ts), else the
      // stored time, or (wave N.1) a "seen" kept since when it is newer: Mark all seen, then another device opens
      if (recent.answer) {
        try {
          return await recent.answer
        } catch {
          // that write failed: this call may try for itself below
        }
      }
      const stored = await storedVisit(db, boardId, user.id)
      const kept = gate.keptAt(key)
      const latest = kept !== null && (stored === null || kept > stored) ? kept : stored
      if (latest !== null) return { previousSeenAt: latest, seenAt: latest }
    }

    const write = recordVisit(db, boardId, user.id, at)
    const entry = gate.note(key, at.getTime(), write)
    try {
      return await write
    } catch (e) {
      gate.forget(key, entry)
      if (vanished(e)) throw notFound()
      throw e
    }
  })

  routeUnlessPending(app, 'POST', VISIT_SEEN_ROUTE, async (req, reply) => {
    const user = await ctx.requireUser(req)
    if (user.kind === 'guest') throw guestRefused(VISITS_GUESTS)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const boardId = access.board.id
    const key = VisitWriteGate.key(user.id, boardId)
    const at = now()
    await gate.settle(key, at.getTime())
    if (gate.recent(key, at.getTime())) {
      // inside the interval: nothing written now; the time is kept and written when the interval ends (./gate.ts),
      // to this session's own row like the write below
      gate.keep(key, at.getTime(), (at) => markSeen(db, boardId, user.id, at))
      return reply.code(204).send()
    }
    const entry = gate.note(key, at.getTime(), null)
    try {
      await markSeen(db, boardId, user.id, at)
    } catch (e) {
      gate.forget(key, entry)
      if (vanished(e)) throw notFound()
      throw e
    }
    return reply.code(204).send()
  })

  startVisitsSweeper(app, ctx)
}
