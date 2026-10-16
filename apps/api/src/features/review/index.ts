// OWNER: WS1 (wave S, review status). The review routes (@draftroom/contracts review.ts; migration 0037_client_review;
// docs/WAVE-S-CONTRACTS.md §2):
//
//   GET    /api/boards/:bid/review                           items, rounds, the open round, what the caller may do  S1-1
//   POST   /api/boards/:bid/review/items                     mark an element for review                            S1-1
//   PATCH  /api/boards/:bid/review/items/:rvi                label, position                                       S1-1
//   DELETE /api/boards/:bid/review/items/:rvi                remove from review (soft)                             S1-1
//   POST   /api/boards/:bid/review/items/:rvi/status         set a status (with an optional note thread)           S1-2
//   GET    /api/boards/:bid/review/items/:rvi/events         the history, 50 a page                                S1-2
//   POST   /api/boards/:bid/review/rounds                    start a round (resets, a named checkpoint)            S1-3
//   POST   /api/boards/:bid/review/rounds/:rvr/close         close it                                              S1-3
//
// Who (REVIEW_RULES, decided here on every request, fail closed): `view` can(role, 'view'); `setStatus`
// canSetReviewStatus (anyone who may comment on an ACTIVE board: owners, editors, commenters, workspace guests and a
// name-only guest on a commenter link; a viewer link cannot; nobody on an archived board); `manage` canManageReview
// (edit rights AND users.kind = 'account', read in the write's transaction: a name-only guest on a workshop link never
// manages; the root guest guard refuses those five routes first, guests/guard.ts). A board the caller cannot see is
// 404 before any 403. The actor is always the session's user (every input is strict: an `actor` key is refused), and
// an event keeps its name and kind as they were then (store.ts loadActor).
//
// One status write (§2.4): the board's notification lock first when the note may mention someone (comments' NC-V3
// order), then the item row FOR UPDATE; a `fromSeq` other than the item's status_seq is 409 STATUS_CHANGED with the
// item as it is now; a file item's status is about the newest version servable here (409 NEWER_VERSION otherwise).
// The event, the item, the note thread, the notifications and the chat outbox rows commit together; the board events
// (REVIEW_ITEM_EVENT, the note's thread) go out after COMMIT, the same payload for every viewer.
//
// Also here: the dashboard board lists' `review` counts (one grouped query over the listed boards, added like
// `sharedOutside`), and ./hooks.ts resetForNewVersion (WS2's upload calls it).

import {
  AddReviewItemInput,
  COMMENTS_THREAD_EVENT,
  type CommentThread,
  GetReviewResponse,
  ListReviewEventsQuery,
  PatchReviewItemInput,
  REVIEW_CODES,
  REVIEW_ELEMENT_ID_PATTERN,
  REVIEW_ITEM_EVENT,
  REVIEW_LIMITS,
  REVIEW_ROUND_EVENT,
  type ReviewItem,
  type ReviewRound,
  reviewRoundCheckpointName,
  reviewRoundTitle,
  SetReviewStatusInput,
  StartReviewRoundInput,
} from '@draftroom/contracts'
import { isId, isUniqueViolation, newId, type Queryable } from '@draftroom/db'
import { canManageReview, canSetReviewStatus } from '@draftroom/permissions'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type BoardAccess, type BoardRow, requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, conflict, forbidden, notFound, parse } from '../../errors.ts'
import { lockBoardNotifications } from '../comments/notifications.ts'
import { createWriteLimiter } from '../comments/rate.ts'
import type { FeatureContext } from '../context.ts'
import {
  discardRoundCheckpoint,
  insertRoundCheckpoint,
  type PreparedCheckpoint,
  publishRoundCheckpoint,
  readRoundCheckpoint,
} from './checkpoint.ts'
import { configureReviewHooks, resetItems } from './hooks.ts'
import { createNoteThread, noteAnchor, noteMayMention } from './note.ts'
import {
  applyStatus,
  insertEvent,
  latestServableVersion,
  loadActor,
  loadEvents,
  loadItem,
  loadItemRows,
  loadLiveItems,
  loadRound,
  loadRounds,
  lockBoardForReview,
  lockItem,
  notifyReview,
  type ReviewActorRow,
  reviewRecipients,
  toEvent,
  toItem,
} from './store.ts'

type BoardRef = Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>

