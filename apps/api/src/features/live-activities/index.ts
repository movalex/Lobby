// OWNER: WS1 (wave V, live activities: polls, scales, word clouds). The routes (@draftroom/contracts
// live-activities.ts; migration 0038_live_sessions; docs/WAVE-V-CONTRACTS.md §2):
//
//   GET  /api/boards/:bid/activity          the current (or last) activity, the caller's own answer      view         V1-1
//   GET  /api/boards/:bid/activities        past activities, aggregates only (the session summary)       view         V1-3
//   POST /api/boards/:bid/activities        start one                                                     facilitate   V1-1
//   POST /api/activities/:aid/answer        answer, or change one's answer                                participate  V1-1
//   POST /api/activities/:aid/close         close                                                         manage       V1-2
//   POST /api/activities/:aid/reveal        reveal (freezes the results; an anonymous one's answers go)   manage       V1-2
//   POST /api/activities/:aid/extend        add time                                                      manage       V1-2
//   POST /api/activities/:aid/cancel        cancel (no results; an anonymous one's answers go)            manage       V1-2
//   POST /api/activities/:aid/hide          hide or show a word of a cloud                                manage       V1-3
//   POST /api/activities/:aid/placed        the facilitator's client placed the results                   manage       V1-3
//   GET  /api/activities/:aid/results       results: revealed (view), or open/closed (manage)            view         V1-2
//   GET  /api/activities/:aid/answers       a NAMED activity's answers after the reveal                  manage       V1-2
//
// Every route is gated by DRAFTROOM_LIVE_ACTIVITIES (../live/switch.ts liveRoute: while off, an unknown route's 404
// for every caller, before the body and the guards), and its open-state part ('activity') is null while off.
//
// Who (server-side; the guard rows in guests/guard.ts refuse a name-only guest the eight facilitate/manage routes
// first, LIVE_FACILITATE_GUESTS_MESSAGE):
//   - view: may view the board (an archived board's readers too);
//   - participate: may view an ACTIVE board (viewers, commenters, clients and name-only guests answer); an archived
//     board takes no answer (409 BOARD_READ_ONLY);
//   - facilitate: may edit AND has an account (workshops/facilitators.ts requireFacilitatorAccount);
//   - manage: may edit, has an account, and is the starter, a board owner, or anyone once the starter left: can no
//     longer edit the board, or has no open event stream on it (`starterLeft`; the stream part is review m6, so a
//     co-facilitator is never stuck behind a starter who closed the tab); else 403 ACTIVITY_NOT_YOURS. The named
//     answers are a read: an archived board's managers may still read them.
// The person is always the session's user; no body names anyone.
//
// Privacy (§2.2): an anonymous activity's answers never leave tied to a person. Bodies and events hold aggregates
// (contracts tallyPoll/tallyScale/tallyWords) plus the CALLER's own answer; the only account id is the starter's
// (`createdBy`). While it is open, every count shown is the one at the last tally window boundary (./tally.ts).
// Whenever an anonymous activity stops taking answers (close, its end time passing, a new start superseding it,
// reveal, cancel, its board archived or trashed) its aggregate is frozen into live_activities.results and its answers
// are deleted in the same transaction (store.ts settleActivity; ./sweep.ts for boards nobody reads; review m2): the
// frozen aggregate is all that stays, and the reveal shows it. Nothing here logs a body or an answer. Events go out
// after COMMIT, the same body for every viewer.

