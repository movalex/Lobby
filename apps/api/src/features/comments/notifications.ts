// In-app notifications (mentions, replies, resolutions; other features insert access requests into the
// same table). No email is sent. Listing re-checks board access for every row, so a person who lost
// access to a board stops seeing that board's notifications (and their comment snippets) immediately.

import { commentPlainText, type NotificationItem, type NotificationKind } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  type BoardRole,
  type BoardStatus,
  type BoardVisibility,
  can,
  resolveBoardRole,
  type WorkspaceRole,
} from '@draftroom/permissions'
import { idList } from './store.ts'

export const MAX_NOTIFICATIONS_LISTED = 100
const MAX_UNREAD_COUNTED = 1_000
const SNIPPET_MAX = 140

export interface NewNotification {
  userId: string
  kind: Exclude<NotificationKind, 'access_request'>
}

/** Inserts one notification per recipient (the caller already excluded the actor and non-viewers). */
export async function insertNotifications(
  q: Queryable,
  base: {
    workspaceId: string
    boardId: string
    threadId: string
    commentId: string | null
    actorId: string
    at: Date
  },
  recipients: readonly NewNotification[],
): Promise<void> {
  for (const r of recipients) {
    await q.query(
      `INSERT INTO notifications (workspace_id, user_id, kind, board_id, thread_id, comment_id, actor_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        base.workspaceId,
        r.userId,
        r.kind,
        base.boardId,
        base.threadId,
        base.commentId,
        base.actorId,
        base.at,
      ],
    )
  }
}

interface NotificationRow {
  id: string
  kind: NotificationKind
  board_id: string
  thread_id: string | null
  comment_id: string | null
  created_at: Date
  read_at: Date | null
  board_title: string
  visibility: BoardVisibility
  status: BoardStatus
  workspace_role: WorkspaceRole | null
  board_grant: BoardRole | null
  actor_id: string | null
  actor_name: string | null
  actor_color: string | null
  comment_body: string | null
  comment_deleted_at: Date | null
  request_role: 'editor' | 'commenter' | 'viewer' | null
  request_message: string | null
  request_status: 'pending' | 'approved' | 'denied' | null
}

const SELECT = `SELECT n.id, n.kind, n.board_id, n.thread_id, n.comment_id, n.created_at, n.read_at,
       b.title AS board_title, b.visibility, b.status,
       wm.role AS workspace_role, bm.role AS board_grant,
       a.id AS actor_id, a.name AS actor_name, a.color AS actor_color,
       c.body AS comment_body, c.deleted_at AS comment_deleted_at,
       ar.role_requested AS request_role, ar.message AS request_message, ar.status AS request_status
  FROM notifications n
  JOIN boards b ON b.id = n.board_id AND b.workspace_id = n.workspace_id
  LEFT JOIN workspace_members wm ON wm.workspace_id = n.workspace_id AND wm.user_id = n.user_id
  LEFT JOIN board_members bm ON bm.board_id = n.board_id AND bm.user_id = n.user_id
  LEFT JOIN users a ON a.id = n.actor_id
  LEFT JOIN comments c ON c.id = n.comment_id
  LEFT JOIN LATERAL (
    SELECT r.role_requested, r.message, r.status FROM access_requests r
     WHERE n.kind = 'access_request' AND r.workspace_id = n.workspace_id AND r.board_id = n.board_id
       AND r.user_id = n.actor_id AND r.created_at <= n.created_at + interval '1 second'
     ORDER BY r.created_at DESC LIMIT 1
  ) ar ON true`

/** Whether the recipient may still see this notification: board access now, comment not deleted. */
function visible(r: NotificationRow): boolean {
  const role = resolveBoardRole({
    workspaceRole: r.workspace_role,
    boardGrant: r.board_grant,
    visibility: r.visibility,
  })
  if (r.comment_id && (r.comment_body === null || r.comment_deleted_at)) return false
  // Access requests are for people who can act on them.
  if (r.kind === 'access_request') return can(role, 'manage_access', r.status)
  return can(role, 'view', r.status)
}

function snippetOf(body: string | null): string | null {
  if (body === null) return null
  const text = commentPlainText(body).replace(/\s+/g, ' ').trim()
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text
}

function toItem(r: NotificationRow): NotificationItem {
  return {
    id: r.id,
    kind: r.kind,
    boardId: r.board_id,
    boardTitle: r.board_title,
    threadId: r.thread_id,
    commentId: r.comment_id,
    actor:
      r.actor_id && r.actor_name !== null
        ? { id: r.actor_id, name: r.actor_name, color: r.actor_color ?? '#888888' }
        : null,
    snippet: snippetOf(r.comment_body),
    accessRequest:
      r.kind === 'access_request' && r.request_role && r.request_status
        ? { role: r.request_role, message: r.request_message, status: r.request_status }
        : null,
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at ? r.read_at.toISOString() : null,
  }
}

export async function listNotifications(
  q: Queryable,
  userId: string,
  opts: { unreadOnly?: boolean } = {},
): Promise<{ notifications: NotificationItem[]; unreadCount: number }> {
  const rows = await q.query<NotificationRow>(
    `${SELECT}
      WHERE n.user_id = $1 AND ($2::boolean = false OR n.read_at IS NULL)
      ORDER BY n.seq DESC
      LIMIT ${MAX_NOTIFICATIONS_LISTED * 3}`,
    [userId, opts.unreadOnly === true],
  )
  const notifications = rows.rows.filter(visible).slice(0, MAX_NOTIFICATIONS_LISTED).map(toItem)
  const unread = await q.query<NotificationRow>(
    `${SELECT}
      WHERE n.user_id = $1 AND n.read_at IS NULL
      ORDER BY n.seq DESC
      LIMIT ${MAX_UNREAD_COUNTED}`,
    [userId],
  )
  return { notifications, unreadCount: unread.rows.filter(visible).length }
}

/** Marks the caller's own notifications read; ids of other people's notifications are ignored. */
export async function markNotificationsRead(
  q: Queryable,
  userId: string,
  sel: { ids?: readonly string[]; all?: boolean },
  at: Date,
): Promise<number> {
  const r = await q.query(
    `UPDATE notifications SET read_at = $2
      WHERE user_id = $1 AND read_at IS NULL
        AND ($3::boolean OR id IN (SELECT jsonb_array_elements_text($4::jsonb)))`,
    [userId, at, sel.all === true, idList(sel.ids ?? [])],
  )
  return r.rowCount
}

/** Opening a thread also clears that person's notifications about it. */
export async function markThreadNotificationsRead(
  q: Queryable,
  userId: string,
  threadId: string,
  at: Date,
): Promise<void> {
  await q.query(
    'UPDATE notifications SET read_at = $3 WHERE user_id = $1 AND thread_id = $2 AND read_at IS NULL',
    [userId, threadId, at],
  )
}

/**
 * Everyone "following" a thread: its creator, every live comment's author and everyone mentioned in
 * it (Miro: you follow threads you post in or are mentioned in).
 */
export async function threadFollowers(q: Queryable, threadId: string): Promise<string[]> {
  const rows = await q.query<{ user_id: string }>(
    `SELECT created_by AS user_id FROM comment_threads WHERE id = $1
     UNION SELECT author_id FROM comments WHERE thread_id = $1 AND deleted_at IS NULL
     UNION SELECT m.user_id FROM comment_mentions m JOIN comments c ON c.id = m.comment_id
            WHERE c.thread_id = $1 AND c.deleted_at IS NULL`,
    [threadId],
  )
  return rows.rows.map((r) => r.user_id)
}
