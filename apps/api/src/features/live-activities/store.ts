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

/** An open activity of the board past its end time is closed now (closed_at = its end), so a new one may start. */
export async function closeEndedByTime(tx: Queryable, boardId: string, at: Date): Promise<void> {
  await tx.query(
    `UPDATE live_activities SET status = 'closed', closed_at = ends_at
      WHERE board_id = $1 AND status = 'open' AND ends_at IS NOT NULL AND ends_at <= $2`,
    [boardId, at],
  )
}
