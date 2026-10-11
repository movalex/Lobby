// The only SQL on board_visits (migration 0031_board_visits). Privacy by construction: every statement that reads or
// writes a person's visit is keyed by BOTH the board and the user id of the SESSION that asked ($1 board, $2 user),
// so no query can return another person's row; the one statement without a user id is the retention prune, which
// deletes and returns nothing but a count. test/features/visits/privacy.test.ts reads this file and the rest of the
// api's source to hold it to that. Nothing here logs, counts or returns a time except to the person it belongs to.

import { VisitAnswer } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'

/**
 * One UPSERT, the previous time back. `old` reads the row as the statement started: two tabs opening at the same
 * moment both read the same previous time (neither sees the other's write), which is the consistent answer, and a
 * later call reads the time the earlier one stored. seen_at never moves backwards (GREATEST), whatever the clocks do.
 */
export const RECORD_VISIT_SQL = `
  WITH old AS (SELECT seen_at FROM board_visits WHERE board_id = $1 AND user_id = $2)
  INSERT INTO board_visits (board_id, user_id, seen_at) VALUES ($1, $2, $3)
  ON CONFLICT (board_id, user_id) DO UPDATE SET seen_at = GREATEST(board_visits.seen_at, EXCLUDED.seen_at)
  RETURNING (SELECT seen_at FROM old) AS previous, seen_at AS seen`

/** The "Mark all seen" / pagehide write: the same UPSERT, nothing back. */
export const MARK_SEEN_SQL = `
  INSERT INTO board_visits (board_id, user_id, seen_at) VALUES ($1, $2, $3)
  ON CONFLICT (board_id, user_id) DO UPDATE SET seen_at = GREATEST(board_visits.seen_at, EXCLUDED.seen_at)`

/** The person's own stored time (a visit repeated inside the write interval answers with it). */
export const STORED_VISIT_SQL = 'SELECT seen_at FROM board_visits WHERE board_id = $1 AND user_id = $2'

/** The retention prune: the oldest rows past the cutoff, a batch at a time. Returns a count only. */
export const PRUNE_VISITS_SQL = `
  DELETE FROM board_visits
   WHERE (board_id, user_id) IN (SELECT board_id, user_id FROM board_visits WHERE seen_at < $1 ORDER BY seen_at LIMIT $2)`

interface VisitRow {
  previous: Date | null
  seen: Date
}

/** Stores a visit at `at`; the person's previous time (null on a first visit) and the one stored. */
export async function recordVisit(
  q: Queryable,
  boardId: string,
  userId: string,
  at: Date,
): Promise<VisitAnswer> {
  const row = await q.one<VisitRow>(RECORD_VISIT_SQL, [boardId, userId, at])
  return VisitAnswer.parse({
    previousSeenAt: row.previous ? row.previous.getTime() : null,
    seenAt: row.seen.getTime(),
  })
}

/** Stores `at` as the person's last seen time. */
export async function markSeen(q: Queryable, boardId: string, userId: string, at: Date): Promise<void> {
  await q.query(MARK_SEEN_SQL, [boardId, userId, at])
}

/** The person's own stored time, or null (no row). */
export async function storedVisit(q: Queryable, boardId: string, userId: string): Promise<number | null> {
  const row = await q.maybeOne<{ seen_at: Date }>(STORED_VISIT_SQL, [boardId, userId])
  return row ? row.seen_at.getTime() : null
}

/** Deletes up to `limit` rows last seen before `before`; how many went. */
export async function pruneVisits(q: Queryable, before: Date, limit: number): Promise<number> {
  const r = await q.query(PRUNE_VISITS_SQL, [before, limit])
  return r.rowCount
}
