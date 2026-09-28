// Feature module: workshops (docs/FEATURES-M2-CONTRACTS.md, "workshops"): the shared timer, dot
// voting, "gather everyone", reactions and raise hand. Owned by the workshops engineer.
//
// Permissions (server-side; the UI only hides controls):
// - GET state, past votes, revealed results: `view`.
// - Timer control, starting/extending/closing/revealing a vote, summon, lowering someone else's
//   hand: `edit` (facilitators), with an account: name-only guests take part but never facilitate
//   (final review R3, facilitators.ts).
// - Casting, "I'm done", reacting and raising a hand: `view` on an ACTIVE board — viewers and
//   commenters take part; the person is always the signed-in user. Lowering your own hand: `view`.
// Events are published only after the transaction commits, and carry aggregates only. Reactions and
// hands are in-memory (hands.ts, reactions.ts): nothing about them is stored.

import {
  CastVoteInput,
  CreateVoteInput,
  ExtendVoteInput,
  HandInput,
  type HandsResponse,
  isVoteEligible,
  REACTION_RATE_MAX,
  REACTION_RATE_WINDOW_MS,
  ReactionInput,
  SummonInput,
  TimerActionInput,
  VOTE_DURATION_MAX_MS,
  VoteDoneInput,
  WORKSHOP_EVENTS,
  type WorkshopReactionEvent,
  type WorkshopState,
  type WorkshopSummonEvent,
} from '@draftroom/contracts'
import { isId, isUniqueViolation, newId, type Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { isBoardId, isUserId, requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, conflict, forbidden, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { requireFacilitatorAccount, TIMER_NOT_YOURS } from './facilitators.ts'
import { HandLimitError, HandRegistry } from './hands.ts'
import { registerPresentation } from './presentation.ts'
import { allowedNow, registerPrivateNotes } from './private-notes.ts'
import { REACTIONS_PER_BOARD_MAX, SlidingWindowLimiter } from './reactions.ts'
import { createShapeIndex, type ShapeIndex } from './shapes.ts'
import { applyTimerAction, TimerRuleError, type TimerState, timerHolder, timerView } from './timer.ts'
import {
  aggregates,
  castInLockedSession,
  currentSession,
  effectiveStatus,
  findSession,
  lockSession,
  notEligible,
  revealedResults,
  SESSION_COLUMNS,
  type SessionRow,
  summaries,
  toVoteSession,
  voteClosed,
  voteEvent,
  voteState,
} from './votes.ts'

export interface WorkshopOptions {
  /** Injected in tests (fake clock for the snapshot cache). */
  shapeIndex?: ShapeIndex
  /** Minimum time between two summons by one person on one board. */
  summonCooldownMs?: number
  /** How often raised hands are checked for expiry/disconnects without a request (0 = never). */
  handSweepMs?: number
  /** Reactions relayed per board per window (default REACTIONS_PER_BOARD_MAX). */
  reactionsPerBoardMax?: number
}

/** The board event stream route (apps/api/src/events/routes.ts): raised hands follow its lifetime. */
const EVENTS_ROUTE = '/api/boards/:bid/events'

interface TimerRow {
  board_id: string
  workspace_id: string
  status: TimerState['status']
  duration_ms: number
  started_at: Date | null
  ends_at: Date | null
  remaining_ms: number
  started_by: string | null
  updated_at: Date
}

const toState = (r: TimerRow): TimerState => ({
  status: r.status,
  durationMs: r.duration_ms,
  remainingMs: r.remaining_ms,
  startedAt: r.started_at,
  endsAt: r.ends_at,
  startedBy: r.started_by,
  updatedAt: r.updated_at,
})

async function loadTimer(q: Queryable, boardId: string, lock = false): Promise<TimerState | null> {
  const row = await q.maybeOne<TimerRow>(
    `SELECT * FROM workshop_timers WHERE board_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [boardId],
  )
  return row ? toState(row) : null
}

const timerRuleToApi = (e: TimerRuleError) =>
  e.code === 'TOO_LONG' ? badRequest(e.message) : conflict(e.code, e.message)

const readOnlyBoard = () => forbidden('This board is read-only.')

export async function registerWorkshops(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  registerWorkshopRoutes(app, ctx)
  // Private brainstorming (wave 3, private-notes.ts): drafts only their author sees until revealed.
  registerPrivateNotes(app, ctx)
  // Present to everyone (wave 4, present-live; presentation.ts): in memory, like raised hands.
  registerPresentation(app, ctx)
}

export function registerWorkshopRoutes(
  app: FastifyInstance,
  ctx: FeatureContext,
  opts: WorkshopOptions = {},
) {
  const { db, now, events } = ctx
  // The cache runs on the app clock, so tests can age it with their controllable clock.
  const shapes = opts.shapeIndex ?? createShapeIndex(ctx.sync, { clock: () => now().getTime() })
  const summonCooldown = opts.summonCooldownMs ?? 3_000
  const lastSummon = new Map<string, number>()
  const reactionLimit = new SlidingWindowLimiter(REACTION_RATE_MAX, REACTION_RATE_WINDOW_MS)
  const boardReactionLimit = new SlidingWindowLimiter(
    opts.reactionsPerBoardMax ?? REACTIONS_PER_BOARD_MAX,
    REACTION_RATE_WINDOW_MS,
  )
  const hands = new HandRegistry({
    now,
    publish: (boardId, data) => events.publish(boardId, { type: WORKSHOP_EVENTS.hand, data }),
  })

  // A hand goes down when its owner's event streams on the board have all ended (after a grace, so a
  // reload keeps it). The stream route is not this feature's, so its lifetime is observed here: every
  // GET of the stream route by a signed-in person counts one open stream until its response closes
  // (the stream's own access check still decides whether it opens; a refused one closes at once).
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' || req.routeOptions.url !== EVENTS_ROUTE) return
    const { bid = '' } = req.params as Params
    if (!isBoardId(bid)) return
    const user = await ctx.sessions.user(req).catch(() => null)
    if (!user) return
    hands.streamOpened(bid, user.id)
    reply.raw.once('close', () => hands.streamClosed(bid, user.id))
  })
  const handSweepMs = opts.handSweepMs ?? 1_000
  if (handSweepMs > 0) {
    const stopSweeper = hands.startSweeper(handSweepMs)
    app.addHook('onClose', async () => stopSweeper())
  }

  // The version is read right after the list (same tick), so it describes that list.
  const handsBody = (boardId: string, list = hands.list(boardId)): HandsResponse => ({
    hands: list,
    version: hands.version(),
    serverNow: now().toISOString(),
  })

  /** Loads a session the caller can see (404 otherwise: a vote's existence is as private as its board). */
  async function sessionFor(req: { params: unknown }, userId: string, action: 'view' | 'edit') {
    const { vid = '' } = req.params as Params
    if (!isId('vot', vid)) throw notFound()
    const row = await findSession(db, vid)
    if (!row) throw notFound()
    const access = await requireBoardAction(db, row.board_id, userId, action)
    if (access.board.workspace_id !== row.workspace_id) throw notFound()
    return { row, access }
  }

  // ---- state -----------------------------------------------------------------------------------

  app.get('/api/boards/:bid/workshop', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const at = now()
    const timer = await loadTimer(db, access.board.id)
    const row = await currentSession(db, access.board.id)
    const body: WorkshopState = {
      timer: timer ? timerView(timer, at) : null,
      vote: row ? await voteState(db, row, user.id, at) : null,
      hands: hands.list(access.board.id),
      handsVersion: hands.version(),
      serverNow: at.toISOString(),
    }
    return body
  })

  // ---- timer -----------------------------------------------------------------------------------

  app.post('/api/boards/:bid/timer', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const action = parse(TimerActionInput, req.body)
    const at = now()
    const result = await db.transaction(async (tx) => {
      // The board row lock serializes timer changes per board (the timer row may not exist yet).
      const access = await requireBoardAction(tx, bid, user.id, 'edit', { forUpdate: true })
      await requireFacilitatorAccount(tx, user.id)
      const prev = await loadTimer(tx, access.board.id, true)
      // Someone else's running or paused timer is theirs (R3): the board owner may still act, and so
      // may anyone once its starter can no longer edit the board (they left, or lost access).
      const holder = timerHolder(prev, user.id, at)
      if (
        holder &&
        access.role !== 'owner' &&
        (await allowedNow(tx, access.board.id, [holder], 'edit', at)).has(holder)
      )
        throw new ApiError(403, 'TIMER_NOT_YOURS', TIMER_NOT_YOURS)
      let t: ReturnType<typeof applyTimerAction>
      try {
        t = applyTimerAction(prev, action, at, user.id)
      } catch (e) {
        if (e instanceof TimerRuleError) throw timerRuleToApi(e)
        throw e
      }
      if (t.changed) {
        const s = t.next
        await tx.query(
          `INSERT INTO workshop_timers
             (board_id, workspace_id, status, duration_ms, started_at, ends_at, remaining_ms, started_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (board_id) DO UPDATE SET status = $3, duration_ms = $4, started_at = $5, ends_at = $6,
             remaining_ms = $7, started_by = $8, updated_at = $9`,
          [
            access.board.id,
            access.board.workspace_id,
            s.status,
            s.durationMs,
            s.startedAt,
            s.endsAt,
            s.remainingMs,
            s.startedBy,
            s.updatedAt,
          ],
        )
      }
      return { boardId: access.board.id, ...t }
    })
    const timer = timerView(result.next, at)
    if (result.changed) events.publish(result.boardId, { type: WORKSHOP_EVENTS.timer, data: { timer } })
    return { timer, serverNow: at.toISOString() }
  })

  // ---- votes: setup and facilitation ------------------------------------------------------------

  app.post('/api/boards/:bid/votes', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateVoteInput, req.body)
    // Cheap permission check first, so people who may not start votes never trigger a snapshot.
    const pre = await requireBoardAction(db, bid, user.id, 'edit')
    await requireFacilitatorAccount(db, user.id)
    if (input.scope === 'frame' && input.frameId) {
      const frameId = input.frameId
      const map = await shapes.get(pre.board.id, { maxAgeMs: 0 })
      if (map.get(frameId)?.type !== 'frame') throw badRequest('frameId: no such frame on this board')
    }
    const at = now()
    let row: SessionRow
    try {
      row = await db.transaction(async (tx) => {
        const access = await requireBoardAction(tx, bid, user.id, 'edit', { forUpdate: true })
        // An open vote past its end time is over: record that, so a new one can start.
        await tx.query(
          `UPDATE vote_sessions SET status = 'closed', closed_at = ends_at
            WHERE board_id = $1 AND status = 'open' AND ends_at IS NOT NULL AND ends_at <= $2`,
          [access.board.id, at],
        )
        const open = await tx.maybeOne(
          "SELECT 1 AS ok FROM vote_sessions WHERE board_id = $1 AND status = 'open'",
          [access.board.id],
        )
        if (open)
          throw conflict('VOTE_ALREADY_OPEN', 'A vote is already running on this board. End it first.')
        const durationMs = input.durationMs ?? null
        return tx.one<SessionRow>(
          `INSERT INTO vote_sessions (id, workspace_id, board_id, title, votes_per_person, one_per_object, scope,
             frame_id, shape_types, status, created_by, created_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'open', $10, $11, $12)
           RETURNING ${SESSION_COLUMNS}`,
          [
            newId('vot'),
            access.board.workspace_id,
            access.board.id,
            input.title ?? 'Dot vote',
            input.votesPerPerson,
            input.onePerObject,
            input.scope,
            input.scope === 'frame' ? (input.frameId ?? null) : null,
            input.shapeTypes ? JSON.stringify([...new Set(input.shapeTypes)]) : null,
            user.id,
            at,
            durationMs ? new Date(at.getTime() + durationMs) : null,
          ],
        )
      })
    } catch (e) {
      // Two facilitators started a vote at the same moment: the partial unique index picked one.
      if (isUniqueViolation(e))
        throw conflict('VOTE_ALREADY_OPEN', 'A vote is already running on this board. End it first.')
      throw e
    }
    const state = await voteState(db, row, user.id, at)
    events.publish(row.board_id, {
      type: WORKSHOP_EVENTS.vote,
      data: voteEvent(row, await aggregates(db, row.id), at),
    })
    return reply.code(201).send(state)
  })

  app.get('/api/boards/:bid/votes', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    return { sessions: await summaries(db, access.board.id, now()) }
  })

  app.get('/api/votes/:vid/results', async (req) => {
    const user = await ctx.requireUser(req)
    const { row } = await sessionFor(req, user.id, 'view')
    const at = now()
    if (effectiveStatus(row, at) !== 'revealed')
      throw conflict('NOT_REVEALED', "This vote's results haven't been revealed.")
    const agg = await aggregates(db, row.id)
    const session = {
      ...toVoteSession(row, at),
      totalVotesCast: agg.totalVotesCast,
      participants: agg.participants,
    }
    return { session, results: await revealedResults(db, row.id) }
  })

  /** Close/reveal/extend share this shape: edit on the vote's board, then a locked transition. */
  async function facilitate(
    req: { params: unknown },
    userId: string,
    transition: (tx: Queryable, row: SessionRow, at: Date) => Promise<boolean>,
  ) {
    const { row: found } = await sessionFor(req, userId, 'edit')
    await requireFacilitatorAccount(db, userId)
    const at = now()
    const out = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, found.board_id, userId, 'edit')
      if (access.board.workspace_id !== found.workspace_id) throw notFound()
      const locked = await lockSession(tx, found.id)
      const changed = await transition(tx, locked, at)
      const row = changed ? await lockSession(tx, found.id) : locked
      return { row, changed, agg: await aggregates(tx, found.id) }
    })
    return { ...out, at }
  }

  app.post('/api/votes/:vid/close', async (req) => {
    const user = await ctx.requireUser(req)
    const { row, changed, agg, at } = await facilitate(req, user.id, async (tx, r, t) => {
      if (r.status !== 'open') return false // idempotent: already ended
      const closedAt = effectiveStatus(r, t) === 'closed' ? r.ends_at : t
      await tx.query("UPDATE vote_sessions SET status = 'closed', closed_at = $2 WHERE id = $1", [
        r.id,
        closedAt,
      ])
      return true
    })
    if (changed) events.publish(row.board_id, { type: WORKSHOP_EVENTS.vote, data: voteEvent(row, agg, at) })
    return voteState(db, row, user.id, at)
  })

  app.post('/api/votes/:vid/reveal', async (req) => {
    const user = await ctx.requireUser(req)
    const { row, changed, agg, at } = await facilitate(req, user.id, async (tx, r, t) => {
      if (r.status === 'revealed') return false // idempotent: pressing it twice gives one result
      const closedAt = r.closed_at ?? (effectiveStatus(r, t) === 'closed' ? r.ends_at : t)
      await tx.query(
        "UPDATE vote_sessions SET status = 'revealed', closed_at = $2, revealed_at = $3 WHERE id = $1",
        [r.id, closedAt, t],
      )
      return true
    })
    if (changed) {
      const results = await revealedResults(db, row.id)
      events.publish(row.board_id, { type: WORKSHOP_EVENTS.vote, data: voteEvent(row, agg, at) })
      events.publish(row.board_id, {
        type: WORKSHOP_EVENTS.results,
        data: {
          sessionId: row.id,
          results,
          totalVotesCast: agg.totalVotesCast,
          participants: agg.participants,
        },
      })
    }
    return voteState(db, row, user.id, at)
  })

  app.post('/api/votes/:vid/extend', async (req) => {
    const user = await ctx.requireUser(req)
    const { addMs } = parse(ExtendVoteInput, req.body)
    const { row, changed, agg, at } = await facilitate(req, user.id, async (tx, r, t) => {
      if (r.status !== 'open') throw voteClosed()
      if (!r.ends_at) throw conflict('NO_END_TIME', 'This vote has no end time to extend.')
      const base = Math.max(r.ends_at.getTime(), t.getTime())
      const next = new Date(base + addMs)
      if (next.getTime() - t.getTime() > VOTE_DURATION_MAX_MS)
        throw badRequest('A vote can run for at most 7 days.')
      await tx.query('UPDATE vote_sessions SET ends_at = $2 WHERE id = $1', [r.id, next])
      return true
    })
    if (changed) events.publish(row.board_id, { type: WORKSHOP_EVENTS.vote, data: voteEvent(row, agg, at) })
    return voteState(db, row, user.id, at)
  })

  // ---- votes: taking part ------------------------------------------------------------------------

  app.post('/api/votes/:vid/cast', async (req) => {
    const user = await ctx.requireUser(req)
    const { shapeId, delta } = parse(CastVoteInput, req.body)
    const { row: found, access } = await sessionFor(req, user.id, 'view')
    if (access.board.status !== 'active') throw readOnlyBoard()
    // Eligibility needs the canvas, so it is checked before the lock (and never for removals: you can
    // always take a dot back, even from an object that was deleted meanwhile).
    if (delta === 1 && effectiveStatus(found, now()) === 'open') {
      const rule = { scope: found.scope, frameId: found.frame_id, shapeTypes: found.shape_types }
      const ok = await shapes.check(found.board_id, (map) =>
        isVoteEligible(shapeId, (id) => map.get(id), rule),
      )
      if (!ok) throw notEligible()
    }
    const at = now()
    const { row, agg } = await db.transaction(async (tx) => {
      const locked = await lockSession(tx, found.id)
      await castInLockedSession(tx, locked, user.id, shapeId, delta, at)
      return { row: locked, agg: await aggregates(tx, found.id) }
    })
    events.publish(row.board_id, { type: WORKSHOP_EVENTS.vote, data: voteEvent(row, agg, at) })
    return voteState(db, row, user.id, at)
  })

  app.post('/api/votes/:vid/done', async (req) => {
    const user = await ctx.requireUser(req)
    const done = parse(VoteDoneInput, req.body)?.done ?? true
    const { row: found, access } = await sessionFor(req, user.id, 'view')
    if (access.board.status !== 'active') throw readOnlyBoard()
    const at = now()
    const { row, agg, changed } = await db.transaction(async (tx) => {
      const locked = await lockSession(tx, found.id)
      if (effectiveStatus(locked, at) !== 'open') throw voteClosed()
      const r = done
        ? await tx.query(
            `INSERT INTO vote_done (session_id, workspace_id, user_id, done_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (session_id, user_id) DO NOTHING`,
            [locked.id, locked.workspace_id, user.id, at],
          )
        : await tx.query('DELETE FROM vote_done WHERE session_id = $1 AND user_id = $2', [locked.id, user.id])
      return { row: locked, changed: r.rowCount > 0, agg: await aggregates(tx, found.id) }
    })
    if (changed) events.publish(row.board_id, { type: WORKSHOP_EVENTS.vote, data: voteEvent(row, agg, at) })
    return voteState(db, row, user.id, at)
  })

  // ---- gather everyone -----------------------------------------------------------------------------

  app.post('/api/boards/:bid/summon', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(SummonInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'edit')
    await requireFacilitatorAccount(db, user.id)
    const key = `${access.board.id}/${user.id}`
    const t = now().getTime()
    const last = lastSummon.get(key)
    if (last !== undefined && t - last < summonCooldown && t >= last)
      throw new ApiError(429, 'RATE_LIMITED', 'Everyone was just asked to follow you. Wait a moment.')
    lastSummon.set(key, t)
    if (lastSummon.size > 5_000) lastSummon.delete(lastSummon.keys().next().value as string)
    const data: WorkshopSummonEvent = {
      userId: user.id,
      name: user.name,
      targetUserId: input?.targetUserId ?? null,
    }
    events.publish(access.board.id, { type: WORKSHOP_EVENTS.summon, data })
    return reply.code(202).send({ ok: true })
  })

  // ---- reactions ---------------------------------------------------------------------------------------

  app.post('/api/boards/:bid/reactions', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const { emoji } = parse(ReactionInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'view')
    if (access.board.status !== 'active') throw readOnlyBoard()
    const t = now().getTime()
    const boardId = access.board.id
    // Per person first (a refused person never uses up the board's share), then per board.
    for (const [limit, key] of [
      [reactionLimit, user.id],
      [boardReactionLimit, boardId],
    ] as const) {
      if (limit.take(key, t)) continue
      const wait = Math.ceil(limit.retryAfterMs(key, t) / 1000)
      reply.header('retry-after', String(Math.max(1, wait)))
      throw new ApiError(429, 'RATE_LIMITED', 'That is a lot of reactions. Wait a moment.')
    }
    const data: WorkshopReactionEvent = { userId: user.id, name: user.name, emoji }
    events.publish(boardId, { type: WORKSHOP_EVENTS.reaction, data })
    return reply.code(202).send({ ok: true })
  })

  // ---- raise hand --------------------------------------------------------------------------------------

  app.get('/api/boards/:bid/hands', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    return handsBody(access.board.id)
  })

  // Your own hand. Raising needs an active board; lowering always works.
  app.post('/api/boards/:bid/hand', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const { raised } = parse(HandInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const boardId = access.board.id
    if (!raised) return handsBody(boardId, hands.lower(boardId, user.id, null).hands)
    if (access.board.status !== 'active') throw readOnlyBoard()
    try {
      return handsBody(boardId, hands.raise(boardId, { id: user.id, name: user.name }).hands)
    } catch (e) {
      if (e instanceof HandLimitError) throw conflict('TOO_MANY_HANDS', e.message)
      throw e
    }
  })

  // Someone's hand: facilitators (edit) may lower anyone's; everyone may lower their own.
  app.post('/api/boards/:bid/hands/:uid/lower', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', uid = '' } = req.params as Params
    if (!isUserId(uid)) throw notFound()
    const access = await requireBoardAction(db, bid, user.id, uid === user.id ? 'view' : 'edit')
    if (uid !== user.id) await requireFacilitatorAccount(db, user.id)
    const by = { id: user.id, name: user.name }
    return handsBody(access.board.id, hands.lower(access.board.id, uid, by).hands)
  })

  app.post('/api/boards/:bid/hands/clear', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'edit')
    await requireFacilitatorAccount(db, user.id)
    return handsBody(access.board.id, hands.clear(access.board.id, { id: user.id, name: user.name }).hands)
  })
}