import {
  ACTIVITY_ERROR_CODES,
  ACTIVITY_ID_PATTERN,
  ACTIVITY_LIMITS,
  ACTIVITY_ROUTES,
  type ActivityResults,
  type ActivityResultsResponse,
  type ActivityState,
  type ActivitySummary,
  AnswerActivityInput,
  answerProblem,
  ExtendActivityInput,
  HideWordInput,
  LIVE_ACTIVITY_EVENTS,
  type ListActivitiesResponse,
  type NamedAnswersResponse,
  normalizeWord,
  StartActivityInput,
  type WorkshopActivityEvent,
  type WorkshopActivityResultsEvent,
} from '@draftroom/contracts'
import { isUniqueViolation, newId, type Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type BoardAccess, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, conflict, forbidden, notFound, parse } from '../../errors.ts'
import { rateLimited, SlidingWindowLimiter } from '../../rate-limit.ts'
import { provideOpenStatePart } from '../board-open/parts.ts'
import type { FeatureContext } from '../context.ts'
import { liveRoute, requireLive } from '../live/switch.ts'
import { PENDING_ROUTES, type PendingRoute } from '../pending-routes.ts'
import { requireFacilitatorAccount } from '../workshops/facilitators.ts'
import { allowedNow } from '../workshops/private-notes.ts'
import {
  ACTIVITY_COLUMNS,
  type ActivityRow,
  configOf,
  currentActivity,
  effectiveStatus,
  findActivity,
  frozenOf,
  lockActivity,
  myAnswerOf,
  namedAnswers,
  readSnapshot,
  recentActivities,
  settleActivities,
  settleActivity,
  tallyOf,
  toActivity,
  withHidden,
} from './store.ts'
import { startActivitiesSweeper } from './sweep.ts'
import { ActivityTally, isOpenAt, type Snapshot } from './tally.ts'

export interface LiveActivitiesOptions {
  /** Tests: one tally window for every activity (default activityTallyWindowMs of each). */
  tallyWindowMs?: number
}

// ---- errors ---------------------------------------------------------------------------------------------------

const C = ACTIVITY_ERROR_CODES
const activityOpen = () =>
  conflict(C.activityOpen, 'An activity is already running on this board. End it before starting another.')
const notOpen = () => conflict(C.notOpen, 'This activity has ended.')
const notRevealed = () => conflict(C.notRevealed, 'The results of this activity are not revealed yet.')
const notYours = () =>
  new ApiError(
    403,
    C.notYours,
    'Someone else is running this activity. Only they or a board owner can change it.',
  )
const readOnlyBoard = () => conflict('BOARD_READ_ONLY', 'This board is read-only.')
const MANAGE_FORBIDDEN = 'Only editors of this board can run its activities.'

// ---- who may manage -------------------------------------------------------------------------------------------

interface ManageRight {
  canManage: boolean
  /** the starter can no longer edit the board (told to people who may edit it only) */
  starterLeft: boolean
}

/**
 * May the caller manage `row`? Edit on the board (as its status allows, or as if active for a read: `read`), an
 * account, and the starter, a board owner, or anyone once the starter left: the starter can no longer edit the board,
 * or has no open event stream on it (closed the tab: review m6, so a co-facilitator is never stuck behind them).
 */
async function manageRight(
  q: Queryable,
  access: BoardAccess,
  row: ActivityRow,
  userId: string,
  at: Date,
  onBoard: (boardId: string, userId: string) => boolean,
  opts: { read?: boolean } = {},
): Promise<ManageRight> {
  if (!can(access.role, 'edit', opts.read ? 'active' : access.board.status))
    return { canManage: false, starterLeft: false }
  if (row.created_by === userId) return { canManage: true, starterLeft: false }
  const starter = row.created_by
  const starterLeft =
    !starter ||
    !onBoard(row.board_id, starter) ||
    !(await allowedNow(q, row.board_id, [starter], 'edit', at)).has(starter)
  if ((await userKind(q, userId)) !== 'account') return { canManage: false, starterLeft }
  return { canManage: access.role === 'owner' || starterLeft, starterLeft }
}

// ---- routes ---------------------------------------------------------------------------------------------------

