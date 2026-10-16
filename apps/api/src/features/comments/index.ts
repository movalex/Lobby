// Feature module: comments (docs/FEATURES-M2-CONTRACTS.md, "comments"). Owned by the comments engineer.
//
// Threads anchored to a board point, a shape or a file card; replies; edit/delete own comments (board
// owners may delete any, softly); resolve/reopen; per-person read marks; @mentions that notify only
// people who can view the board; in-app notifications (no email), including a new thread for the
// board's owners (DANA-02, capped per author and per board), and mentions capped per author and board
// (NC-V4); the caps hold under concurrency through a per-board advisory lock (NC-V3). Every route decides access with
// requireBoardAction ('comment' to write, 'view' to read); authorship always comes from the session.
// Board events are published after the transaction commits.
//
// F10 (team-only threads, 0020): a thread's visibility is 'everyone' or 'team'. People outside the
// team (workspace guests, i.e. review-link visitors, and name-only guests) never get a team thread:
// every route answers 404 for it as if it did not exist, the list leaves it out, mentions and
// notifications only reach the team, its board events are delivered to the team's streams only, and
// search leaves its text out for them (search/store.ts). Outside the team, a person can only start
// 'everyone' threads, and resolve or reopen only the threads they started.
//
// Wave J (AUTHZ-TEAM-OUTSIDER): the team is a workspace owner, admin or member who is a CONFIRMED
// creator (store.ts onTeam), so an outside account invited as a workspace member is outside the team,
// and an account whose addresses Lobby cannot confirm fails closed. The same rule decides the bell
// (notifications.ts), the per-audience board events (publishTo) and search (search/index.ts). Every
// thread route and the bell confirm the caller's own addresses like /api/me does (identity.freshen:
// awaited only when unknown or older than a day, else in the background after an hour; no provider
// call inside a transaction), so a person who keeps a board open past a day stays on the team. The
// per-audience events decide on stored status: a staff tab idle for more than a day misses team-only
// events until its next thread request or bell poll confirms it (the board's refetch then shows them).
// Authors carry `external` (the "External" tag).
//
// Wave S (WS3, docs/WAVE-S-CONTRACTS.md §4): time-coded, page and spot comments. A new thread's `asset` anchor must
// name a version servable on the board, of that asset; `page` only on a PDF and inside its page count, `timeMs` only
// on a video and inside its duration (when the probe knows them); an optional `spot` {u, v} only with an asset anchor
// (stored in 0037 spot_u / spot_v, answered as the thread's top-level `spot`). Every refusal is 400 INVALID_ANCHOR. A
// thread keeps its version forever (replacing media never rewrites an anchor).

import {
  COMMENT_BODY_MAX,
  COMMENTS_DELETED_EVENT,
  COMMENTS_HIDDEN_EVENT,
  COMMENTS_THREAD_EVENT,
  type CommentThread,
  type CommentThreadVisibility,
  CreateCommentInput,
  CreateThreadInput,
  clientRevOf,
  EditCommentInput,
  ListNotificationsQuery,
  ListThreadsQuery,
  type ListThreadsResponse,
  LOBBY_CLIENT_HEADER,
  MarkNotificationsReadInput,
  MEDIA_COMMENT_RULES,
  mentionedUserIds,
  rewriteMentionTokens,
  SetThreadVisibilityInput,
} from '@draftroom/contracts'
import { isId, newId, type Queryable } from '@draftroom/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { type BoardAccess, type BoardRow, requireBoardAction } from '../../access.ts'
import type { CreatorLookup } from '../../auth/creator-sql.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, conflict, forbidden, notFound, parse } from '../../errors.ts'
import type { BoardEvent } from '../../events/hub.ts'
import { provideOpenStatePart } from '../board-open/parts.ts'
import type { FeatureContext } from '../context.ts'
import {
  boardOwners,
  insertNotifications,
  latestNotificationSeq,
  listNotifications,
  lockBoardNotifications,
  markNotificationsRead,
  markThreadNotificationsRead,
  type NewNotification,
  threadFollowers,
  withinNotificationCaps,
} from './notifications.ts'
import { createWriteLimiter } from './rate.ts'
import {
  type CommentRow,
  hasOutsideAccess,
  isTeamMember,
  loadCommentRow,
  loadReads,
  loadThread,
  loadThreadRow,
  loadThreads,
  MAX_COMMENTS_PER_THREAD,
  MAX_THREADS_PER_BOARD,
  markRead,
  mediaAnchorProblem,
  type TeamRule,
  type ThreadRow,
  teamAmong,
  viewersAmong,
} from './store.ts'