/** A 409 whose body carries more than the error (STATUS_CHANGED's item, NEWER_VERSION's latestVersionId). */
class ReviewConflict extends ApiError {
  readonly extra: Record<string, unknown>
  constructor(code: string, message: string, extra: Record<string, unknown>) {
    super(409, code, message)
    this.extra = extra
  }
}

const sendConflict = (reply: FastifyReply, e: ReviewConflict) =>
  reply.code(409).send({ error: { code: e.code, message: e.message }, ...e.extra })

const MANAGE_MESSAGE = 'Only editors with a Lobby account can set up a review.'
const STATUS_MESSAGE = 'You can see this review, but not change it.'

export async function registerReview(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, now, events } = ctx
  const lookup = ctx.identity.lookup
  configureReviewHooks({ lookup, now })
  const statusLimiter = createWriteLimiter({
    max: REVIEW_LIMITS.statusChangesPerMinute,
    windowMs: 60_000,
    now,
  })
  // the manage writes: a generous budget (a panel reorder is one write per item)
  const manageLimiter = createWriteLimiter({ max: 600, windowMs: 60_000, now })

  const publishItem = (boardId: string, item: ReviewItem) =>
    events.publish(boardId, { type: REVIEW_ITEM_EVENT, data: { item } })
  const publishRound = (boardId: string, round: ReviewRound) =>
    events.publish(boardId, { type: REVIEW_ROUND_EVENT, data: { round } })

  /** The caller as the write's actor (its kind from users, in this transaction); 403 when unreadable. */
  async function actorIn(tx: Queryable, userId: string): Promise<ReviewActorRow> {
    const actor = await loadActor(tx, userId, lookup)
    if (!actor) throw forbidden()
    return actor
  }

  /** `manage`: edit rights and an account (fail closed on anything else). */
  async function requireManage(
    tx: Queryable,
    bid: string,
    userId: string,
    opts: { lockBoard?: boolean } = {},
  ) {
    // the board row first when the write is board-wide (store.ts lockBoardForReview: never FOR UPDATE here)
    if (opts.lockBoard) await lockBoardForReview(tx, bid)
    const access = await requireBoardAction(tx, bid, userId, 'edit')
    const actor = await actorIn(tx, userId)
    if (!canManageReview(access.role, actor.kind, access.board.status)) throw forbidden(MANAGE_MESSAGE)
    return { access, actor }
  }

  const spendManage = (userId: string) => {
    if (!manageLimiter.take(userId))
      throw new ApiError(429, 'RATE_LIMITED', 'Too many changes. Wait a moment and try again.', {
        'retry-after': '60',
      })
  }

  const itemIdOf = (req: FastifyRequest) => {
    const { rvi = '' } = req.params as Params
    if (!isId('rvi', rvi)) throw notFound()
    return rvi
  }

  // ---- reads --------------------------------------------------------------------------------------------------

  app.get('/api/boards/:bid/review', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const board = access.board
    const actor = await loadActor(db, user.id, null)
    const [items, rounds] = [await loadLiveItems(db, board), await loadRounds(db, board)]
    const open = rounds.find((r) => r.closedAt === null)
    return GetReviewResponse.parse({
      items,
      rounds,
      openRoundId: open?.id ?? null,
      can: {
        setStatus: canSetReviewStatus(access.role, board.status),
        manage: canManageReview(access.role, actor?.kind ?? null, board.status),
      },
    })
  })

  app.get('/api/boards/:bid/review/items/:rvi/events', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const rvi = itemIdOf(req)
    const query = parse(ListReviewEventsQuery, req.query ?? {})
    const access = await requireBoardAction(db, bid, user.id, 'view')
    // removed items keep their history (the panel's "Removed from review" rows)
    const [row] = await loadItemRows(db, access.board, [rvi])
    if (!row) throw notFound()
    return loadEvents(db, access.board, rvi, query.before === undefined ? null : Number(query.before))
  })

  // ---- items (manage) ---------------------------------------------------------------------------------------------

  app.post('/api/boards/:bid/review/items', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(AddReviewItemInput, req.body)
    if (!REVIEW_ELEMENT_ID_PATTERN.test(input.elementId)) throw badRequest('elementId: invalid')
    let item: ReviewItem
    try {
      item = await db.transaction(async (tx) => {
        // the board row first (access.ts step 1): marks on one board one after the other, so the cap holds
        const { access, actor } = await requireManage(tx, bid, user.id, { lockBoard: true })
        spendManage(user.id)
        const board = access.board
        if (input.kind === 'file') {
          // the asset must have a version this board can show (404 otherwise: no probing of other boards)
          if (!input.assetId || !(await latestServableVersion(tx, board, input.assetId))) throw notFound()
        }
        const live = await tx.one<{ n: number; here: number }>(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE element_id = $3)::int AS here FROM review_items
            WHERE board_id = $1 AND workspace_id = $2 AND removed_at IS NULL`,
          [board.id, board.workspace_id, input.elementId],
        )
        if (live.here > 0) throw conflict(REVIEW_CODES.alreadyInReview, 'This is already in review.')
        if (live.n >= REVIEW_LIMITS.liveItemsPerBoard)
          throw conflict(
            REVIEW_CODES.full,
            `A board can have at most ${REVIEW_LIMITS.liveItemsPerBoard} items in review.`,
          )
        const round = await tx.maybeOne<{ id: string }>(
          'SELECT id FROM review_rounds WHERE board_id = $1 AND workspace_id = $2 AND closed_at IS NULL',
          [board.id, board.workspace_id],
        )
        const id = newId('rvi')
        const at = now()
        await tx.query(
          `INSERT INTO review_items (id, workspace_id, board_id, element_id, kind, asset_id, label, round_id,
                                     created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            board.workspace_id,
            board.id,
            input.elementId,
            input.kind,
            input.kind === 'file' ? input.assetId : null,
            input.label,
            round?.id ?? null,
            user.id,
            at,
          ],
        )
        await insertEvent(tx, { board, itemId: id, roundId: round?.id ?? null, kind: 'added', actor, at })
        const made = await loadItem(tx, board, id)
        if (!made) throw notFound()
        return made
      })
    } catch (e) {
      // a mark that raced another on the same element: the live index decided
      if (isUniqueViolation(e)) throw conflict(REVIEW_CODES.alreadyInReview, 'This is already in review.')
      throw e
    }
    publishItem(item.boardId, item)
    return reply.code(201).send({ item })
  })

  app.patch('/api/boards/:bid/review/items/:rvi', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const rvi = itemIdOf(req)
    const input = parse(PatchReviewItemInput, req.body)
    const item = await db.transaction(async (tx) => {
      const { access } = await requireManage(tx, bid, user.id)
      spendManage(user.id)
      const row = await lockItem(tx, access.board, rvi, { live: true })
      if (!row) throw notFound()
      await tx.query(
        `UPDATE review_items
            SET label = CASE WHEN $2::boolean THEN $3::text ELSE label END,
                position = CASE WHEN $4::boolean THEN $5::integer ELSE position END
          WHERE id = $1`,
        [
          row.id,
          input.label !== undefined,
          input.label ?? null,
          input.position !== undefined,
          input.position ?? null,
        ],
      )
      const updated = await loadItem(tx, access.board, row.id)
      if (!updated) throw notFound()
      return updated
    })
    publishItem(item.boardId, item)
    return { item }
  })

  app.delete('/api/boards/:bid/review/items/:rvi', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const rvi = itemIdOf(req)
    const item = await db.transaction(async (tx) => {
      const { access, actor } = await requireManage(tx, bid, user.id)
      spendManage(user.id)
      const row = await lockItem(tx, access.board, rvi, { live: true })
      if (!row) throw notFound()
      const at = now()
      await tx.query('UPDATE review_items SET removed_at = $2 WHERE id = $1', [row.id, at])
      await insertEvent(tx, {
        board: access.board,
        itemId: row.id,
        roundId: row.round_id,
        kind: 'removed',
        actor,
        at,
      })
      return loadItem(tx, access.board, row.id)
    })
    // every tab drops it (removedAt set)
    if (item) publishItem(item.boardId, item)
    return reply.code(204).send()
  })

  // ---- status (setStatus) -----------------------------------------------------------------------------------------

  app.post('/api/boards/:bid/review/items/:rvi/status', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const rvi = itemIdOf(req)
    const input = parse(SetReviewStatusInput, req.body)
    let result: {
      item: ReviewItem
      event: ReturnType<typeof toEvent>
      thread: CommentThread | null
      board: string
    }
    try {
      result = await db.transaction(async (tx) => {
        // 404 for a board the caller cannot see, 403 for a viewer (and for everyone on an archived board)
        const access: BoardAccess = await requireBoardAction(tx, bid, user.id, 'view')
        const board = access.board
        if (!canSetReviewStatus(access.role, board.status)) throw forbidden(STATUS_MESSAGE)
        const actor = await actorIn(tx, user.id)
        // the comments feature's order (NC-V3): the board's notification lock before any row lock
        if (input.note !== undefined && noteMayMention(input.note)) await lockBoardNotifications(tx, board.id)
        const row = await lockItem(tx, board, rvi, { live: true })
        if (!row) throw notFound()
        if (input.fromSeq !== undefined && Number(row.status_seq) !== input.fromSeq) {
          const current = await loadItem(tx, board, row.id)
          throw new ReviewConflict(REVIEW_CODES.statusChanged, 'Someone changed this status meanwhile.', {
            item: current,
          })
        }
        let versionId: string | null = null
        if (row.kind === 'file') {
          if (!input.versionId)
            throw new ApiError(400, REVIEW_CODES.versionRequired, 'Say which version this status is about.')
          const latest = row.asset_id ? await latestServableVersion(tx, board, row.asset_id) : null
          if (!latest) throw notFound()
          if (latest !== input.versionId)
            throw new ReviewConflict(REVIEW_CODES.newerVersion, 'A newer version of this file is here.', {
              latestVersionId: latest,
            })
          versionId = latest
        } else if (input.versionId !== undefined) throw badRequest('versionId: only for a file item')
        // the budget is spent only by a write that would happen (a refused one costs nothing)
        if (!statusLimiter.take(`${user.id}:${board.id}`))
          throw new ApiError(
            429,
            REVIEW_CODES.rateLimited,
            'You are changing statuses too fast. Wait a moment and try again.',
            { 'retry-after': '60' },
          )
        const at = now()
        const thread =
          input.note !== undefined
            ? await createNoteThread(tx, board, {
                anchor: noteAnchor(row, versionId),
                body: input.note,
                authorId: user.id,
                at,
                lookup,
              })
            : null
        const ev = await insertEvent(tx, {
          board,
          itemId: row.id,
          roundId: row.round_id,
          kind: 'status',
          status: input.status,
          previousStatus: row.status,
          reason: 'set',
          versionId,
          threadId: thread?.id ?? null,
          actor,
          at,
        })
        await applyStatus(tx, row.id, {
          status: input.status,
          by: user.id,
          at,
          versionId: row.kind === 'file' ? versionId : undefined,
        })
        const recipients = await reviewRecipients(tx, board, [row.id], user.id)
        await notifyReview(tx, { board, eventId: ev.id, actorId: user.id, at }, recipients)
        const item = await loadItem(tx, board, row.id)
        if (!item) throw notFound()
        return { item, event: toEvent(ev), thread, board: board.id }
      })
    } catch (e) {
      if (e instanceof ReviewConflict) return sendConflict(reply, e)
      throw e
    }
    publishItem(result.board, result.item)
    if (result.thread)
      events.publish(result.board, { type: COMMENTS_THREAD_EVENT, data: { thread: result.thread } })
    return {
      item: result.item,
      event: result.event,
      ...(result.thread ? { thread: result.thread } : {}),
    }
  })

  // ---- rounds (manage) --------------------------------------------------------------------------------------------

  app.post('/api/boards/:bid/review/rounds', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(StartReviewRoundInput, req.body ?? {})
    // the cheap refusals before the board is read from the sync server
    const first = await requireManage(db, bid, user.id)
    const pre = first.access.board
    const counted = await db.one<{ n: number; open: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE closed_at IS NULL)::int AS open FROM review_rounds
        WHERE board_id = $1 AND workspace_id = $2`,
      [pre.id, pre.workspace_id],
    )
    if (counted.open > 0) throw conflict(REVIEW_CODES.roundOpen, 'A review round is already open.')
    if (counted.n >= REVIEW_LIMITS.roundsPerBoard)
      throw conflict(
        REVIEW_CODES.full,
        `A board keeps at most ${REVIEW_LIMITS.roundsPerBoard} review rounds.`,
      )
    spendManage(user.id)
    const prepared: PreparedCheckpoint | null = await readRoundCheckpoint(ctx, pre)
    let out: { round: ReviewRound; items: ReviewItem[]; changed: Set<string>; checkpointId: string | null }
    try {
      out = await db.transaction(async (tx) => {
        // History's save order: the workspace's checkpoint lock before any row lock, then the board row
        const n = await tx.maybeOne<{ next: number }>(
          'SELECT COALESCE(max(number), 0)::int + 1 AS next FROM review_rounds WHERE board_id = $1',
          [pre.id],
        )
        const number = n?.next ?? 1
        const title = input.title ?? reviewRoundTitle(number)
        const saved = prepared
          ? await insertRoundCheckpoint(ctx, tx, pre, prepared, reviewRoundCheckpointName(title), user.id)
          : false
        const { access, actor } = await requireManage(tx, bid, user.id, { lockBoard: true })
        const board = access.board
        const again = await tx.one<{ n: number; open: number; next: number }>(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
                  COALESCE(max(number), 0)::int + 1 AS next
             FROM review_rounds WHERE board_id = $1 AND workspace_id = $2`,
          [board.id, board.workspace_id],
        )
        if (again.open > 0) throw conflict(REVIEW_CODES.roundOpen, 'A review round is already open.')
        if (again.n >= REVIEW_LIMITS.roundsPerBoard || again.next > REVIEW_LIMITS.roundsPerBoard)
          throw conflict(
            REVIEW_CODES.full,
            `A board keeps at most ${REVIEW_LIMITS.roundsPerBoard} review rounds.`,
          )
        if (again.next !== number) throw conflict(REVIEW_CODES.roundOpen, 'A review round was just started.')
        // the picked items, locked in id order
        const picked = await tx.query<{ id: string; status: string }>(
          `SELECT id, status FROM review_items
            WHERE board_id = $1 AND workspace_id = $2 AND removed_at IS NULL
              AND ($3::jsonb IS NULL OR id IN (SELECT jsonb_array_elements_text($3::jsonb)))
              AND ($3::jsonb IS NOT NULL OR NOT $4::boolean OR status <> 'approved')
            ORDER BY id FOR UPDATE`,
          [
            board.id,
            board.workspace_id,
            input.itemIds ? JSON.stringify([...new Set(input.itemIds)]) : null,
            input.keepApproved,
          ],
        )
        if (input.itemIds && picked.rows.length !== new Set(input.itemIds).size)
          throw badRequest('itemIds: not an item in review on this board')
        const roundId = newId('rvr')
        const at = now()
        await tx.query(
          `INSERT INTO review_rounds (id, workspace_id, board_id, number, title, opened_by, opened_at, checkpoint_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [roundId, board.workspace_id, board.id, number, title, user.id, at, saved ? prepared?.id : null],
        )
        const ids = picked.rows.map((r) => r.id)
        if (ids.length > 0)
          await tx.query(
            'UPDATE review_items SET round_id = $2 WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
            [JSON.stringify(ids), roundId],
          )
        const opened = await insertEvent(tx, {
          board,
          itemId: null,
          roundId,
          kind: 'round_opened',
          itemCount: ids.length,
          actor,
          at,
        })
        // approved items the editor kept approved stay as they are
        const rows = (await loadItemRows(tx, board, ids)).filter(
          (r) => !(input.keepApproved && r.status === 'approved'),
        )
        // ONE notification per recipient for the whole start: about the round, not each reset
        const changed = await resetItems(tx, board, rows, {
          reason: 'new_round',
          actor,
          at,
          roundId,
          notifyEventId: null,
        })
        const recipients = await reviewRecipients(tx, board, ids, user.id)
        await notifyReview(tx, { board, eventId: opened.id, actorId: user.id, at }, recipients)
        const round = await loadRound(tx, board, roundId)
        if (!round) throw notFound()
        const items = (await loadItemRows(tx, board, ids)).map(toItem)
        return {
          round,
          items,
          changed: new Set(changed),
          checkpointId: saved ? (prepared?.id ?? null) : null,
        }
      })
    } catch (e) {
      await discardRoundCheckpoint(ctx, prepared)
      if (isUniqueViolation(e)) throw conflict(REVIEW_CODES.roundOpen, 'A review round is already open.')
      throw e
    }
    if (!out.checkpointId) await discardRoundCheckpoint(ctx, prepared)
    else publishRoundCheckpoint(ctx, pre.id, out.checkpointId)
    publishRound(pre.id, out.round)
    for (const item of out.items) publishItem(pre.id, item)
    return reply.code(201).send({ round: out.round, items: out.items })
  })

  app.post('/api/boards/:bid/review/rounds/:rvr/close', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '', rvr = '' } = req.params as Params
    if (!isId('rvr', rvr)) throw notFound()
    const out = await db.transaction(async (tx) => {
      const { access, actor } = await requireManage(tx, bid, user.id)
      spendManage(user.id)
      const board = access.board
      const row = await tx.maybeOne<{ id: string; closed_at: Date | null }>(
        'SELECT id, closed_at FROM review_rounds WHERE id = $1 AND board_id = $2 AND workspace_id = $3 FOR UPDATE',
        [rvr, board.id, board.workspace_id],
      )
      if (!row) throw notFound()
      if (row.closed_at) throw conflict(REVIEW_CODES.roundClosed, 'This review round is closed.')
      const at = now()
      await tx.query('UPDATE review_rounds SET closed_at = $2 WHERE id = $1', [row.id, at])
      const items = await tx.query<{ id: string }>(
        `SELECT id FROM review_items WHERE board_id = $1 AND workspace_id = $2 AND round_id = $3
          ORDER BY position NULLS LAST, created_at, id`,
        [board.id, board.workspace_id, row.id],
      )
      await insertEvent(tx, {
        board,
        itemId: null,
        roundId: row.id,
        kind: 'round_closed',
        itemCount: items.rows.length,
        actor,
        at,
      })
      const round = await loadRound(tx, board, row.id)
      if (!round) throw notFound()
      return {
        round,
        items: (
          await loadItemRows(
            tx,
            board,
            items.rows.map((r) => r.id),
          )
        ).map(toItem),
      }
    })
    publishRound(out.round.boardId, out.round)
    return out
  })

  // ---- the dashboard's counts ---------------------------------------------------------------------------------------

  registerBoardListCounts(app, db)
}

/** The board lists that carry `review` (M1's list and the dashboard's starred list). */
const LIST_ROUTES: ReadonlySet<string> = new Set([
  '/api/workspaces/:wid/boards',
  '/api/workspaces/:wid/boards/starred',
])

/**
 * `review: {pending, changes, approved}` on every listed board with live items (absent otherwise), from ONE grouped
 * query over the listed ids. The lists hold only boards the caller may see; a trashed board gets none. Added like the
 * `sharedOutside` flag (a root hook bound at ready time); anything unexpected leaves the payload as it is.
 */
function registerBoardListCounts(app: FastifyInstance, db: Queryable) {
  app.addHook('preSerialization', async (req: FastifyRequest, reply, payload) => {
    if (req.method !== 'GET' || reply.statusCode !== 200 || !LIST_ROUTES.has(req.routeOptions.url ?? ''))
      return payload
    const boards = (payload as { boards?: unknown } | null)?.boards
    if (!Array.isArray(boards) || boards.length === 0) return payload
    try {
      const listed = (b: unknown) => b as { id?: unknown; status?: unknown }
      const ids = boards
        .filter((b) => listed(b).status !== 'trashed')
        .map((b) => listed(b).id)
        .filter((id): id is string => typeof id === 'string')
      if (ids.length === 0) return payload
      const rows = await db.query<{ board_id: string; pending: number; changes: number; approved: number }>(
        `SELECT i.board_id,
                count(*) FILTER (WHERE i.status = 'pending')::int AS pending,
                count(*) FILTER (WHERE i.status = 'changes_requested')::int AS changes,
                count(*) FILTER (WHERE i.status = 'approved')::int AS approved
           FROM review_items i
           JOIN boards b ON b.id = i.board_id AND b.workspace_id = i.workspace_id AND b.status IN ('active', 'archived')
          WHERE i.removed_at IS NULL AND i.board_id IN (SELECT jsonb_array_elements_text($1::jsonb))
          GROUP BY i.board_id`,
        [JSON.stringify(ids)],
      )
      const counts = new Map(rows.rows.map((r) => [r.board_id, r]))
      return {
        ...(payload as object),
        boards: boards.map((b) => {
          const c = typeof listed(b).id === 'string' ? counts.get(listed(b).id as string) : undefined
          return c
            ? { ...(b as object), review: { pending: c.pending, changes: c.changes, approved: c.approved } }
            : b
        }),
      }
    } catch (e) {
      req.log.warn({ err: { name: (e as Error)?.name } }, 'review counts not added')
      return payload
    }
  })
}

export type { BoardRef }
