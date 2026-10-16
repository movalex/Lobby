// The outbox writer (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.4): called at the three notification insert sites, in the
// notification's own transaction. For each new notification it writes one `chat_deliveries` row for every enabled hook
// whose owner of the notification (the recipient) opted in to that kind, unique per (hook, notification), so nothing is
// lost and nothing is sent twice. An event many people are told of (MANY_RECIPIENT_KINDS: a new comment for the board's
// owners, an access request or an outsider for its owners or the workspace's admins) is ONE row per hook: its
// `event_key` (kind, board, comment or thread, actor, time: what the insert site's notifications share) is unique per
// hook, and the first opted-in recipient's notification carries it (the channel reads one message, not one per person).
// A row holds no message: it is rendered at send time from current rows (deliver.ts).
//
// Best effort, like the bell's own inserts (trySavepoint): a failure here rolls back to a savepoint and is swallowed,
// so a broken outbox can never fail a comment, an access request or the notification itself. Nothing here logs.

import type { Queryable } from '@draftroom/db'

let savepointSeq = 0

/** Kinds whose one event notifies several people with the same words: one message per hook per event. */
// wave S (WS1): a review step (a status, a round start, a new-version reset) tells the board's owners, the people who
// marked the items and the earlier setters: one message per hook per event too.
export const MANY_RECIPIENT_KINDS = [
  'new_comment',
  'access_request',
  'outsider_joined',
  'review_status',
] as const

/**
 * The event of a notification of a many-recipient kind, as SQL over `n` (NULL for the other kinds); a review_status
 * one is keyed by its review event (wave S).
 */
const EVENT_KEY = `CASE WHEN n.kind = ANY ($2::text[]) THEN
    n.kind || ':' || n.board_id || ':' || COALESCE(n.comment_id, n.thread_id, n.review_event_id, '-') || ':' || COALESCE(n.actor_id, '-')
      || ':' || to_char(n.created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') END`

/**
 * Queues the chat messages of these notifications (ids of rows just inserted in this transaction). Returns how many
 * deliveries were queued; 0 when no one opted in, the ids are empty, or the outbox could not be written.
 */
export async function enqueueChatDeliveries(
  q: Queryable,
  notificationIds: readonly string[],
): Promise<number> {
  if (notificationIds.length === 0) return 0
  const name = `dr_chat_${++savepointSeq}`
  let saved = false
  try {
    await q.query(`SAVEPOINT ${name}`)
    saved = true
  } catch {
    // not inside a transaction block: the statement below stands alone
  }
  try {
    // any unique key: (hook, notification), and (hook, event) for a many-recipient kind
    const res = await q.query(
      `INSERT INTO chat_deliveries (hook_id, notification_id, recipient_id, event_key)
       SELECT DISTINCT ON (p.hook_id, COALESCE(e.key, n.id)) p.hook_id, n.id, n.user_id, e.key
         FROM notifications n
         CROSS JOIN LATERAL (SELECT ${EVENT_KEY} AS key) e
         JOIN chat_hook_prefs p ON p.user_id = n.user_id AND p.workspace_id = n.workspace_id
         JOIN chat_hooks h ON h.id = p.hook_id AND h.workspace_id = n.workspace_id AND h.disabled_at IS NULL
        WHERE n.id IN (SELECT jsonb_array_elements_text($1::jsonb))
          AND n.kind = ANY (p.kinds)
        ORDER BY p.hook_id, COALESCE(e.key, n.id), n.user_id
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(notificationIds), [...MANY_RECIPIENT_KINDS]],
    )
    if (saved) await q.query(`RELEASE SAVEPOINT ${name}`)
    return res.rowCount
  } catch {
    if (saved) {
      try {
        await q.query(`ROLLBACK TO SAVEPOINT ${name}`)
      } catch {
        // the transaction is gone; the caller's own statement will say so
      }
    }
    return 0
  }
}
