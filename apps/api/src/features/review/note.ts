// OWNER: WS1 (wave S; docs/WAVE-S-CONTRACTS.md §2.4). The note of a status ("Request changes" asks for one): an
// 'everyone' comment thread made in the status write's own transaction, under the comments feature's rules (its
// store and notifications: mentions kept only for people who can view the board, with their real names, else plain
// "@Name" text; ≤ 5,000 characters after the rewrite; the per-board thread cap; mentions capped like any comment's).
// A frame's note sits at its top-right corner (a `shape` anchor at u = 1, v = 0); a file's on the version the status
// is about (an `asset` anchor). The status itself is the bell item for the review's people (review_status), so the
// note notifies only the people it mentions.

import {
  COMMENT_BODY_MAX,
  type CommentAnchor,
  type CommentThread,
  mentionedUserIds,
  rewriteMentionTokens,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import type { BoardRow } from '../../access.ts'
import type { CreatorLookup } from '../../auth/creator-sql.ts'
import { badRequest, conflict } from '../../errors.ts'
import { insertNotifications, withinNotificationCaps } from '../comments/notifications.ts'
import { loadThread, MAX_THREADS_PER_BOARD, markRead, viewersAmong } from '../comments/store.ts'

/** Distinct people one note may mention (the comments feature's limit). */
const MAX_MENTIONS = 50

/** Whether a note asks to mention anyone (the caller then takes the board's notification lock first). */
export const noteMayMention = (body: string) => mentionedUserIds(body).length > 0

/** The anchor of an item's note. */
export function noteAnchor(
  item: { element_id: string; kind: 'frame' | 'file'; asset_id: string | null },
  versionId: string | null,
): CommentAnchor {
  const shapeId = `shape:${item.element_id}`
  if (item.kind === 'file' && item.asset_id && versionId)
    return { kind: 'asset', shapeId, assetId: item.asset_id, versionId }
  return { kind: 'shape', shapeId, u: 1, v: 0 }
}

/** Makes the note's thread (author: the actor) and notifies its mentions. Returns the thread as everyone sees it. */
export async function createNoteThread(
  tx: Queryable,
  board: Pick<BoardRow, 'id' | 'workspace_id' | 'visibility' | 'status'>,
  input: { anchor: CommentAnchor; body: string; authorId: string; at: Date; lookup: CreatorLookup },
): Promise<CommentThread> {
  const count = await tx.one<{ n: number }>(
    'SELECT count(*)::int AS n FROM comment_threads WHERE board_id = $1 AND workspace_id = $2',
    [board.id, board.workspace_id],
  )
  if (count.n >= MAX_THREADS_PER_BOARD)
    throw conflict('TOO_MANY_THREADS', 'This board has reached its limit of comment threads.')
  const requested = mentionedUserIds(input.body)
  if (requested.length > MAX_MENTIONS)
    throw badRequest(`A comment can mention at most ${MAX_MENTIONS} people.`)
  const viewers = await viewersAmong(tx, board, requested, { team: null })
  const body = rewriteMentionTokens(input.body, (userId) => viewers.get(userId) ?? null)
  if (body.length > COMMENT_BODY_MAX) throw badRequest('note: too long')
  const mentioned = requested.filter((id) => viewers.has(id) && id !== input.authorId)
  const threadId = newId('thr')
  const commentId = newId('cmt')
  await tx.query(
    `INSERT INTO comment_threads (id, workspace_id, board_id, anchor, status, created_by, created_at, updated_at, visibility)
     VALUES ($1, $2, $3, $4::jsonb, 'open', $5, $6, $6, 'everyone')`,
    [threadId, board.workspace_id, board.id, JSON.stringify(input.anchor), input.authorId, input.at],
  )
  await tx.query(
    `INSERT INTO comments (id, thread_id, workspace_id, board_id, author_id, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [commentId, threadId, board.workspace_id, board.id, input.authorId, body, input.at],
  )
  for (const userId of requested.filter((id) => viewers.has(id))) {
    await tx.query(
      `INSERT INTO comment_mentions (comment_id, user_id, workspace_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [commentId, userId, board.workspace_id],
    )
  }
  await markRead(tx, { id: threadId, workspace_id: board.workspace_id }, input.authorId, input.at)
  if (mentioned.length > 0) {
    const base = { boardId: board.id, actorId: input.authorId, at: input.at }
    await insertNotifications(
      tx,
      {
        workspaceId: board.workspace_id,
        boardId: board.id,
        threadId,
        commentId,
        actorId: input.authorId,
        at: input.at,
      },
      await withinNotificationCaps(
        tx,
        base,
        mentioned.map((userId) => ({ userId, kind: 'mention' as const })),
      ),
    )
  }
  const thread = await loadThread(tx, board, threadId, input.lookup)
  if (!thread) throw new Error('note thread not readable')
  return thread
}
