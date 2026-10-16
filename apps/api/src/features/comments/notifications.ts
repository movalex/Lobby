// In-app notifications (mentions, replies, resolutions, new threads for a board's owners; other features
// insert access requests, and access granted (PRI-09b), into the same table). No email is sent. Listing
// re-checks board access for every row, so a person who lost access to a board stops seeing that board's
// notifications (and their comment snippets) immediately.
// The kinds a web build from before 0024 cannot parse (NOTIFICATION_KINDS_SINCE_REV1) are left out of its
// list and its unread count (`rev`, @draftroom/contracts client-rev.ts), and so are the kinds a build
// from before 0026 cannot (NOTIFICATION_KINDS_SINCE_REV2: wave J's 'outsider_joined').
//
// Wave J: a team-only thread's items are shown only to someone on the team, which now needs a confirmed
// creator (store.ts onTeam; the caller's status comes in as `creator`). 'outsider_joined' (an account
// outside Dark Burn / TPG opened one of the recipient's boards for the first time) is listed only while
// the recipient may manage access there, with the outsider's email domain. The actor's name and an
// access request's message are shown without control, bidi or zero-width characters (stored before
// they were cleaned on input; the owner decides on an access request from the bell).

import {
  cleanDisplayText,
  commentPlainText,
  knowsRev1,
  knowsRev2,
  NOTIFICATION_KINDS_SINCE_REV1,
  NOTIFICATION_KINDS_SINCE_REV2,
  type NotificationItem,
  type NotificationKind,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import {
  type BoardRole,
  type BoardStatus,
  type BoardVisibility,
  can,
  resolveBoardRole,
  type WorkspaceRole,
} from '@draftroom/permissions'
import { enqueueChatDeliveries } from '../chat-hooks/outbox.ts'
import { idList, onTeam } from './store.ts'

export const MAX_NOTIFICATIONS_LISTED = 100
const MAX_UNREAD_COUNTED = 1_000
/** The newest rows the list reads before it leaves out what the caller may not see. */
const LISTED_SCAN = MAX_NOTIFICATIONS_LISTED * 3
const SNIPPET_MAX = 140
/**
 * DANA-02 flood cap: at most this many unread 'new_comment' notifications from one author on one board,
 * per recipient, within NEW_COMMENT_CAP_WINDOW_MS. Past it the author's further threads still show on
 * the board and in the Comments panel; they just stop adding bell items until the owner reads some.
 */
export const NEW_COMMENT_UNREAD_CAP = 5
export const NEW_COMMENT_CAP_WINDOW_MS = 60 * 60_000
/**
 * The board as a whole: at most this many unread 'new_comment' items per recipient, whoever wrote them
 * and however old. A name-only guest costs nothing but a name (a link lets in up to GUESTS_PER_LINK),
 * so a per-author cap alone multiplies by the guests one person can create (link-caps.ts).
 */
export const NEW_COMMENT_BOARD_CAP = 20
/**
 * NC-V4: at most this many 'mention' notifications from one author on one board (all recipients
 * together, read or not) within MENTION_CAP_WINDOW_MS. A comment may mention up to 50 people, and the
 * write budget allows 120 comments a minute, so without this one author could post thousands of bell
 * items an hour. Past it the mention still shows in the comment; see withinMentionCap for what the
 * mentioned person gets instead.
 */
export const MENTION_NOTIFY_CAP = 100
export const MENTION_CAP_WINDOW_MS = 60 * 60_000

/** pg_advisory_xact_lock namespace (the two-key form) of one board's capped notifications ("DRNC"). */
export const NOTIFY_LOCK_NS = 0x44524e43

type CommentNotificationKind = Exclude<
  NotificationKind,
  'access_request' | 'access_granted' | 'outsider_joined'
>

export interface NewNotification {
  userId: string
  kind: CommentNotificationKind
  /**
   * For a 'mention': what this person would get without the mention (a thread follower's 'reply', or
   * a board owner's 'new_comment' for a new thread), used when the author is past MENTION_NOTIFY_CAP.
   */
  fallback?: Exclude<CommentNotificationKind, 'mention'>
}

/**
 * NC-V3: the caps below are "count, then insert", so two transactions that both count before either
 * commits could both insert past a cap (real Postgres runs requests on separate connections). This lock
 * serializes, per board, every transaction that inserts capped notifications, until it commits; READ
 * COMMITTED gives each later statement a fresh snapshot, so the next holder counts the rows the last
 * one committed. Take it BEFORE any row lock in the transaction (only reads may come first): then a
 * transaction waiting for it holds no row locks, so it can never close a deadlock cycle with the row
 * lock order in access.ts.
 */
export async function lockBoardNotifications(q: Queryable, boardId: string): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))', [NOTIFY_LOCK_NS, boardId])
}

