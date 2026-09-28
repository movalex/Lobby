// Feature module: comments (docs/FEATURES-M2-CONTRACTS.md, "comments"). Owned by the comments engineer.
//
// Threads anchored to a board point, a shape or a file card; replies; edit/delete own comments (board
// owners may delete any, softly); resolve/reopen; per-person read marks; @mentions that notify only
// people who can view the board; in-app notifications (no email), including a new thread for the
// board's owners (DANA-02, capped per author and per board). Every route decides access with
// requireBoardAction ('comment' to write, 'view' to read); authorship always comes from the session.
// Board events are published after the transaction commits.

import {
  COMMENT_BODY_MAX,
  COMMENTS_DELETED_EVENT,
  COMMENTS_THREAD_EVENT,
  type CommentThread,
  CreateCommentInput,
  CreateThreadInput,
  EditCommentInput,
  ListNotificationsQuery,
  ListThreadsQuery,
  MarkNotificationsReadInput,
  mentionedUserIds,
  rewriteMentionTokens,
} from '@draftroom/contracts'
import { isId, newId, type Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { type BoardAccess, type BoardRow, requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, badRequest, conflict, forbidden, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import {
  boardOwners,
  insertNotifications,
  listNotifications,
  markNotificationsRead,
  markThreadNotificationsRead,
  type NewNotification,
  threadFollowers,
  withinNewCommentCap,
} from './notifications.ts'
import { createWriteLimiter } from './rate.ts'
import {
  type CommentRow,
  loadCommentRow,
  loadReads,
  loadThread,
  loadThreadRow,
  loadThreads,
  MAX_COMMENTS_PER_THREAD,
  MAX_THREADS_PER_BOARD,
  markRead,
  type ThreadRow,
  viewersAmong,
} from './store.ts'

/** Distinct people one comment may mention (and so notify). */
const MAX_MENTIONS_PER_COMMENT = 50
const WRITES_PER_MINUTE = 120

type BoardRef = Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>

/**
 * Keeps mention tokens only for people who can view the board (with their real name) and turns the
 * rest into plain "@Name" text, so an unauthorized or fake mention neither notifies nor renders as one.
 */
async function resolveMentions(tx: Queryable, board: BoardRef, body: string) {
  const requested = mentionedUserIds(body)
  if (requested.length > MAX_MENTIONS_PER_COMMENT)
    throw badRequest(`A comment can mention at most ${MAX_MENTIONS_PER_COMMENT} people.`)
  const viewers = await viewersAmong(tx, board, requested)
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
 * can view the board now, one notification each (the most specific kind wins).
 */
async function recipientsFor(
  tx: Queryable,
  board: BoardRef,
  actorId: string,
  mentioned: readonly string[],
  followers: readonly string[],
  owners: readonly string[] = [],
): Promise<NewNotification[]> {
  const candidates = [...new Set([...mentioned, ...followers, ...owners])].filter((id) => id !== actorId)
  const viewers = await viewersAmong(tx, board, candidates)
  const out: NewNotification[] = []
  for (const userId of candidates) {
    if (!viewers.has(userId)) continue
    const kind = mentioned.includes(userId) ? 'mention' : followers.includes(userId) ? 'reply' : 'new_comment'
    out.push({ userId, kind })
  }
  return out
}

async function touchThread(tx: Queryable, threadId: string, at: Date) {
  await tx.query('UPDATE comment_threads SET updated_at = $2 WHERE id = $1', [threadId, at])
}

async function mustLoadThread(tx: Queryable, board: BoardRef, threadId: string): Promise<CommentThread> {
  const thread = await loadThread(tx, board, threadId)
  if (!thread) throw notFound()
  return thread
}

export async function registerComments(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, now, events } = ctx
  const limiter = createWriteLimiter({ max: WRITES_PER_MINUTE, windowMs: 60_000, now })
  const spend = (userId: string) => {
    if (!limiter.take(userId))
      throw new ApiError(429, 'RATE_LIMITED', 'You are commenting too fast. Wait a moment and try again.')
  }

  /** The thread (404 when missing or on a board the caller cannot see) plus the caller's access for `action`. */
  async function threadAccess(
    tx: Queryable,
    threadId: string,
    userId: string,
    action: 'view' | 'comment',
  ): Promise<{ row: ThreadRow; access: BoardAccess }> {
    if (!isId('thr', threadId)) throw notFound()
    const row = await loadThreadRow(tx, threadId)
    if (!row) throw notFound()
    const access = await requireBoardAction(tx, row.board_id, userId, action)
    if (access.board.workspace_id !== row.workspace_id) throw notFound()
    return { row, access }
  }

  /** A live (not deleted) comment and the caller's access for `action`. */
  async function commentAccess(
    tx: Queryable,
    commentId: string,
    userId: string,
  ): Promise<{ comment: CommentRow; access: BoardAccess }> {
    if (!isId('cmt', commentId)) throw notFound()
    const comment = await loadCommentRow(tx, commentId)
    if (!comment || comment.deleted_at) throw notFound()
    // 404 first for people who cannot see the board at all; 403 for viewers.
    const access = await requireBoardAction(tx, comment.board_id, userId, 'comment')
    if (access.board.workspace_id !== comment.workspace_id) throw notFound()
    return { comment, access }
  }

  const publishThread = (thread: CommentThread) =>
    events.publish(thread.boardId, { type: COMMENTS_THREAD_EVENT, data: { thread } })

  // ---- threads -----------------------------------------------------------------------------------

  app.get('/api/boards/:bid/threads', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const query = parse(ListThreadsQuery, req.query)
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const status = query.status === 'all' || !query.status ? undefined : query.status
    const threads = await loadThreads(db, access.board, { status })
    const reads = await loadReads(
      db,
      user.id,
      threads.map((t) => t.id),
    )
    return { threads, reads }
  })

  app.post('/api/boards/:bid/threads', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(CreateThreadInput, req.body)
    const thread = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'comment')
      spend(user.id)
      const board = access.board
      const count = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM comment_threads WHERE board_id = $1 AND workspace_id = $2',
        [board.id, board.workspace_id],
      )
      if (count.n >= MAX_THREADS_PER_BOARD)
        throw conflict('TOO_MANY_THREADS', 'This board has reached its limit of comment threads.')
      const { body, mentioned } = await resolveMentions(tx, board, input.body)
      const at = now()
      const threadId = newId('thr')
      const commentId = newId('cmt')
      await tx.query(
        `INSERT INTO comment_threads (id, workspace_id, board_id, anchor, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, 'open', $5, $6, $6)`,
        [threadId, board.workspace_id, board.id, JSON.stringify(input.anchor), user.id, at],
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
      const recipients = await recipientsFor(
        tx,
        board,
        user.id,
        mentioned,
        [],
        await boardOwners(tx, board.id),
      )
      await insertNotifications(
        tx,
        { workspaceId: board.workspace_id, boardId: board.id, threadId, commentId, actorId: user.id, at },
        await withinNewCommentCap(tx, { boardId: board.id, actorId: user.id, at }, recipients),
      )
      return mustLoadThread(tx, board, threadId)
    })
    publishThread(thread)
    return reply.code(201).send({ thread })
  })

  app.post('/api/threads/:tid/comments', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { tid = '' } = req.params as Params
    const input = parse(CreateCommentInput, req.body)
    const thread = await db.transaction(async (tx) => {
      const { row, access } = await threadAccess(tx, tid, user.id, 'comment')
      spend(user.id)
      const board = access.board
      // Serialize replies to one thread (the per-thread cap and follower set are read below).
      await tx.query('SELECT id FROM comment_threads WHERE id = $1 FOR UPDATE', [row.id])
      const count = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM comments WHERE thread_id = $1 AND deleted_at IS NULL',
        [row.id],
      )
      if (count.n === 0) throw notFound() // every comment was deleted: the thread is gone
      if (count.n >= MAX_COMMENTS_PER_THREAD)
        throw conflict('THREAD_FULL', 'This thread has too many replies. Start a new comment instead.')
      const followers = await threadFollowers(tx, row.id)
      const { body, mentioned } = await resolveMentions(tx, board, input.body)
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
        await recipientsFor(tx, board, user.id, mentioned, followers),
      )
      return mustLoadThread(tx, board, row.id)
    })
    publishThread(thread)
    return reply.code(201).send({ thread })
  })

  app.patch('/api/comments/:cid', async (req) => {
    const user = await ctx.requireUser(req)
    const { cid = '' } = req.params as Params
    const input = parse(EditCommentInput, req.body)
    const thread = await db.transaction(async (tx) => {
      const { comment, access } = await commentAccess(tx, cid, user.id)
      if (comment.author_id !== user.id) throw forbidden('Only the author can edit a comment.')
      spend(user.id)
      const board = access.board
      const { body, mentioned } = await resolveMentions(tx, board, input.body)
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
        await recipientsFor(tx, board, user.id, added, []),
      )
      return mustLoadThread(tx, board, comment.thread_id)
    })
    publishThread(thread)
    return { thread }
  })

  app.delete('/api/comments/:cid', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { cid = '' } = req.params as Params
    const result = await db.transaction(async (tx) => {
      const { comment, access } = await commentAccess(tx, cid, user.id)
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
      return { boardId: comment.board_id, threadId: comment.thread_id, commentId: comment.id }
    })
    events.publish(result.boardId, {
      type: COMMENTS_DELETED_EVENT,
      data: { threadId: result.threadId, commentId: result.commentId },
    })
    return reply.code(204).send()
  })

  for (const action of ['resolve', 'reopen'] as const) {
    app.post(`/api/threads/:tid/${action}`, async (req) => {
      const user = await ctx.requireUser(req)
      const { tid = '' } = req.params as Params
      const { thread, changed } = await db.transaction(async (tx) => {
        const { row, access } = await threadAccess(tx, tid, user.id, 'comment')
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
        const thread = await mustLoadThread(tx, board, row.id)
        if (changed && action === 'resolve') {
          const followers = await threadFollowers(tx, row.id)
          const viewers = await viewersAmong(
            tx,
            board,
            followers.filter((id) => id !== user.id),
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
        return { thread, changed }
      })
      if (changed) publishThread(thread)
      return { thread }
    })
  }

  app.post('/api/threads/:tid/read', async (req) => {
    const user = await ctx.requireUser(req)
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

  app.get('/api/me/notifications', async (req) => {
    const user = await ctx.requireUser(req)
    const query = parse(ListNotificationsQuery, req.query)
    return listNotifications(db, user.id, { unreadOnly: query.unread !== undefined })
  })

  app.post('/api/me/notifications/read', async (req, reply) => {
    const user = await ctx.requireUser(req)
    const input = parse(MarkNotificationsReadInput, req.body)
    await markNotificationsRead(db, user.id, input, now())
    return reply.code(204).send()
  })
}