/** Distinct people one comment may mention (and so notify). */
const MAX_MENTIONS_PER_COMMENT = 50
const WRITES_PER_MINUTE = 120

type BoardRef = Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>

/**
 * Keeps mention tokens only for people who can view the board (with their real name) and turns the
 * rest into plain "@Name" text, so an unauthorized or fake mention neither notifies nor renders as one.
 * F10: in a team-only thread (`team`: the rule of who is on the team), only people on the team can be
 * mentioned.
 */
async function resolveMentions(tx: Queryable, board: BoardRef, body: string, team: TeamRule | null) {
  const requested = mentionedUserIds(body)
  if (requested.length > MAX_MENTIONS_PER_COMMENT)
    throw badRequest(`A comment can mention at most ${MAX_MENTIONS_PER_COMMENT} people.`)
  const viewers = await viewersAmong(tx, board, requested, { team })
  const rewritten = rewriteMentionTokens(body, (userId) => viewers.get(userId) ?? null)
  if (rewritten.length > COMMENT_BODY_MAX) throw badRequest('body: too long')
  return { body: rewritten, mentioned: requested.filter((id) => viewers.has(id)) }
}

async function insertMentions(
  tx: Queryable,
  workspaceId: string,
  commentId: string,
  userIds: readonly string[],
) {
  for (const userId of userIds) {
    await tx.query(
      `INSERT INTO comment_mentions (comment_id, user_id, workspace_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [commentId, userId, workspaceId],
    )
  }
}

/**
 * Who gets notified about a new comment: mentioned people ('mention'), the thread's followers ('reply')
 * and, for a new thread, the board's owners ('new_comment', DANA-02); never the author, only people who
 * can view the board now, one notification each (the most specific kind wins; a mention remembers the
 * kind it replaced, for the mention cap). Callers pass the result through withinNotificationCaps.
 * F10: for a team-only thread (`team`), only people on the team.
 */
async function recipientsFor(
  tx: Queryable,
  board: BoardRef,
  actorId: string,
  mentioned: readonly string[],
  followers: readonly string[],
  opts: { owners?: readonly string[]; team: TeamRule | null },
): Promise<NewNotification[]> {
  const owners = opts.owners ?? []
  const candidates = [...new Set([...mentioned, ...followers, ...owners])].filter((id) => id !== actorId)
  const viewers = await viewersAmong(tx, board, candidates, { team: opts.team })
  const out: NewNotification[] = []
  for (const userId of candidates) {
    if (!viewers.has(userId)) continue
    const plain = followers.includes(userId) ? 'reply' : owners.includes(userId) ? 'new_comment' : null
    if (!mentioned.includes(userId)) out.push({ userId, kind: plain ?? 'new_comment' })
    else out.push(plain ? { userId, kind: 'mention', fallback: plain } : { userId, kind: 'mention' })
  }
  return out
}

/** Whether a comment body asks to mention anyone (before any check: decides whether to take the lock). */
const mayMention = (body: string) => mentionedUserIds(body).length > 0

async function touchThread(tx: Queryable, threadId: string, at: Date) {
  await tx.query('UPDATE comment_threads SET updated_at = $2 WHERE id = $1', [threadId, at])
}

async function mustLoadThread(
  tx: Queryable,
  board: BoardRef,
  threadId: string,
  lookup: CreatorLookup,
): Promise<CommentThread> {
  const thread = await loadThread(tx, board, threadId, lookup)
  if (!thread) throw notFound()
  return thread
}

/**
 * F10: the thread as reloaded at the end of a write, for a caller on the team or not. A thread made
 * team-only by someone else while this request ran (committed after its visibility check) is gone
 * for people outside the team: 404, and the transaction rolls back rather than hand it to them.
 */
async function mustLoadVisibleThread(
  tx: Queryable,
  board: BoardRef,
  threadId: string,
  team: boolean,
  lookup: CreatorLookup,
): Promise<CommentThread> {
  const thread = await mustLoadThread(tx, board, threadId, lookup)
  if (thread.visibility === 'team' && !team) throw notFound()
  return thread
}

export async function registerComments(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, now, events } = ctx
  const lookup = ctx.identity.lookup
  /** Who is on the team now (wave J: a workspace role AND a confirmed creator). */
  const rule = (): TeamRule => ({ lookup, now: now() })
  /** The caller, confirmed first like /api/me (wave J: the team rule then decides on fresh data). */
  const caller = async (req: FastifyRequest) => ctx.identity.freshen(req, await ctx.requireUser(req), 'me')
  const limiter = createWriteLimiter({ max: WRITES_PER_MINUTE, windowMs: 60_000, now })
  const spend = (userId: string) => {
    if (!limiter.take(userId))
      throw new ApiError(429, 'RATE_LIMITED', 'You are commenting too fast. Wait a moment and try again.')
  }

  /**
   * The thread (404 when missing, on a board the caller cannot see, or team-only while the caller is
   * outside the team) plus the caller's access for `action` and whether they are on the team.
   */
  async function threadAccess(
    tx: Queryable,
    threadId: string,
    userId: string,
    action: 'view' | 'comment',
  ): Promise<{ row: ThreadRow; access: BoardAccess; team: boolean }> {
    if (!isId('thr', threadId)) throw notFound()
    const row = await loadThreadRow(tx, threadId)
    if (!row) throw notFound()
    // Team-only threads do not exist for people outside the team: 404 before any 403.
    const team = await isTeamMember(tx, row.workspace_id, userId, rule())
    if (row.visibility === 'team' && !team) throw notFound()
    const access = await requireBoardAction(tx, row.board_id, userId, action)
    if (access.board.workspace_id !== row.workspace_id) throw notFound()
    return { row, access, team }
  }

  /** A live (not deleted) comment, its thread, and the caller's access to comment. */
  async function commentAccess(
    tx: Queryable,
    commentId: string,
    userId: string,
  ): Promise<{ comment: CommentRow; thread: ThreadRow; access: BoardAccess; team: boolean }> {
    if (!isId('cmt', commentId)) throw notFound()
    const comment = await loadCommentRow(tx, commentId)
    if (!comment || comment.deleted_at) throw notFound()
    const thread = await loadThreadRow(tx, comment.thread_id)
    if (!thread) throw notFound()
    const team = await isTeamMember(tx, comment.workspace_id, userId, rule())
    if (thread.visibility === 'team' && !team) throw notFound()
    // 404 first for people who cannot see the board at all; 403 for viewers.
    const access = await requireBoardAction(tx, comment.board_id, userId, 'comment')
    if (access.board.workspace_id !== comment.workspace_id) throw notFound()
    return { comment, thread, access, team }
  }

  /**
   * F10: publishes to the team's streams only ('team') or to everyone else's only ('outside'). Who is
   * on the team is read for the people with a stream open now; anyone who opens one later refetches
   * when it opens. Events are hints: a failed lookup publishes nothing rather than too much.
   */
  async function publishTo(
    board: Pick<BoardRef, 'id' | 'workspace_id'>,
    event: BoardEvent,
    audience: 'team' | 'outside',
  ) {
    const open = events
      .streams()
      .filter((s) => s.boardId === board.id)
      .map((s) => s.userId)
    let team: Set<string>
    try {
      team = await teamAmong(db, board.workspace_id, open, rule())
    } catch {
      return
    }
    events.publish(board.id, event, {
      to: audience === 'team' ? (userId) => team.has(userId) : (userId) => !team.has(userId),
    })
  }

  const publishFor = (
    board: Pick<BoardRef, 'id' | 'workspace_id'>,
    visibility: CommentThreadVisibility,
    event: BoardEvent,
  ) => (visibility === 'team' ? publishTo(board, event, 'team') : events.publish(board.id, event))

  const publishThread = (board: Pick<BoardRef, 'id' | 'workspace_id'>, thread: CommentThread) =>
    publishFor(board, thread.visibility, { type: COMMENTS_THREAD_EVENT, data: { thread } })

  // ---- threads -----------------------------------------------------------------------------------

  /**
   * GET /api/boards/:bid/threads's body for a caller whose access passed 'view', after the caller's 'me' freshen
   * (`userId`: the freshened user). Without `status` (or 'all'): every thread the caller may see, which is also the
   * board-open read's `threads` part (wave M, M5-1: the web asks for ?status=all).
   */
  const loadThreadList = async (
    q: Queryable,
    access: BoardAccess,
    userId: string,
    status?: CommentThread['status'],
  ): Promise<ListThreadsResponse> => {
    const team = await isTeamMember(q, access.board.workspace_id, userId, rule())
    const threads = await loadThreads(q, access.board, { status, team, lookup })
    const reads = await loadReads(
      q,
      userId,
      threads.map((t) => t.id),
    )
    const teamOnlyDefault = team && (await hasOutsideAccess(q, access.board, now(), lookup))
    return { threads, reads, privacy: { teamOnly: team, teamOnlyDefault } }
  }
  provideOpenStatePart(ctx, 'threads', { load: (q, c) => loadThreadList(q, c.access, c.user.id) })

  app.get('/api/boards/:bid/threads', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const query = parse(ListThreadsQuery, req.query)
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const status = query.status === 'all' || !query.status ? undefined : query.status
    // Wave J: the caller's own addresses are confirmed like at /api/me (awaited when unknown or older
    // than a day, else in the background after an hour, after the answer), so the team rule decides
    // on fresh data for people who keep a board open; after the permission check above.
    return ctx.identity.freshenThen(req, user, async (fresh) => loadThreadList(db, access, fresh.id, status))
  })

  app.post('/api/boards/:bid/threads', async (req, reply) => {
    const user = await caller(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateThreadInput, req.body)
    const visibility = input.visibility ?? 'everyone'
    const teamOnly = visibility === 'team'
    const { thread, board: ref } = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'comment')
      if (teamOnly && !(await isTeamMember(tx, access.board.workspace_id, user.id, rule())))
        throw forbidden('Only people on the team can start a team-only comment.')
      spend(user.id)
      const board = access.board
      // NC-V3: before any row lock (the thread insert below locks the board row's key).
      await lockBoardNotifications(tx, board.id)
      // Wave S (WS3): an `asset` anchor names a version servable here, its page or time is inside the file, and a
      // spot (0037 spot_u / spot_v) only goes with one; after the permission check, so nobody probes versions.
      const problem = await mediaAnchorProblem(
        tx,
        board,
        input.anchor,
        input.spot,
        MEDIA_COMMENT_RULES.timeSlackMs,
      )
      if (problem) throw new ApiError(400, MEDIA_COMMENT_RULES.invalidAnchor, problem)
      const count = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM comment_threads WHERE board_id = $1 AND workspace_id = $2',
        [board.id, board.workspace_id],
      )
      if (count.n >= MAX_THREADS_PER_BOARD)
        throw conflict('TOO_MANY_THREADS', 'This board has reached its limit of comment threads.')
      const { body, mentioned } = await resolveMentions(tx, board, input.body, teamOnly ? rule() : null)
      const at = now()
      const threadId = newId('thr')
      const commentId = newId('cmt')
      await tx.query(
        `INSERT INTO comment_threads (id, workspace_id, board_id, anchor, status, created_by, created_at, updated_at, visibility,
                                      spot_u, spot_v)
         VALUES ($1, $2, $3, $4::jsonb, 'open', $5, $6, $6, $7, $8, $9)`,
        [
          threadId,
          board.workspace_id,
          board.id,
          JSON.stringify(input.anchor),
          user.id,
          at,
          visibility,
          input.spot?.u ?? null,
          input.spot?.v ?? null,
        ],
      )
      await tx.query(
        `INSERT INTO comments (id, thread_id, workspace_id, board_id, author_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [commentId, threadId, board.workspace_id, board.id, user.id, body, at],
      )
      await insertMentions(tx, board.workspace_id, commentId, mentioned)
      await markRead(tx, { id: threadId, workspace_id: board.workspace_id }, user.id, at)
      // DANA-02: the board's owners hear about every new thread (a client's first comment included),
      // capped per author and per board so neither a guest nor a crowd of guests can flood their bell.
      const recipients = await recipientsFor(tx, board, user.id, mentioned, [], {
        owners: await boardOwners(tx, board.id),
        team: teamOnly ? rule() : null,
      })
      await insertNotifications(
        tx,
        { workspaceId: board.workspace_id, boardId: board.id, threadId, commentId, actorId: user.id, at },
        await withinNotificationCaps(tx, { boardId: board.id, actorId: user.id, at }, recipients),
      )
      return { thread: await mustLoadThread(tx, board, threadId, lookup), board }
    })
    await publishThread(ref, thread)
    return reply.code(201).send({ thread })
  })

  app.post('/api/threads/:tid/comments', async (req, reply) => {
    const user = await caller(req)
    const { tid = '' } = req.params as Params
    const input = parse(CreateCommentInput, req.body)
    const { thread, board: ref } = await db.transaction(async (tx) => {
      const { row, access, team } = await threadAccess(tx, tid, user.id, 'comment')
      spend(user.id)
      const board = access.board
      // NC-V3/NC-V4: mentions are capped, so before the thread's row lock (lockBoardNotifications).
      if (mayMention(input.body)) await lockBoardNotifications(tx, board.id)
      // Serialize replies to one thread (the per-thread cap and follower set are read below). F10:
      // its visibility is read again under the lock (it may have become team-only meanwhile).
      const locked = await tx.one<{ visibility: 'everyone' | 'team' }>(
        'SELECT visibility FROM comment_threads WHERE id = $1 FOR UPDATE',
        [row.id],
      )
      const teamOnly = locked.visibility === 'team'
      if (teamOnly && !team) throw notFound()
      const count = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM comments WHERE thread_id = $1 AND deleted_at IS NULL',
        [row.id],
      )
      if (count.n === 0) throw notFound() // every comment was deleted: the thread is gone
      if (count.n >= MAX_COMMENTS_PER_THREAD)
        throw conflict('THREAD_FULL', 'This thread has too many replies. Start a new comment instead.')
      const followers = await threadFollowers(tx, row.id)
      const { body, mentioned } = await resolveMentions(tx, board, input.body, teamOnly ? rule() : null)
      const at = now()
      const commentId = newId('cmt')
      await tx.query(
        `INSERT INTO comments (id, thread_id, workspace_id, board_id, author_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [commentId, row.id, board.workspace_id, board.id, user.id, body, at],
      )
      await insertMentions(tx, board.workspace_id, commentId, mentioned)
      // Replying to a resolved thread reopens it, so the new reply is visible on the board.
      await tx.query(
        `UPDATE comment_threads SET updated_at = $2, status = 'open', resolved_by = NULL, resolved_at = NULL
          WHERE id = $1`,
        [row.id, at],
      )
      await markRead(tx, row, user.id, at)
      await insertNotifications(
        tx,
        {
          workspaceId: board.workspace_id,
          boardId: board.id,
          threadId: row.id,
          commentId,
          actorId: user.id,
          at,
        },
        await withinNotificationCaps(
          tx,
          { boardId: board.id, actorId: user.id, at },
          await recipientsFor(tx, board, user.id, mentioned, followers, { team: teamOnly ? rule() : null }),
        ),
      )
      return { thread: await mustLoadThread(tx, board, row.id, lookup), board }
    })
    await publishThread(ref, thread)
    return reply.code(201).send({ thread })
  })

  app.patch('/api/comments/:cid', async (req) => {
    const user = await caller(req)
    const { cid = '' } = req.params as Params
    const input = parse(EditCommentInput, req.body)
    const { thread, board: ref } = await db.transaction(async (tx) => {
      const { comment, thread: row, access, team } = await commentAccess(tx, cid, user.id)
      if (comment.author_id !== user.id) throw forbidden('Only the author can edit a comment.')
      spend(user.id)
      const board = access.board
      const teamOnly = row.visibility === 'team'
      // NC-V3/NC-V4: before the comment's row lock (the UPDATE below).
      if (mayMention(input.body)) await lockBoardNotifications(tx, board.id)
      const { body, mentioned } = await resolveMentions(tx, board, input.body, teamOnly ? rule() : null)
      const at = now()
      const before = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM comment_mentions WHERE comment_id = $1',
        [comment.id],
      )
      const previously = new Set(before.rows.map((r) => r.user_id))
      await tx.query('UPDATE comments SET body = $2, edited_at = $3 WHERE id = $1', [comment.id, body, at])
      await tx.query(
        `DELETE FROM comment_mentions WHERE comment_id = $1
           AND user_id NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`,
        [comment.id, JSON.stringify(mentioned)],
      )
      await insertMentions(tx, board.workspace_id, comment.id, mentioned)
      await touchThread(tx, comment.thread_id, at)
      // Only people newly mentioned by the edit are notified.
      const added = mentioned.filter((id) => !previously.has(id))
      await insertNotifications(
        tx,
        {
          workspaceId: board.workspace_id,
          boardId: board.id,
          threadId: comment.thread_id,
          commentId: comment.id,
          actorId: user.id,
          at,
        },
        await withinNotificationCaps(
          tx,
          { boardId: board.id, actorId: user.id, at },
          await recipientsFor(tx, board, user.id, added, [], { team: teamOnly ? rule() : null }),
        ),
      )
      return { thread: await mustLoadVisibleThread(tx, board, comment.thread_id, team, lookup), board }
    })
    await publishThread(ref, thread)
    return { thread }
  })

  app.delete('/api/comments/:cid', async (req, reply) => {
    const user = await caller(req)
    const { cid = '' } = req.params as Params
    const result = await db.transaction(async (tx) => {
      const { comment, thread, access } = await commentAccess(tx, cid, user.id)
      const moderating = comment.author_id !== user.id
      if (moderating && access.role !== 'owner')
        throw forbidden('Only the author or a board owner can delete a comment.')
      spend(user.id)
      const at = now()
      await tx.query('UPDATE comments SET deleted_at = $2 WHERE id = $1 AND deleted_at IS NULL', [
        comment.id,
        at,
      ])
      await touchThread(tx, comment.thread_id, at)
      if (moderating) {
        // Moderation is audited; the body is not copied into the log.
        await tx.query(
          `INSERT INTO audit_events (workspace_id, actor_id, action, target, detail, at)
           VALUES ($1, $2, 'comment.moderate_delete', $3, $4::jsonb, $5)`,
          [
            comment.workspace_id,
            user.id,
            comment.board_id,
            JSON.stringify({
              commentId: comment.id,
              threadId: comment.thread_id,
              authorId: comment.author_id,
            }),
            at,
          ],
        )
      }
      return {
        board: { id: comment.board_id, workspace_id: comment.workspace_id },
        visibility: thread.visibility,
        threadId: comment.thread_id,
        commentId: comment.id,
      }
    })
    await publishFor(result.board, result.visibility, {
      type: COMMENTS_DELETED_EVENT,
      data: { threadId: result.threadId, commentId: result.commentId },
    })
    return reply.code(204).send()
  })

  for (const action of ['resolve', 'reopen'] as const) {
    app.post(`/api/threads/:tid/${action}`, async (req) => {
      const user = await caller(req)
      const { tid = '' } = req.params as Params
      const {
        thread,
        changed,
        board: ref,
      } = await db.transaction(async (tx) => {
        const { row, access, team } = await threadAccess(tx, tid, user.id, 'comment')
        // F10: outside the team, only the person who started a thread resolves or reopens it.
        if (!team && row.created_by !== user.id)
          throw forbidden('Only the person who started this thread or the team can resolve it.')
        spend(user.id)
        const board = access.board
        const target = action === 'resolve' ? 'resolved' : 'open'
        const at = now()
        // Idempotent: resolving a resolved thread (or reopening an open one) changes nothing.
        const updated =
          target === 'resolved'
            ? await tx.query(
                `UPDATE comment_threads SET status = 'resolved', resolved_by = $2, resolved_at = $3, updated_at = $3
                  WHERE id = $1 AND status = 'open'`,
                [row.id, user.id, at],
              )
            : await tx.query(
                `UPDATE comment_threads SET status = 'open', resolved_by = NULL, resolved_at = NULL, updated_at = $2
                  WHERE id = $1 AND status = 'resolved'`,
                [row.id, at],
              )
        const changed = updated.rowCount > 0
        const thread = await mustLoadVisibleThread(tx, board, row.id, team, lookup)
        if (changed && action === 'resolve') {
          const followers = await threadFollowers(tx, row.id)
          const viewers = await viewersAmong(
            tx,
            board,
            followers.filter((id) => id !== user.id),
            { team: thread.visibility === 'team' ? rule() : null },
          )
          await insertNotifications(
            tx,
            {
              workspaceId: board.workspace_id,
              boardId: board.id,
              threadId: row.id,
              commentId: null,
              actorId: user.id,
              at,
            },
            [...viewers.keys()].map((userId) => ({ userId, kind: 'resolved' as const })),
          )
        }
        return { thread, changed, board }
      })
      if (changed) await publishThread(ref, thread)
      return { thread }
    })
  }

  // F10: a team member makes a thread team-only, or visible to everyone again.
  app.post('/api/threads/:tid/visibility', async (req) => {
    const user = await caller(req)
    const { tid = '' } = req.params as Params
    const input = parse(SetThreadVisibilityInput, req.body)
    const {
      thread,
      changed,
      board: ref,
    } = await db.transaction(async (tx) => {
      const { row, access, team } = await threadAccess(tx, tid, user.id, 'comment')
      if (!team) throw forbidden('Only people on the team can change who sees a comment.')
      spend(user.id)
      const board = access.board
      const updated = await tx.query(
        'UPDATE comment_threads SET visibility = $2, updated_at = $3 WHERE id = $1 AND visibility <> $2',
        [row.id, input.visibility, now()],
      )
      return { thread: await mustLoadThread(tx, board, row.id, lookup), changed: updated.rowCount > 0, board }
    })
    if (changed) {
      await publishThread(ref, thread)
      // People outside the team had this thread: tell them to drop it (they learn nothing new).
      if (thread.visibility === 'team')
        await publishTo(ref, { type: COMMENTS_HIDDEN_EVENT, data: { threadId: thread.id } }, 'outside')
    }
    return { thread }
  })

  app.post('/api/threads/:tid/read', async (req) => {
    const user = await caller(req)
    const { tid = '' } = req.params as Params
    return db.transaction(async (tx) => {
      const { row } = await threadAccess(tx, tid, user.id, 'view')
      const at = now()
      await markRead(tx, row, user.id, at)
      await markThreadNotificationsRead(tx, user.id, row.id, at)
      const r = await tx.one<{ read_at: Date }>(
        'SELECT read_at FROM comment_reads WHERE thread_id = $1 AND user_id = $2',
        [row.id, user.id],
      )
      return { threadId: row.id, readAt: r.read_at.toISOString() }
    })
  })

  // ---- notifications -------------------------------------------------------------------------------

  app.get('/api/me/notifications', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const query = parse(ListNotificationsQuery, req.query)
    // What the caller's web build can parse (0024's access_granted only from LOBBY_CLIENT_REV 1).
    const rev = clientRevOf(req.headers[LOBBY_CLIENT_HEADER])
    // Wave J: the bell leaves team-only threads out for anyone not on the team (a confirmed creator),
    // decided after the caller's own addresses are confirmed like at /api/me (the list from one stored
    // state, then any due background refresh).
    return ctx.identity.freshenThen(req, user, async (fresh) => {
      // Wave M (M5-3, CAP-BELL-POLL): the bell poll says what it holds. Nothing added or removed since (the
      // caller's newest notification is still that one): 204 after this one indexed read, without the creator
      // check or the list's joins. Only the caller's own rows are read: the session decides whose.
      let seq: number | undefined
      if (query.since !== undefined) {
        seq = await latestNotificationSeq(db, fresh.id)
        if (seq === Number(query.since)) return reply.code(204).send()
      }
      const list = await listNotifications(db, fresh.id, {
        unreadOnly: query.unread !== undefined,
        rev,
        creator: await ctx.identity.isCreatorUser(db, fresh.id),
        emailSource: lookup.source,
      })
      return seq === undefined ? list : { ...list, seq }
    })
  })

  app.post('/api/me/notifications/read', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const input = parse(MarkNotificationsReadInput, req.body)
    await markNotificationsRead(db, user.id, input, now())
    return reply.code(204).send()
  })
}