/**
 * NC-V4: keeps at most MENTION_NOTIFY_CAP 'mention' items from this author on this board within the
 * window (the first mentioned people, in order, keep theirs). A mention past the cap becomes its
 * `fallback` (then capped like any item of that kind), or is dropped. Call under
 * lockBoardNotifications.
 */
export async function withinMentionCap(
  q: Queryable,
  base: { boardId: string; actorId: string; at: Date },
  recipients: readonly NewNotification[],
): Promise<NewNotification[]> {
  if (!recipients.some((r) => r.kind === 'mention')) return [...recipients]
  const sent = await q.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE board_id = $1 AND actor_id = $2 AND kind = 'mention' AND created_at > $3`,
    [base.boardId, base.actorId, new Date(base.at.getTime() - MENTION_CAP_WINDOW_MS)],
  )
  let room = Math.max(0, MENTION_NOTIFY_CAP - sent.n)
  const out: NewNotification[] = []
  for (const r of recipients) {
    if (r.kind !== 'mention') out.push(r)
    else if (room > 0) {
      room--
      out.push(r)
    } else if (r.fallback) out.push({ userId: r.userId, kind: r.fallback })
  }
  return out
}

/** Every cap, in order (a mention past its cap may become a capped 'new_comment'). */
export async function withinNotificationCaps(
  q: Queryable,
  base: { boardId: string; actorId: string; at: Date },
  recipients: readonly NewNotification[],
): Promise<NewNotification[]> {
  return withinNewCommentCap(q, base, await withinMentionCap(q, base, recipients))
}

/**
 * The board's owners: its direct owner grants (the creator, and anyone made owner in Share). Workspace
 * owners and admins inherit owner rights on every board but are not told about every thread.
 */
export async function boardOwners(q: Queryable, boardId: string): Promise<string[]> {
  const rows = await q.query<{ user_id: string }>(
    "SELECT user_id FROM board_members WHERE board_id = $1 AND role = 'owner'",
    [boardId],
  )
  return rows.rows.map((r) => r.user_id)
}

/**
 * Drops the 'new_comment' recipients who already hold NEW_COMMENT_UNREAD_CAP unread ones from this
 * author on this board (within the window), or NEW_COMMENT_BOARD_CAP from anyone on this board, so
 * neither a guest opening thread after thread nor a crowd of guests from one link can flood an owner's
 * bell. Only items the owner can still see count: one whose comment was deleted is hidden from the
 * bell (and so can never be read), so it must not hold a slot. Mentions have their own cap
 * (withinMentionCap); replies are bounded by the per-person write budget and the thread's size. Call
 * under lockBoardNotifications.
 */
export async function withinNewCommentCap(
  q: Queryable,
  base: { boardId: string; actorId: string; at: Date },
  recipients: readonly NewNotification[],
): Promise<NewNotification[]> {
  const asked = recipients.filter((r) => r.kind === 'new_comment').map((r) => r.userId)
  if (asked.length === 0) return [...recipients]
  const rows = await q.query<{ user_id: string; mine: number; board: number }>(
    `SELECT n.user_id,
            count(*) FILTER (WHERE n.actor_id = $2 AND n.created_at > $3)::int AS mine,
            count(*)::int AS board
       FROM notifications n JOIN comments c ON c.id = n.comment_id AND c.deleted_at IS NULL
      WHERE n.board_id = $1 AND n.kind = 'new_comment' AND n.read_at IS NULL
        AND n.user_id IN (SELECT jsonb_array_elements_text($4::jsonb))
      GROUP BY n.user_id`,
    [base.boardId, base.actorId, new Date(base.at.getTime() - NEW_COMMENT_CAP_WINDOW_MS), idList(asked)],
  )
  const full = new Set(
    rows.rows
      .filter((r) => r.mine >= NEW_COMMENT_UNREAD_CAP || r.board >= NEW_COMMENT_BOARD_CAP)
      .map((r) => r.user_id),
  )
  return recipients.filter((r) => r.kind !== 'new_comment' || !full.has(r.userId))
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
  const ids: string[] = []
  for (const r of recipients) {
    const row = await q.one<{ id: string }>(
      `INSERT INTO notifications (workspace_id, user_id, kind, board_id, thread_id, comment_id, actor_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
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
    ids.push(row.id)
  }
  // wave R: opted-in people's chat messages, in this transaction (best effort: never fails the notification)
  await enqueueChatDeliveries(q, ids)
}

