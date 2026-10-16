// The outbox writer (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.4): called at the three notification insert sites, in the
// notification's own transaction. For each new notification it writes one `chat_deliveries` row for every enabled hook
// whose owner of the notification (the recipient) opted in to that kind, unique per (hook, notification), so nothing is
// lost and nothing is sent twice. A row holds no message: it is rendered at send time from current rows (deliver.ts).
//
// Best effort, like the bell's own inserts (trySavepoint): a failure here rolls back to a savepoint and is swallowed,
// so a broken outbox can never fail a comment, an access request or the notification itself. Nothing here logs.

import type { Queryable } from '@draftroom/db'

let savepointSeq = 0

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
    const res = await q.query(
      `INSERT INTO chat_deliveries (hook_id, notification_id, recipient_id)
       SELECT p.hook_id, n.id, n.user_id
         FROM notifications n
         JOIN chat_hook_prefs p ON p.user_id = n.user_id AND p.workspace_id = n.workspace_id
         JOIN chat_hooks h ON h.id = p.hook_id AND h.workspace_id = n.workspace_id AND h.disabled_at IS NULL
        WHERE n.id IN (SELECT jsonb_array_elements_text($1::jsonb))
          AND n.kind = ANY (p.kinds)
       ON CONFLICT (hook_id, notification_id) DO NOTHING`,
      [JSON.stringify(notificationIds)],
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