export async function registerLiveActivities(
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
  opts: LiveActivitiesOptions = {},
): Promise<void> {
  // Everything below reads ctx lazily (a request, a timer): registering touches nothing but the config.
  const now = () => ctx.now()
  const starts = new SlidingWindowLimiter(ACTIVITY_LIMITS.startsPerMinute, 60_000)
  const answers = new SlidingWindowLimiter(ACTIVITY_LIMITS.answersPerMinute, 60_000)
  /** a person still has the board open here (an event stream): the starter-left rule (review m6) */
  const onBoard = (boardId: string, userId: string) => ctx.events.hasStream(boardId, userId)

  /** What the board's stream is told of `row` (aggregates; results only when everyone may see them). */
  const eventOf = (row: ActivityRow, snap: Snapshot | null, at: Date): WorkshopActivityEvent => {
    const status = effectiveStatus(row, at)
    const kept = frozenOf(row, at)
    return {
      activity: toActivity(row, at),
      answered: kept ? kept.answered : (snap?.answers.length ?? 0),
      results:
        kept && (status === 'revealed' || row.results_live)
          ? withHidden(kept, row.hidden)
          : row.results_live && snap && status !== 'cancelled'
            ? tallyOf(row, snap.answers, row.hidden)
            : null,
    }
  }
  const publish = (row: ActivityRow, snap: Snapshot | null, at: Date) =>
    ctx.events.publish(row.board_id, { type: LIVE_ACTIVITY_EVENTS.activity, data: eventOf(row, snap, at) })

  const tally = new ActivityTally<ActivityRow>({
    now,
    load: (id) => findActivity(ctx.db, id),
    publish: (row, snap, at) => publish(row, snap, at),
    log: app.log,
    ...(opts.tallyWindowMs !== undefined ? { windowMs: opts.tallyWindowMs } : {}),
  })
  app.addHook('onClose', async () => {
    tally.close()
    await tally.drain()
  })
  // activities that ended by their time on boards nobody reads are settled too (review m2)
  startActivitiesSweeper(app, ctx, (ids) => {
    for (const id of ids) tally.ended(id)
  })

  /** The answers anyone may be shown of `row` at `at` (open: the last boundary's; else the stored ones). */
  const shownOf = (row: ActivityRow, at: Date, q: Queryable = ctx.db) =>
    tally.view(row, at, () => readSnapshot(q, row.id))

  /**
   * `row` as it stands once settled: an open activity past its end time is closed (and an anonymous one's answers
   * frozen and deleted) by the first read that sees it (review m2; the sweep does it too, for boards nobody reads).
   */
  async function settled<T extends ActivityRow | null>(row: T): Promise<T> {
    if (row?.status !== 'open' || isOpenAt(row, now())) return row
    const id = row.id
    await ctx.db.transaction((tx) => settleActivity(tx, id, now()))
    tally.ended(id)
    return ((await findActivity(ctx.db, id)) ?? row) as T
  }

  /** The caller's view of the board's activity (GET …/activity, every mutation's answer, the open-state part). */
  async function stateFor(
    q: Queryable,
    access: BoardAccess,
    userId: string,
    found?: ActivityRow | null,
  ): Promise<ActivityState> {
    const row = await settled(found === undefined ? await currentActivity(q, access.board.id) : found)
    const at = now()
    const empty: ActivityState = {
      activity: null,
      answered: 0,
      myAnswer: null,
      results: null,
      canManage: false,
      starterLeft: false,
      hiddenWords: [],
      serverNow: at.toISOString(),
    }
    if (!row || row.status === 'cancelled') return empty
    const right = await manageRight(q, access, row, userId, at, onBoard)
    const status = effectiveStatus(row, at)
    const kept = frozenOf(row, at)
    let answered = 0
    let results: ActivityResults | null = null
    if (kept) {
      // revealed (everyone), or an anonymous one frozen at its close (its manager, or everyone with live results)
      answered = kept.answered
      if (status === 'revealed' || right.canManage || row.results_live) results = withHidden(kept, row.hidden)
    } else {
      const snap = await shownOf(row, at, q)
      answered = snap.answers.length
      if (right.canManage || row.results_live) results = tallyOf(row, snap.answers, row.hidden)
    }
    return {
      activity: toActivity(row, at),
      answered,
      // after the reveal of an anonymous activity no answer is kept: null
      myAnswer: await myAnswerOf(q, row.id, userId),
      results,
      ...right,
      hiddenWords: right.canManage && row.kind === 'words' ? [...row.hidden] : [],
      serverNow: at.toISOString(),
    }
  }

  provideOpenStatePart(ctx, 'activity', {
    load: async (q, c) => {
      requireLive(ctx, 'activities')
      return stateFor(q, c.access, c.user.id)
    },
    // an open activity's counts (./tally.ts) may read it again on the pool when a window ends
    inTransaction: false,
  })

  /** An activity the caller can see (404 otherwise: its existence is as private as its board), with their access. */
  async function activityFor(
    req: FastifyRequest,
    userId: string,
    action: 'view' | 'edit',
    q: Queryable = ctx.db,
  ) {
    const { aid = '' } = req.params as Params
    if (!ACTIVITY_ID_PATTERN.test(aid)) throw notFound()
    const found = await findActivity(q, aid)
    if (!found) throw notFound()
    const access = await requireBoardAction(q, found.board_id, userId, action)
    if (access.board.workspace_id !== found.workspace_id) throw notFound()
    // ended by its time since anyone looked: settled now (review m2), after the access check
    return { row: await settled(found), access }
  }

  const take = (limiter: SlidingWindowLimiter, key: string, message: string) => {
    const t = now().getTime()
    if (!limiter.take(key, t)) throw rateLimited(limiter.retryAfterMs(key, t), message)
  }

  const route = (
    method: 'GET' | 'POST',
    url: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ) => liveRoute(app, ctx, 'activities', method, url, handler, pending)

  // ---- state, the past list, start ---------------------------------------------------------------------------

  route('GET', ACTIVITY_ROUTES.current, async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(ctx.db, bid, user.id, 'view')
    return stateFor(ctx.db, access, user.id)
  })

  route('GET', ACTIVITY_ROUTES.list, async (req): Promise<ListActivitiesResponse> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(ctx.db, bid, user.id, 'view')
    let rows = await recentActivities(ctx.db, access.board.id, ACTIVITY_LIMITS.pastListMax)
    // one that ended by its time is settled first (review m2): then it is listed with its frozen count
    const ended = rows.find((r) => r.status === 'open' && !isOpenAt(r, now()))
    if (ended) {
      await settled<ActivityRow>(ended)
      rows = await recentActivities(ctx.db, access.board.id, ACTIVITY_LIMITS.pastListMax)
    }
    const at = now()
    const out: ActivitySummary[] = []
    for (const { answers: count, ...row } of rows) {
      const status = effectiveStatus(row, at)
      const kept = frozenOf(row, at)
      out.push({
        activity: toActivity(row, at),
        answered: kept ? kept.answered : status === 'open' ? (await shownOf(row, at)).answers.length : count,
        results: kept && status === 'revealed' ? withHidden(kept, row.hidden) : null,
      })
    }
    return { activities: out }
  })

  route('POST', ACTIVITY_ROUTES.list, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(StartActivityInput, req.body)
    const at = now()
    let row: ActivityRow
    let superseded: string[] = []
    try {
      row = await ctx.db.transaction(async (tx) => {
        // the board row lock serializes starts on one board (step 1 of access.ts's lock order)
        const access = await requireBoardAction(tx, bid, user.id, 'edit', { forUpdate: true })
        // name-only guests take part but never run one (final review R3; the guard refused them already)
        await requireFacilitatorAccount(tx, user.id)
        // an open activity past its end time is over: settle it (closed; an anonymous one's answers frozen and
        // deleted: review m2), so a new one can start
        superseded = await settleActivities(tx, { boardId: access.board.id }, at)
        const open = await tx.maybeOne(
          "SELECT 1 AS ok FROM live_activities WHERE board_id = $1 AND status = 'open'",
          [access.board.id],
        )
        if (open) throw activityOpen()
        take(starts, access.board.id, 'That is a lot of activities. Wait a moment and try again.')
        return tx.one<ActivityRow>(
          `INSERT INTO live_activities (id, workspace_id, board_id, kind, prompt, config, anonymous, results_live,
             status, created_by, created_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'open', $9, $10, $11)
           RETURNING ${ACTIVITY_COLUMNS}`,
          [
            newId('act'),
            access.board.workspace_id,
            access.board.id,
            input.kind,
            input.prompt,
            JSON.stringify(input.config),
            input.anonymous,
            input.resultsLive,
            user.id,
            at,
            input.durationMs ? new Date(at.getTime() + input.durationMs) : null,
          ],
        )
      })
    } catch (e) {
      // two facilitators started one at the same moment: the partial unique index picked one
      if (isUniqueViolation(e)) throw activityOpen()
      throw e
    }
    for (const id of superseded) tally.ended(id)
    tally.started(row)
    publish(row, null, at)
    const access = await requireBoardAction(ctx.db, row.board_id, user.id, 'view')
    return reply.code(201).send(await stateFor(ctx.db, access, user.id, row))
  })

  // ---- answering ----------------------------------------------------------------------------------------------

  route('POST', ACTIVITY_ROUTES.answer, async (req) => {
    const user = await ctx.requireUser(req)
    const { answer } = parse(AnswerActivityInput, req.body)
    const { row: found, access } = await activityFor(req, user.id, 'view')
    if (access.board.status !== 'active') throw readOnlyBoard()
    take(answers, `${found.id}\u0000${user.id}`, 'That is a lot of answers. Wait a moment and try again.')
    if (!isOpenAt(found, now())) throw notOpen()
    const problem = answerProblem(configOf(found), answer)
    if (problem) throw new ApiError(400, C.badAnswer, problem)
    const { row, snap, mark } = await ctx.db.transaction(async (tx) => {
      const locked = await lockActivity(tx, found.id)
      const at = now()
      if (!isOpenAt(locked, at)) throw notOpen()
      await tx.query(
        `INSERT INTO live_answers (workspace_id, activity_id, user_id, answer, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)
         ON CONFLICT (activity_id, user_id) DO UPDATE SET answer = EXCLUDED.answer, updated_at = EXCLUDED.updated_at`,
        [locked.workspace_id, locked.id, user.id, JSON.stringify(answer), at],
      )
      const snap = await readSnapshot(tx, locked.id)
      // taken under the row lock, so the tally knows the commit order
      return { row: locked, snap, mark: tally.mark() }
    })
    tally.changed(row, snap, mark)
    return stateFor(ctx.db, access, user.id, row)
  })

  // ---- managing -----------------------------------------------------------------------------------------------

  /**
   * The manage routes' shape: edit on the activity's board, an account, the manage right, then a transition under
   * the activity's row lock. `transition` answers whether it changed anything.
   */
  async function manage(
    req: FastifyRequest,
    userId: string,
    transition: (tx: Queryable, row: ActivityRow, at: Date) => Promise<boolean>,
  ) {
    const { row: found } = await activityFor(req, userId, 'view')
    const at = now()
    return ctx.db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, found.board_id, userId, 'view')
      if (access.board.workspace_id !== found.workspace_id) throw notFound()
      if (access.board.status !== 'active') throw forbidden('This board is read-only.')
      if (!can(access.role, 'edit', access.board.status)) throw forbidden(MANAGE_FORBIDDEN)
      await requireFacilitatorAccount(tx, userId)
      if (!(await manageRight(tx, access, found, userId, at, onBoard)).canManage) throw notYours()
      const locked = await lockActivity(tx, found.id)
      const changed = await transition(tx, locked, at)
      const row = changed ? await lockActivity(tx, found.id) : locked
      return { row, changed, access, at }
    })
  }

  route('POST', ACTIVITY_ROUTES.close, async (req) => {
    const user = await ctx.requireUser(req)
    const { row, changed, access, at } = await manage(req, user.id, async (tx, r, t) => {
      if (r.status === 'closed') return false // idempotent
      if (r.status !== 'open') throw notOpen()
      // ended by its time already: that was its close
      const closedAt = isOpenAt(r, t) ? t : r.ends_at
      await tx.query("UPDATE live_activities SET status = 'closed', closed_at = $2 WHERE id = $1", [
        r.id,
        closedAt,
      ])
      // anonymous: its aggregate is frozen and its answers go now, not at a reveal that may never come (review m2)
      await settleActivity(tx, r.id, t)
      return true
    })
    // answering has stopped: the final counts are shown as they are
    tally.ended(row.id)
    if (changed) publish(row, await readSnapshot(ctx.db, row.id), at)
    return stateFor(ctx.db, access, user.id, row)
  })

  route('POST', ACTIVITY_ROUTES.reveal, async (req) => {
    const user = await ctx.requireUser(req)
    const { row, changed, access, at } = await manage(req, user.id, async (tx, r, t) => {
      if (r.status === 'revealed') return false // idempotent: pressing it twice gives one result
      if (r.status === 'cancelled') throw notOpen()
      // an anonymous one closed before: the aggregate frozen at its close (its answers are gone)
      const results = r.results ?? tallyOf(r, (await readSnapshot(tx, r.id)).answers, r.hidden)
      const closedAt = r.closed_at ?? (isOpenAt(r, t) ? t : r.ends_at)
      await tx.query(
        `UPDATE live_activities SET status = 'revealed', closed_at = $2, revealed_at = $3, results = $4::jsonb
          WHERE id = $1`,
        [r.id, closedAt, t, JSON.stringify(results)],
      )
      // anonymous: afterwards no row ties a person to an answer (§2.2 rule 4)
      if (r.anonymous) await tx.query('DELETE FROM live_answers WHERE activity_id = $1', [r.id])
      return true
    })
    tally.ended(row.id)
    if (changed && row.results) {
      publish(row, null, at)
      const data: WorkshopActivityResultsEvent = {
        activityId: row.id,
        results: withHidden(row.results, row.hidden),
      }
      ctx.events.publish(row.board_id, { type: LIVE_ACTIVITY_EVENTS.results, data })
    }
    return stateFor(ctx.db, access, user.id, row)
  })

  route('POST', ACTIVITY_ROUTES.extend, async (req) => {
    const user = await ctx.requireUser(req)
    const { addMs } = parse(ExtendActivityInput, req.body)
    const { row, access, at } = await manage(req, user.id, async (tx, r, t) => {
      if (!isOpenAt(r, t)) throw notOpen()
      if (!r.ends_at) throw badRequest('This activity has no end time to extend.')
      const next = new Date(r.ends_at.getTime() + addMs)
      if (next.getTime() - t.getTime() > ACTIVITY_LIMITS.durationMaxMs)
        throw badRequest('An activity can run for at most 2 hours from now.')
      await tx.query('UPDATE live_activities SET ends_at = $2 WHERE id = $1', [r.id, next])
      return true
    })
    // still open: its counts stay those of the last finished window
    publish(row, await shownOf(row, at), at)
    return stateFor(ctx.db, access, user.id, row)
  })

  route('POST', ACTIVITY_ROUTES.cancel, async (req) => {
    const user = await ctx.requireUser(req)
    const { row, changed, access, at } = await manage(req, user.id, async (tx, r, t) => {
      if (r.status === 'cancelled') return false // idempotent
      if (r.status === 'revealed')
        throw conflict(C.notOpen, 'The results of this activity are already revealed.')
      const closedAt = r.closed_at ?? (isOpenAt(r, t) ? t : r.ends_at)
      // no results (a frozen aggregate of a closed anonymous one goes too)
      await tx.query(
        "UPDATE live_activities SET status = 'cancelled', closed_at = $2, results = NULL WHERE id = $1",
        [r.id, closedAt],
      )
      // anonymous: its answers go with it (§2.2 rule 4)
      if (r.anonymous) await tx.query('DELETE FROM live_answers WHERE activity_id = $1', [r.id])
      return true
    })
    tally.ended(row.id)
    if (changed) publish(row, null, at)
    // a cancelled activity is not shown: the board's last closed or revealed one is
    return stateFor(ctx.db, access, user.id)
  })

  route('POST', ACTIVITY_ROUTES.hide, async (req) => {
    const user = await ctx.requireUser(req)
    const input = parse(HideWordInput, req.body)
    const key = normalizeWord(input.word)
    const { row, changed, access, at } = await manage(req, user.id, async (tx, r) => {
      if (r.kind !== 'words') throw badRequest('Only the words of a word cloud can be hidden.')
      if (r.status === 'cancelled') throw notOpen()
      const has = r.hidden.includes(key)
      if (has === input.hidden) return false // idempotent
      const next = input.hidden ? [...r.hidden, key] : r.hidden.filter((w) => w !== key)
      if (next.length > ACTIVITY_LIMITS.hiddenWordsMax)
        throw badRequest(`At most ${ACTIVITY_LIMITS.hiddenWordsMax} words can be hidden.`)
      await tx.query('UPDATE live_activities SET hidden = $2::text[] WHERE id = $1', [r.id, next])
      return true
    })
    if (changed) {
      const status = effectiveStatus(row, at)
      publish(row, status === 'revealed' ? null : await shownOf(row, at), at)
    }
    return stateFor(ctx.db, access, user.id, row)
  })

  route('POST', ACTIVITY_ROUTES.placed, async (req) => {
    const user = await ctx.requireUser(req)
    const { row, changed, access, at } = await manage(req, user.id, async (tx, r, t) => {
      if (r.status !== 'revealed') throw notRevealed()
      if (r.placed_at) return false // idempotent: placed once
      await tx.query('UPDATE live_activities SET placed_at = $2 WHERE id = $1', [r.id, t])
      return true
    })
    if (changed) publish(row, null, at)
    return stateFor(ctx.db, access, user.id, row)
  })

  // ---- reading results ----------------------------------------------------------------------------------------

  route('GET', ACTIVITY_ROUTES.results, async (req): Promise<ActivityResultsResponse> => {
    const user = await ctx.requireUser(req)
    const { row, access } = await activityFor(req, user.id, 'view')
    const at = now()
    const status = effectiveStatus(row, at)
    if (status === 'revealed' && row.results)
      return { activity: toActivity(row, at), results: withHidden(row.results, row.hidden) }
    if (status === 'cancelled') throw notFound()
    // open or closed: a manager's (they see it live, windowed), or everyone's with live results
    if (
      !row.results_live &&
      !(await manageRight(ctx.db, access, row, user.id, at, onBoard, { read: true })).canManage
    )
      throw notFound()
    const kept = frozenOf(row, at)
    if (kept) return { activity: toActivity(row, at), results: withHidden(kept, row.hidden) }
    const snap = await shownOf(row, at)
    return { activity: toActivity(row, at), results: tallyOf(row, snap.answers, row.hidden) }
  })

  route('GET', ACTIVITY_ROUTES.answers, async (req): Promise<NamedAnswersResponse> => {
    const user = await ctx.requireUser(req)
    const { row, access } = await activityFor(req, user.id, 'view')
    // an anonymous activity has nobody to answer with
    if (row.anonymous) throw notFound()
    const at = now()
    // a read: an archived board's managers may still read them
    if (!can(access.role, 'edit', 'active')) throw forbidden(MANAGE_FORBIDDEN)
    await requireFacilitatorAccount(ctx.db, user.id)
    if (!(await manageRight(ctx.db, access, row, user.id, at, onBoard, { read: true })).canManage)
      throw notYours()
    if (effectiveStatus(row, at) !== 'revealed') throw notRevealed()
    return { answers: await namedAnswers(ctx.db, row.id) }
  })
}