export interface NotificationRow {
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
  /** access_granted: the role of the approved request (PRI-09b). */
  granted_role: 'editor' | 'commenter' | 'viewer' | null
  /** F10: the thread's visibility (null: no thread), and the recipient's kind of user. */
  thread_visibility: 'everyone' | 'team' | null
  recipient_kind: string | null
  /** outsider_joined: the actor's primary stored address's domain (wave J). */
  actor_domain: string | null
}

/**
 * The list query's SELECT; `source` is the parameter that holds the running provider (wave J). `picked` (wave M,
 * M5-3): the rows come from a `picked` CTE (id, listed, counted) joined first, and its two flags are selected.
 */
export const selectSql = (
  source: string,
  picked = false,
) => `SELECT n.id, n.kind, n.board_id, n.thread_id, n.comment_id, n.created_at, n.read_at,${picked ? ' p.listed, p.counted,' : ''}
       b.title AS board_title, b.visibility, b.status,
       wm.role AS workspace_role, bm.role AS board_grant,
       a.id AS actor_id, a.name AS actor_name, a.color AS actor_color,
       c.body AS comment_body, c.deleted_at AS comment_deleted_at,
       ar.role_requested AS request_role, ar.message AS request_message, ar.status AS request_status,
       ag.role_granted AS granted_role,
       t.visibility AS thread_visibility, ru.kind AS recipient_kind,
       CASE WHEN n.kind = 'outsider_joined' THEN (
         SELECT e.domain FROM user_emails e WHERE e.user_id = n.actor_id AND e.source = ${source}::text
          ORDER BY e.is_primary DESC, e.seen_at, e.email LIMIT 1) END AS actor_domain
  FROM notifications n${picked ? ' JOIN picked p ON p.id = n.id' : ''}
  JOIN boards b ON b.id = n.board_id AND b.workspace_id = n.workspace_id
  LEFT JOIN users ru ON ru.id = n.user_id
  LEFT JOIN comment_threads t ON t.id = n.thread_id AND t.board_id = n.board_id
  LEFT JOIN workspace_members wm ON wm.workspace_id = n.workspace_id AND wm.user_id = n.user_id
  LEFT JOIN board_members bm ON bm.board_id = n.board_id AND bm.user_id = n.user_id
  LEFT JOIN users a ON a.id = n.actor_id
  LEFT JOIN comments c ON c.id = n.comment_id
  LEFT JOIN LATERAL (
    SELECT r.role_requested, r.message, r.status FROM access_requests r
     WHERE n.kind = 'access_request' AND r.workspace_id = n.workspace_id AND r.board_id = n.board_id
       AND r.user_id = n.actor_id AND r.created_at <= n.created_at + interval '1 second'
     ORDER BY r.created_at DESC LIMIT 1
  ) ar ON true
  LEFT JOIN LATERAL (
    SELECT r.role_granted FROM access_requests r
     WHERE n.kind = 'access_granted' AND r.workspace_id = n.workspace_id AND r.board_id = n.board_id
       AND r.user_id = n.user_id AND r.status = 'approved' AND r.decided_at <= n.created_at + interval '1 second'
     ORDER BY r.decided_at DESC LIMIT 1
  ) ag ON true`

/**
 * Whether the recipient may still see this notification: board access now, comment not deleted.
 * `creator`: the recipient is a confirmed creator (wave J: needed to be on the team).
 */
export function visible(r: NotificationRow, creator: boolean): boolean {
  const role = resolveBoardRole({
    workspaceRole: r.workspace_role,
    boardGrant: r.board_grant,
    visibility: r.visibility,
  })
  if (r.comment_id && (r.comment_body === null || r.comment_deleted_at)) return false
  // F10: a team-only thread (made team-only after this was sent, or its thread is gone) is never
  // shown to someone outside the team: not in the bell, not in the count.
  if (
    r.thread_id &&
    r.thread_visibility !== 'everyone' &&
    !onTeam(r.workspace_role, r.recipient_kind, creator)
  )
    return false
  // Access requests are for people who can act on them, and so is the notice about an outside account.
  if (r.kind === 'access_request' || r.kind === 'outsider_joined') return can(role, 'manage_access', r.status)
  return can(role, 'view', r.status)
}

