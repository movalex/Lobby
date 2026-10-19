// OWNER: WS1 (wave V). Live activities: rows, SQL and the pure rules the routes share (docs/WAVE-V-CONTRACTS.md §2).
//
// The only per-person data that ever leaves this module is the CALLER's own answer (`myAnswerOf`) and, for a NAMED
// activity after its reveal, who answered what to a manager (`namedAnswers`). Everything else is an aggregate built
// by the contracts' pure tallies. Every query is scoped to one activity or one board the route has already checked.

import {
  type ActivityAnswer,
  type ActivityConfigOf,
  type ActivityResults,
  type ActivityStatus,
  type LiveActivity,
  normalizeWord,
  type PollConfig,
  type ScaleConfig,
  tallyPoll,
  tallyScale,
  tallyWords,
  type WordsConfig,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { isOpenAt, type Snapshot, snapshotOf } from './tally.ts'

export interface ActivityRow {
  id: string
  workspace_id: string
  board_id: string
  kind: 'poll' | 'scale' | 'words'
  prompt: string
  config: PollConfig | ScaleConfig | WordsConfig
  anonymous: boolean
  results_live: boolean
  status: ActivityStatus
  /** normalized words a manager hid (word clouds only) */
  hidden: string[]
  /** the aggregate frozen at the reveal (null before, and for a cancelled one) */
  results: ActivityResults | null
  created_by: string | null
  created_at: Date
  ends_at: Date | null
  closed_at: Date | null
  revealed_at: Date | null
  placed_at: Date | null
}

export const ACTIVITY_COLUMNS =
  'id, workspace_id, board_id, kind, prompt, config, anonymous, results_live, status, hidden, results, created_by, created_at, ends_at, closed_at, revealed_at, placed_at'

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** The status everyone is told: an open activity past its end time is closed. */
export function effectiveStatus(row: Pick<ActivityRow, 'status' | 'ends_at'>, at: Date): ActivityStatus {
  if (row.status === 'open' && !isOpenAt(row, at)) return 'closed'
  return row.status
}

/** The activity as the contracts describe it (its effective status; an end by time is its close). */
export function toActivity(row: ActivityRow, at: Date): LiveActivity {
  const status = effectiveStatus(row, at)
  const closedAt = row.closed_at ?? (status === 'closed' ? row.ends_at : null)
  return {
    kind: row.kind,
    config: row.config,
    id: row.id,
    boardId: row.board_id,
    prompt: row.prompt,
    anonymous: row.anonymous,
    resultsLive: row.results_live,
    status,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    endsAt: iso(row.ends_at),
    closedAt: iso(closedAt),
    revealedAt: iso(row.revealed_at),
    placedAt: iso(row.placed_at),
  } as LiveActivity
}

/**
 * The aggregate stored for `row`: frozen at its reveal, or at the close of an anonymous activity (whose answers are
 * gone then). Null while it is open, for a cancelled one, and for a closed named one (its answers are still kept).
 */
export function frozenOf(row: ActivityRow, at: Date): ActivityResults | null {
  const status = effectiveStatus(row, at)
  return status === 'closed' || status === 'revealed' ? row.results : null
}

export const configOf = (row: Pick<ActivityRow, 'kind' | 'config'>): ActivityConfigOf =>
  ({ kind: row.kind, config: row.config }) as ActivityConfigOf

/** The aggregate of `answers` (any order; no person attached), hidden words left out. */
export function tallyOf(
  row: Pick<ActivityRow, 'kind' | 'config'>,
  answers: readonly ActivityAnswer[],
  hidden: readonly string[],
): ActivityResults {
  const c = configOf(row)
  if (c.kind === 'poll')
    return tallyPoll(
      c.config.options.length,
      answers.flatMap((a) => (a.kind === 'poll' ? [a.choices] : [])),
    )
  if (c.kind === 'scale')
    return tallyScale(
      c.config.min,
      c.config.max,
      answers.flatMap((a) => (a.kind === 'scale' ? [a.value] : [])),
    )
  return tallyWords(
    answers.flatMap((a) => (a.kind === 'words' ? [a.words] : [])),
    hidden,
  )
}

/**
 * Frozen results with the words hidden since the reveal left out too (a word hidden before the reveal is already
 * out: its answers may be gone, so it cannot come back).
 */
export function withHidden(results: ActivityResults, hidden: readonly string[]): ActivityResults {
  if (results.kind !== 'words' || hidden.length === 0) return results
  const hide = new Set(hidden)
  const words = results.words.filter((w) => !hide.has(normalizeWord(w.text)))
  const removed = results.words.length - words.length
  if (removed === 0) return results
  return {
    ...results,
    words,
    distinct: Math.max(0, results.distinct - removed),
    hidden: results.hidden + removed,
  }
}

// ---- queries --------------------------------------------------------------------------------------------------

export async function findActivity(q: Queryable, id: string): Promise<ActivityRow | null> {
  return q.maybeOne<ActivityRow>(`SELECT ${ACTIVITY_COLUMNS} FROM live_activities WHERE id = $1`, [id])
}

/** Row lock on the activity: serializes every answer and transition of it. */
export async function lockActivity(tx: Queryable, id: string): Promise<ActivityRow> {
  return tx.one<ActivityRow>(`SELECT ${ACTIVITY_COLUMNS} FROM live_activities WHERE id = $1 FOR UPDATE`, [id])
}

/** The board's open activity, else its most recent closed or revealed one (a cancelled one is not shown). */
export async function currentActivity(q: Queryable, boardId: string): Promise<ActivityRow | null> {
  return q.maybeOne<ActivityRow>(
    `SELECT ${ACTIVITY_COLUMNS} FROM live_activities
      WHERE board_id = $1 AND status IN ('open', 'closed', 'revealed')
      ORDER BY (status = 'open') DESC, created_at DESC, id DESC LIMIT 1`,
    [boardId],
  )
}

/** Every answer of an activity, as a snapshot (no person attached). */
export async function readSnapshot(q: Queryable, activityId: string): Promise<Snapshot> {
  const rows = await q.query<{ answer: ActivityAnswer }>(
    'SELECT answer FROM live_answers WHERE activity_id = $1',
    [activityId],
  )
  return snapshotOf(rows.rows.map((r) => r.answer))
}

/** The CALLER's own answer (never anybody else's). */
export async function myAnswerOf(
  q: Queryable,
  activityId: string,
  userId: string,
): Promise<ActivityAnswer | null> {
  const row = await q.maybeOne<{ answer: ActivityAnswer }>(
    'SELECT answer FROM live_answers WHERE activity_id = $1 AND user_id = $2',
    [activityId, userId],
  )
  return row?.answer ?? null
}

/** A NAMED activity's answers with their authors (managers, after the reveal only: the route checks both). */
export async function namedAnswers(
  q: Queryable,
  activityId: string,
): Promise<{ userId: string; name: string; answer: ActivityAnswer }[]> {
  const rows = await q.query<{ user_id: string; name: string; answer: ActivityAnswer }>(
    `SELECT a.user_id, u.name, a.answer FROM live_answers a JOIN users u ON u.id = a.user_id
      WHERE a.activity_id = $1 ORDER BY a.created_at, a.user_id`,
    [activityId],
  )
  return rows.rows.map((r) => ({ userId: r.user_id, name: r.name, answer: r.answer }))
}

/** The board's activities, newest first, with how many answered each (the rows still kept). */
export async function recentActivities(
  q: Queryable,
  boardId: string,
  limit: number,
): Promise<(ActivityRow & { answers: number })[]> {
  const rows = await q.query<ActivityRow & { answers: number }>(
    `SELECT ${ACTIVITY_COLUMNS.split(', ')
      .map((c) => `a.${c}`)
      .join(', ')},
       (SELECT count(*)::int FROM live_answers x WHERE x.activity_id = a.id) AS answers
       FROM live_activities a WHERE a.board_id = $1
      ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
    [boardId, limit],
  )
  return rows.rows
}

// ---- settling: an activity that stopped taking answers (wave V review m2) -----------------------------------------
//
// Whenever an activity stops taking answers it is SETTLED: an open one is closed (closed_at = its end time when that
// passed, else now), and an ANONYMOUS one that is not open has its aggregate frozen into `results` (a closed one, if
// not yet: a revealed one froze at its reveal, a cancelled one has no results) and every answer row deleted, in the
// same transaction. So no row ties a person to an answer once it stopped taking them, whichever way it stopped: the
// close, the reveal, a cancel (the routes), its end time passing (the first read after it, through `settleEnded`, or
// the sweep), a new activity superseding it (the start), and its board being archived or trashed (routes/boards.ts,
// in the transaction that changes the board's status). A NAMED activity keeps its answers (GET …/answers).

/** Which activities may need settling: an open one past its end (or any open one with `closeOpen`), and an anonymous
 * one that is not open and still has answers or no frozen aggregate. */
const UNSETTLED = `(
    (a.status = 'open' AND (($2::boolean) OR (a.ends_at IS NOT NULL AND a.ends_at <= $3)))
    OR (a.anonymous AND a.status <> 'open'
        AND ((a.status = 'closed' AND a.results IS NULL)
             OR EXISTS (SELECT 1 FROM live_answers x WHERE x.activity_id = a.id)))
  )`

/** Settles one activity under its row lock. Returns whether it changed anything. */
export async function settleActivity(
  tx: Queryable,
  activityId: string,
  at: Date,
  opts: { closeOpen?: boolean } = {},
): Promise<boolean> {
  const row = await tx.maybeOne<ActivityRow>(
    `SELECT ${ACTIVITY_COLUMNS} FROM live_activities WHERE id = $1 FOR UPDATE`,
    [activityId],
  )
  if (!row) return false
  let status = row.status
  let closedAt = row.closed_at
  if (status === 'open') {
    const ended = row.ends_at !== null && row.ends_at.getTime() <= at.getTime()
    if (!ended && !opts.closeOpen) return false
    status = 'closed'
    closedAt = ended && row.ends_at ? row.ends_at : at
  }
  if (!row.anonymous) {
    if (status === row.status) return false
    await tx.query("UPDATE live_activities SET status = 'closed', closed_at = $2 WHERE id = $1", [
      row.id,
      closedAt,
    ])
    return true
  }
  let results = row.results
  if (status === 'closed' && results === null)
    results = tallyOf(row, (await readSnapshot(tx, row.id)).answers, row.hidden)
  const answers = await tx.query('DELETE FROM live_answers WHERE activity_id = $1', [row.id])
  if (status === row.status && results === row.results) return answers.rowCount > 0
  await tx.query(
    'UPDATE live_activities SET status = $2, closed_at = $3, results = $4::jsonb WHERE id = $1',
    [row.id, status, closedAt, results === null ? null : JSON.stringify(results)],
  )
  return true
}

/**
 * Settles every activity of `scope` that needs it (each under its own row lock, in id order), in `tx`. With
 * `closeOpen`, an open one is closed now whatever its end time (its board is being archived or trashed). Returns the
 * ids it changed.
 */
export async function settleActivities(
  tx: Queryable,
  scope: { boardId: string },
  at: Date,
  opts: { closeOpen?: boolean } = {},
): Promise<string[]> {
  const ids = await tx.query<{ id: string }>(
    `SELECT a.id FROM live_activities a WHERE a.board_id = $1 AND ${UNSETTLED} ORDER BY a.id`,
    [scope.boardId, opts.closeOpen === true, at],
  )
  const changed: string[] = []
  for (const { id } of ids.rows) if (await settleActivity(tx, id, at, opts)) changed.push(id)
  return changed
}

/** Up to `limit` activities anywhere that need settling (the sweep settles each in its own transaction). */
export async function unsettledActivities(q: Queryable, at: Date, limit: number): Promise<string[]> {
  const ids = await q.query<{ id: string }>(
    `SELECT a.id FROM live_activities a WHERE $1::int > 0 AND ${UNSETTLED} ORDER BY a.id LIMIT $1`,
    [limit, false, at],
  )
  return ids.rows.map((r) => r.id)
}
