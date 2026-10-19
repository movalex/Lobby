// OWNER: WS4 (wave V, breakouts; docs/WAVE-V-CONTRACTS.md §4). The routes (@draftroom/contracts breakouts.ts;
// migration 0038_live_sessions), each behind DRAFTROOM_BREAKOUTS (../live/switch.ts liveRoute: off, every one answers
// as an unknown route):
//
//   GET  /api/boards/:bid/breakouts         the running (or recent) session, members, the caller's group   view
//   POST /api/boards/:bid/breakouts         start (groups from frames; auto, manual or choose)            facilitate
//   POST /api/breakouts/:brk/assign         move people                                                    manage
//   POST /api/breakouts/:brk/shuffle        deal everyone out again                                        manage
//   POST /api/breakouts/:brk/join           choose one's group (choose mode)                               participate
//   POST /api/breakouts/:brk/extend         add time                                                       manage
//   POST /api/breakouts/:brk/broadcast      a line to everyone or to one group (never stored)              manage
//   POST /api/breakouts/:brk/summon         bring one group to the caller                                  manage
//   POST /api/breakouts/:brk/end            end                                                            manage
//
// Rules (contracts live.ts LiveRule; the guard rows in guests/guard.ts refuse name-only guests the seven
// facilitate/manage routes before any of this runs): `view` may view the board; `participate` may view an ACTIVE
// board (409 BOARD_ARCHIVED otherwise); `facilitate` may edit and has an account; `manage` may edit, has an account and
// is the starter or a board owner, or anyone such once the starter left: can no longer edit the board, or has no open
// event stream on it (closed the tab: review m6).
//
// State is in Postgres: a session row (its `rev` grows with every change of it or its members, under its row lock)
// and one member row per person. Every change publishes `workshop.breakout` (the whole state) to everyone on the board
// after COMMIT. A group's broadcast and summon go ONLY to that group's members' streams (hub.publish with `to`), so a
// stream outside the group never receives them: the server half of "follow never leaks across groups". Nothing here
// touches presence, the canvas or the sync server; editing is not fenced to a group's frame.
//
// Who is dealt out (`auto` and Shuffle): everyone with an open event stream on the board who may view it, except the
// facilitators (the starter and the board's owners; the facilitator may still put one in a group by hand). A late
// joiner in `auto` mode is placed in the smallest group at their first GET, under the session's row lock, unless the
// facilitator took them out of every group (kept in this process's memory: a restart forgets it). A session past its
// `endsAt` is ended by the first read or change that sees it (and by a timer in this process), with `endedAt` = its
// end time.