export function snippetOf(body: string | null): string | null {
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
        ? {
            id: r.actor_id,
            name: cleanDisplayText(r.actor_name) || 'Someone',
            color: r.actor_color ?? '#888888',
            // the outsider of an outsider_joined notice is outside by construction (wave J)
            ...(r.kind === 'outsider_joined' ? { external: true } : {}),
          }
        : null,
    snippet: snippetOf(r.comment_body),
    accessRequest:
      r.kind === 'access_request' && r.request_role && r.request_status
        ? {
            role: r.request_role,
            message: r.request_message === null ? null : cleanDisplayText(r.request_message) || null,
            status: r.request_status,
          }
        : null,
    accessGranted: r.kind === 'access_granted' && r.granted_role ? { role: r.granted_role } : null,
    ...(r.kind === 'outsider_joined' ? { outsiderJoined: { emailDomain: r.actor_domain } } : {}),
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at ? r.read_at.toISOString() : null,
  }
}

/**
 * The caller's notifications, newest first. `rev` is the caller's web build revision
 * (@draftroom/contracts client-rev.ts; 0 when omitted): a build from before 0024 (or 0026) gets no kind
 * it cannot parse, in the list or in the count. `creator`: the caller is a confirmed creator (wave J:
 * team-only threads' items need it; omitted = not one, which fails closed). `emailSource`: the running
 * provider (whose stored address gives an outsider notice its domain).
 */
export async function listNotifications(
  q: Queryable,
  userId: string,
  opts: { unreadOnly?: boolean; rev?: number; creator?: boolean; emailSource?: string } = {},
): Promise<{ notifications: NotificationItem[]; unreadCount: number }> {
  const rev = opts.rev ?? 0
  const hidden = idList([
    ...(knowsRev1(rev) ? [] : NOTIFICATION_KINDS_SINCE_REV1),
    ...(knowsRev2(rev) ? [] : NOTIFICATION_KINDS_SINCE_REV2),
  ])
  const creator = opts.creator === true
  const isVisible = (r: NotificationRow) => visible(r, creator)
  // Wave M (M5-3, CAP-BELL-POLL): ONE statement for the list and the unread count (they were two, each with the
  // joins). `picked` takes the newest LISTED_SCAN rows of the list and the newest MAX_UNREAD_COUNTED unread ones,
  // exactly the rows the two queries read, each once with both flags; the joins run once over them. Who may see a
  // row is still decided here (visible), so the list and the count are what the two queries gave.
  const rows = await q.query<NotificationRow & { listed: boolean; counted: boolean }>(
    `WITH picked AS (
       SELECT u.id, bool_or(u.listed) AS listed, bool_or(u.counted) AS counted FROM (
         (SELECT n.id, true AS listed, false AS counted FROM notifications n
           WHERE n.user_id = $1 AND ($2::boolean = false OR n.read_at IS NULL)
             AND n.kind NOT IN (SELECT jsonb_array_elements_text($3::jsonb))
           ORDER BY n.seq DESC LIMIT ${LISTED_SCAN})
         UNION ALL
         (SELECT n.id, false AS listed, true AS counted FROM notifications n
           WHERE n.user_id = $1 AND n.read_at IS NULL
             AND n.kind NOT IN (SELECT jsonb_array_elements_text($3::jsonb))
           ORDER BY n.seq DESC LIMIT ${MAX_UNREAD_COUNTED})
       ) u GROUP BY u.id
     )
     ${selectSql('$4', true)}
      ORDER BY n.seq DESC`,
    [userId, opts.unreadOnly === true, hidden, opts.emailSource ?? 'dev'],
  )
  const notifications = rows.rows
    .filter((r) => r.listed && isVisible(r))
    .slice(0, MAX_NOTIFICATIONS_LISTED)
    .map(toItem)
  return { notifications, unreadCount: rows.rows.filter((r) => r.counted && isVisible(r)).length }
}

/**
 * Wave M (M5-3): the newest notification of the caller, of any kind and whoever may see it now (0 when none): one
 * indexed read (notifications_user_idx, user_id + seq). The bell poll's `since` is compared with it: equal means
 * nothing was added or removed since the client's last list (GET /api/me/notifications answers 204).
 */
export async function latestNotificationSeq(q: Queryable, userId: string): Promise<number> {
  const row = await q.one<{ seq: string | null }>(
    'SELECT max(seq)::text AS seq FROM notifications WHERE user_id = $1',
    [userId],
  )
  return row.seq === null ? 0 : Number(row.seq)
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