import {
  AssignBreakoutInput,
  BREAKOUT_ERROR_CODES,
  BREAKOUT_EVENTS,
  BREAKOUT_ID_PATTERN,
  BREAKOUT_LIMITS,
  BreakoutBroadcastInput,
  type BreakoutRouteKey,
  type BreakoutState,
  BreakoutSummonInput,
  breakoutGroupId,
  clientRevOf,
  ExtendBreakoutInput,
  JoinBreakoutInput,
  LOBBY_CLIENT_HEADER,
  StartBreakoutsInput,
  type WorkshopBreakoutBroadcastEvent,
  type WorkshopBreakoutEvent,
  type WorkshopBreakoutSummonEvent,
} from '@draftroom/contracts'
import { isUniqueViolation, newId, type Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify'
import { type BoardAccess, loadBoardAccessMany, pairKey, requireBoardAction } from '../../access.ts'
import type { SessionUser } from '../../auth/session.ts'
import type { Params } from '../../context.ts'
import { badRequest, conflict, forbidden, notFound, parse } from '../../errors.ts'
import { rateLimited, SlidingWindowLimiter } from '../../rate-limit.ts'
import { openStatePartsOf, provideOpenStatePart } from '../board-open/parts.ts'
import type { FeatureContext } from '../context.ts'
import { liveRoute, requireLive } from '../live/switch.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'
import { requireFacilitatorAccount } from '../workshops/facilitators.ts'
import { allowedNow } from '../workshops/private-notes.ts'
import { deal, smallestGroup } from './deal.ts'
import {
  bumpSession,
  clearMembers,
  currentSession,
  findSession,
  groupCounts,
  insertSession,
  lockSession,
  type MemberRow,
  membersOf,
  placeMembers,
  removeMembers,
  type SessionRow,
  toMember,
  toSession,
} from './store.ts'

export interface BreakoutOptions {
  /** the shuffle's randomness (tests) */
  rand?: () => number
  /** starts one person may make per minute (default 10: every start makes every open tab refetch) */
  startsPerMinute?: number
}

const E = BREAKOUT_ERROR_CODES
const ended = () => conflict(E.ended, 'These breakouts have ended.')
const archived = () => conflict('BOARD_ARCHIVED', 'This board is archived. Restore it to take part.')
const notYours = () =>
  forbidden('Only the person who started these breakouts or a board owner can change them.')
const noSuchGroup = () => badRequest('There is no such group in these breakouts.')
const noEndTime = () => badRequest('These breakouts have no end time to extend.')

const expired = (row: SessionRow, at: Date) =>
  row.status === 'running' && row.ends_at !== null && row.ends_at.getTime() <= at.getTime()

interface Changed {
  row: SessionRow
  members: MemberRow[]
  changed: boolean
}

export async function registerBreakouts(
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
  opts: BreakoutOptions = {},
): Promise<void> {
  const { db, events } = ctx
  const now = () => ctx.now()
  const rand = opts.rand ?? Math.random
  const starts = new SlidingWindowLimiter(opts.startsPerMinute ?? 10, 60_000)
  const broadcasts = new SlidingWindowLimiter(
    BREAKOUT_LIMITS.broadcastWindow.max,
    BREAKOUT_LIMITS.broadcastWindow.windowMs,
  )
  const summons = new SlidingWindowLimiter(
    BREAKOUT_LIMITS.summonWindow.max,
    BREAKOUT_LIMITS.summonWindow.windowMs,
  )
  /** per running session: people the facilitator took out of every group (never placed again as late joiners) */
  const removed = new Map<string, Set<string>>()
  /** per running session with an end time: the timer that ends it in this process */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  app.addHook('onClose', async () => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  })

  const route = (key: BreakoutRouteKey, handler: RouteHandlerMethod) => {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    return liveRoute(app, ctx, 'breakouts', method, url, handler, pending)
  }

  const take = (limiter: SlidingWindowLimiter, key: string, message: string) => {
    const t = now().getTime()
    if (!limiter.take(key, t)) throw rateLimited(limiter.retryAfterMs(key, t), message)
  }

  // ---- events --------------------------------------------------------------------------------------------------

  /** After COMMIT: the whole state to everyone on the board, and the session's end timer (re)armed. */
  function published(c: Changed): void {
    if (c.changed) {
      const data: WorkshopBreakoutEvent = { session: toSession(c.row), members: c.members.map(toMember) }
      events.publish(c.row.board_id, { type: BREAKOUT_EVENTS.state, data })
    }
    arm(c.row)
  }

  function arm(row: SessionRow): void {
    const old = timers.get(row.id)
    if (old) clearTimeout(old)
    timers.delete(row.id)
    if (row.status !== 'running') {
      removed.delete(row.id)
      return
    }
    if (!row.ends_at) return
    const wait = Math.min(2 ** 31 - 1, Math.max(0, row.ends_at.getTime() - now().getTime()) + 50)
    const t = setTimeout(() => {
      timers.delete(row.id)
      void change(row.id, async () => null).catch((e) =>
        app.log.warn({ err: { message: (e as Error)?.message } }, 'breakouts: ending by time failed'),
      )
    }, wait)
    t.unref?.()
    timers.set(row.id, t)
  }

  /**
   * One change of a session under its row lock, then its event. A session past its end time is ended first (and `fn`
   * does not run); an ended one is left as it is. `fn` returns null for "nothing changed", true for a change of
   * members, or the session columns to change.
   */
  async function change(
    id: string,
    fn: (
      tx: Queryable,
      row: SessionRow,
      at: Date,
    ) => Promise<null | true | { endsAt?: Date | null; end?: Date }>,
  ): Promise<Changed> {
    const at = now()
    const out = await db.transaction(async (tx): Promise<Changed> => {
      let row = await lockSession(tx, id)
      let changed = false
      if (expired(row, at)) {
        row = await bumpSession(tx, id, { end: row.ends_at as Date })
        changed = true
      } else if (row.status === 'running') {
        const r = await fn(tx, row, at)
        if (r) {
          row = await bumpSession(tx, id, r === true ? {} : r)
          changed = true
        }
      }
      return { row, members: await membersOf(tx, id), changed }
    })
    published(out)
    return out
  }

  // ---- who may do what ------------------------------------------------------------------------------------------

  /** `manage` (see the header): only ever true for an account that may edit the board now. */
  async function mayManage(
    access: BoardAccess,
    row: SessionRow,
    user: SessionUser,
    at: Date,
  ): Promise<boolean> {
    if (user.kind !== 'account' || !can(access.role, 'edit', access.board.status)) return false
    if (row.created_by === user.id || access.role === 'owner') return true
    if (row.created_by === null) return true // the starter's account is gone
    // the starter closed every tab of the board: any editor with an account takes over (review m6)
    if (!events.hasStream(row.board_id, row.created_by)) return true
    return !(await allowedNow(db, row.board_id, [row.created_by], 'edit', at)).has(row.created_by)
  }

  /** The session of `:brk` with the caller's access for `action` on its board (404 when they cannot see it). */
  async function sessionFor(req: FastifyRequest, userId: string, action: 'view' | 'edit') {
    const { brk = '' } = req.params as Params
    if (!BREAKOUT_ID_PATTERN.test(brk)) throw notFound()
    const row = await findSession(db, brk)
    if (!row) throw notFound()
    const access = await requireBoardAction(db, row.board_id, userId, action)
    if (access.board.workspace_id !== row.workspace_id) throw notFound()
    return { row, access }
  }

  /** A manage route's session: the caller manages it (403 otherwise). */
  async function managed(req: FastifyRequest, user: SessionUser) {
    const found = await sessionFor(req, user.id, 'edit')
    if (!(await mayManage(found.access, found.row, user, now()))) throw notYours()
    return found
  }

  /**
   * The people `auto` and Shuffle deal out on a board right now: everyone with an open event stream who may view it,
   * except board owners and `exclude` (the starter). Read on the pool, before any transaction.
   */
  async function dealable(boardId: string, exclude: readonly string[]): Promise<string[]> {
    const ids = [
      ...new Set(
        events
          .streams()
          .filter((s) => s.boardId === boardId)
          .map((s) => s.userId),
      ),
    ].filter((u) => !exclude.includes(u))
    if (ids.length === 0) return []
    const access = await loadBoardAccessMany(
      db,
      ids.map((userId) => ({ boardId, userId })),
    )
    return ids.filter((userId) => {
      const a = access.get(pairKey({ boardId, userId }))
      return !!a && can(a.role, 'view', a.board.status) && a.role !== 'owner'
    })
  }

  const hasGroup = (row: SessionRow, groupId: string) => row.groups.some((g) => g.id === groupId)

  function body(
    c: Pick<Changed, 'row' | 'members'> | null,
    userId: string,
    canManage: boolean,
  ): BreakoutState {
    const running = c?.row.status === 'running'
    return {
      session: c ? toSession(c.row) : null,
      members: c ? c.members.map(toMember) : [],
      myGroupId: running ? (c?.members.find((m) => m.user_id === userId)?.group_id ?? null) : null,
      canManage: running && canManage,
      serverNow: now().toISOString(),
    }
  }

  /**
   * GET's body (and the open-state part's): the board's current session, after ending it if its time is up and, in
   * `auto` mode, placing the caller in the smallest group if they are in none (see the header).
   */
  async function stateFor(access: BoardAccess, user: SessionUser): Promise<BreakoutState> {
    const at = now()
    const row = await currentSession(db, access.board.id, at)
    if (!row) return body(null, user.id, false)
    let c: Changed = { row, members: await membersOf(db, row.id), changed: false }
    if (expired(row, at)) c = await change(row.id, async () => null)
    else if (row.status === 'running' && !timers.has(row.id)) arm(row)
    const lateJoiner =
      c.row.status === 'running' &&
      c.row.mode === 'auto' &&
      access.board.status === 'active' &&
      c.row.created_by !== user.id &&
      access.role !== 'owner' &&
      !removed.get(c.row.id)?.has(user.id) &&
      !c.members.some((m) => m.user_id === user.id)
    if (lateJoiner)
      c = await change(c.row.id, async (tx, locked, t) => {
        if (locked.mode !== 'auto' || removed.get(locked.id)?.has(user.id)) return null
        const counts = await groupCounts(tx, locked.id)
        const mine = await tx.maybeOne(
          'SELECT 1 FROM breakout_members WHERE session_id = $1 AND user_id = $2',
          [locked.id, user.id],
        )
        if (mine) return null
        const g = smallestGroup(
          locked.groups.map((x) => x.id),
          counts,
        )
        if (!g) return null
        return (await placeMembers(tx, locked, new Map([[user.id, g]]), 'auto', t)) > 0 ? true : null
      })
    return body(c, user.id, await mayManage(access, c.row, user, at))
  }

  // ---- state ------------------------------------------------------------------------------------------------------

  const gotState = route('GET /api/boards/:bid/breakouts', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    return stateFor(access, user)
  })
  // the board-open read's `breakouts` part: the same body; null while the switch is off (requireLive: a 404). It may
  // write (ending by time, a late joiner), so it runs on the pool, after open-state's read-only transaction.
  if (gotState)
    provideOpenStatePart(ctx, 'breakouts', {
      load: async (_q, c) => {
        requireLive(ctx, 'breakouts')
        return stateFor(c.access, c.user)
      },
      inTransaction: false,
    })

  // ---- start ------------------------------------------------------------------------------------------------------

  /** 409 while a live presentation or a spotlight is on (the features' own in-memory state, read through their parts). */
  async function refuseConflicts(access: BoardAccess, user: SessionUser, req: FastifyRequest): Promise<void> {
    const parts = openStatePartsOf(ctx)
    const caller = { access, user, rev: clientRevOf(req.headers[LOBBY_CLIENT_HEADER]) }
    const presentation = await parts.presentation?.load(db, caller)
    if (presentation?.presentation)
      throw conflict(E.presenting, 'Someone is presenting to everyone. End the presentation first.')
    const workshop = await parts.workshop?.load(db, caller)
    if (workshop?.spotlight) throw conflict(E.spotlight, 'A spotlight is on. End it first.')
  }

  route('POST /api/boards/:bid/breakouts', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(StartBreakoutsInput, req.body)
    const first = await requireBoardAction(db, bid, user.id, 'edit')
    await requireFacilitatorAccount(db, user.id)
    await refuseConflicts(first, user, req)
    take(starts, user.id, 'That is a lot of breakouts. Wait a moment and try again.')
    const people = input.mode === 'auto' ? await dealable(first.board.id, [user.id]) : []
    const groups = input.groups.map((g, i) => ({ id: breakoutGroupId(i), name: g.name, frameId: g.frameId }))
    const at = now()
    const prior: { ended: Changed | null } = { ended: null }
    let out: Changed
    try {
      out = await db.transaction(async (tx): Promise<Changed> => {
        const access = await requireBoardAction(tx, bid, user.id, 'edit', { forUpdate: true })
        const running = await tx.maybeOne<{ id: string }>(
          "SELECT id FROM breakout_sessions WHERE board_id = $1 AND status = 'running'",
          [access.board.id],
        )
        if (running) {
          // one that ran out of time is ended now; a live one keeps the board
          const old = await lockSession(tx, running.id)
          if (!expired(old, at)) throw conflict(E.running, 'Breakouts are already running on this board.')
          const row = await bumpSession(tx, old.id, { end: old.ends_at as Date })
          prior.ended = { row, members: await membersOf(tx, old.id), changed: true }
        }
        const row = await insertSession(tx, {
          id: newId('brk'),
          workspaceId: access.board.workspace_id,
          boardId: access.board.id,
          mode: input.mode,
          groups,
          groupCap: input.groupCap,
          createdBy: user.id,
          createdAt: at,
          endsAt: input.durationMs === null ? null : new Date(at.getTime() + input.durationMs),
        })
        const dealt = deal(
          people,
          groups.map((g) => g.id),
          rand,
        )
        await placeMembers(tx, row, dealt, 'auto', at)
        return { row, members: await membersOf(tx, row.id), changed: true }
      })
    } catch (e) {
      // two facilitators started at the same moment: the partial unique index picked one
      if (isUniqueViolation(e)) throw conflict(E.running, 'Breakouts are already running on this board.')
      throw e
    }
    if (prior.ended) published(prior.ended)
    published(out)
    return reply.code(201).send(body(out, user.id, true))
  })

  // ---- people -----------------------------------------------------------------------------------------------------

  route('POST /api/breakouts/:brk/assign', async (req) => {
    const user = await ctx.requireUser(req)
    const input = parse(AssignBreakoutInput, req.body)
    const { row: found } = await managed(req, user)
    if (found.status !== 'running') throw ended()
    for (const m of input.moves) if (m.groupId !== null && !hasGroup(found, m.groupId)) throw noSuchGroup()
    const placing = input.moves.filter((m) => m.groupId !== null).map((m) => m.userId)
    const present = await allowedNow(db, found.board_id, placing, 'view', now())
    if (placing.some((u) => !present.has(u))) throw badRequest('Someone in the list cannot open this board.')
    const out = await change(found.id, async (tx, row, at) => {
      const moves = new Map(
        input.moves.filter((m) => m.groupId !== null).map((m) => [m.userId, m.groupId as string]),
      )
      const outs = input.moves.filter((m) => m.groupId === null).map((m) => m.userId)
      const n =
        (await placeMembers(tx, row, moves, 'facilitator', at)) + (await removeMembers(tx, row.id, outs))
      return n > 0 ? true : null
    })
    if (out.row.status !== 'running') throw ended()
    const taken = removed.get(out.row.id) ?? new Set<string>()
    for (const m of input.moves) {
      if (m.groupId === null) taken.add(m.userId)
      else taken.delete(m.userId)
    }
    removed.set(out.row.id, taken)
    return body(out, user.id, true)
  })

  route('POST /api/breakouts/:brk/shuffle', async (req) => {
    const user = await ctx.requireUser(req)
    const { row: found } = await managed(req, user)
    if (found.status !== 'running') throw ended()
    const here = await dealable(found.board_id, found.created_by ? [found.created_by] : [])
    const current = (await membersOf(db, found.id)).map((m) => m.user_id)
    const out = await change(found.id, async (tx, row, at) => {
      const taken = removed.get(row.id)
      const everyone = [...new Set([...current, ...here])].filter((u) => !taken?.has(u))
      await clearMembers(tx, row.id)
      await placeMembers(
        tx,
        row,
        deal(
          everyone,
          row.groups.map((g) => g.id),
          rand,
        ),
        'auto',
        at,
      )
      return true
    })
    if (out.row.status !== 'running') throw ended()
    return body(out, user.id, true)
  })

  route('POST /api/breakouts/:brk/join', async (req) => {
    const user = await ctx.requireUser(req)
    const { groupId } = parse(JoinBreakoutInput, req.body)
    const { row: found, access } = await sessionFor(req, user.id, 'view')
    if (access.board.status !== 'active') throw archived()
    if (found.status !== 'running') throw ended()
    if (found.mode !== 'choose')
      throw conflict(E.notChoose, 'The facilitator picks the groups in these breakouts.')
    if (!hasGroup(found, groupId)) throw noSuchGroup()
    const out = await change(found.id, async (tx, row, at) => {
      const mine = await tx.maybeOne<{ group_id: string }>(
        'SELECT group_id FROM breakout_members WHERE session_id = $1 AND user_id = $2',
        [row.id, user.id],
      )
      if (mine?.group_id === groupId) return null
      const counts = await groupCounts(tx, row.id)
      if (row.group_cap !== null && (counts.get(groupId) ?? 0) >= row.group_cap)
        throw conflict(E.groupFull, 'That group is full. Pick another one.')
      return (await placeMembers(tx, row, new Map([[user.id, groupId]]), 'self', at)) > 0 ? true : null
    })
    if (out.row.status !== 'running') throw ended()
    removed.get(out.row.id)?.delete(user.id)
    return body(out, user.id, await mayManage(access, out.row, user, now()))
  })

  // ---- time -------------------------------------------------------------------------------------------------------

  route('POST /api/breakouts/:brk/extend', async (req) => {
    const user = await ctx.requireUser(req)
    const { addMs } = parse(ExtendBreakoutInput, req.body)
    const { row: found } = await managed(req, user)
    if (found.status !== 'running') throw ended()
    // an untimed session stays untimed: "+5 min" would give it an end nobody chose (review m5; as activities)
    if (found.ends_at === null) throw noEndTime()
    const out = await change(found.id, async (_tx, row, at) => {
      if (row.ends_at === null) throw noEndTime()
      const latest = at.getTime() + BREAKOUT_LIMITS.durationMaxMs
      return { endsAt: new Date(Math.min(row.ends_at.getTime() + addMs, latest)) }
    })
    if (out.row.status !== 'running') throw ended()
    return body(out, user.id, true)
  })

  route('POST /api/breakouts/:brk/end', async (req) => {
    const user = await ctx.requireUser(req)
    const { row: found } = await managed(req, user)
    // idempotent: ending an ended session answers its state
    const out =
      found.status === 'running'
        ? await change(found.id, async (_tx, _row, at) => ({ end: at }))
        : { row: found, members: await membersOf(db, found.id), changed: false }
    return body(out, user.id, true)
  })

  // ---- messages and summons (never stored; one group's go to that group's streams only) -----------------------

  /** The running session (ending it first when its time is up: then 409), and one group's members' ids. */
  async function runningFor(found: SessionRow): Promise<SessionRow> {
    if (found.status !== 'running') throw ended()
    if (expired(found, now())) {
      await change(found.id, async () => null)
      throw ended()
    }
    return found
  }
  const groupMemberIds = async (row: SessionRow, groupId: string) =>
    new Set((await membersOf(db, row.id)).filter((m) => m.group_id === groupId).map((m) => m.user_id))

  route('POST /api/breakouts/:brk/broadcast', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const input = parse(BreakoutBroadcastInput, req.body)
    const { row: found } = await managed(req, user)
    const row = await runningFor(found)
    if (input.groupId !== null && !hasGroup(row, input.groupId)) throw noSuchGroup()
    take(broadcasts, row.id, 'A message just went out. Wait a moment.')
    const data: WorkshopBreakoutBroadcastEvent = {
      sessionId: row.id,
      text: input.text,
      from: { userId: user.id, name: user.name },
      groupId: input.groupId,
      at: now().toISOString(),
    }
    const event = { type: BREAKOUT_EVENTS.broadcast, data }
    if (input.groupId === null) events.publish(row.board_id, event)
    else {
      const to = await groupMemberIds(row, input.groupId)
      events.publish(row.board_id, event, { to: (uid) => to.has(uid) })
    }
    return reply.code(204).send()
  })

  route('POST /api/breakouts/:brk/summon', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const input = parse(BreakoutSummonInput, req.body)
    const { row: found } = await managed(req, user)
    const row = await runningFor(found)
    if (!hasGroup(row, input.groupId)) throw noSuchGroup()
    take(summons, row.id, 'A group was just asked to follow you. Wait a moment.')
    const data: WorkshopBreakoutSummonEvent = {
      sessionId: row.id,
      userId: user.id,
      name: user.name,
      groupId: input.groupId,
      // the summoner's canvas size as their client reports it: it only shapes followers' cameras (R2-04)
      ...(input.screen ? { screen: { w: input.screen.w, h: input.screen.h } } : {}),
    }
    const to = await groupMemberIds(row, input.groupId)
    events.publish(row.board_id, { type: BREAKOUT_EVENTS.summon, data }, { to: (uid) => to.has(uid) })
    return reply.code(204).send()
  })
}
