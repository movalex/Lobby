// Dot voting: SQL and rules. Every read here is scoped to one session; the only per-user data that
// ever leaves is the CALLER's own ballot (`myVotes`). Other people's ballots are aggregated into
// counts only, and per-object totals exist only once a vote is revealed (PRF-07, FAC-06).

import {
  rankVoteResults,
  type VoteResult,
  type VoteSession,
  type VoteSessionSummary,
  type VoteStatus,
  type WorkshopVoteEvent,
  type WorkshopVoteState,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { ApiError, conflict } from '../../errors.ts'

export interface SessionRow {
  id: string
  workspace_id: string
  board_id: string
  title: string
  votes_per_person: number
  one_per_object: boolean
  scope: 'board' | 'frame'
  frame_id: string | null
  shape_types: string[] | null
  status: VoteStatus
  created_by: string
  created_at: Date
  ends_at: Date | null
  closed_at: Date | null
  revealed_at: Date | null
}

export const SESSION_COLUMNS =
  'id, workspace_id, board_id, title, votes_per_person, one_per_object, scope, frame_id, shape_types, status, created_by, created_at, ends_at, closed_at, revealed_at'

/** An open vote past its end time counts as closed (no scheduler: every read/write applies this). */
export function effectiveStatus(row: Pick<SessionRow, 'status' | 'ends_at'>, now: Date): VoteStatus {
  if (row.status === 'open' && row.ends_at && row.ends_at.getTime() <= now.getTime()) return 'closed'
  return row.status
}

function effectiveClosedAt(row: SessionRow, now: Date): Date | null {
  if (row.closed_at) return row.closed_at
  return effectiveStatus(row, now) === 'closed' ? row.ends_at : null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toVoteSession(row: SessionRow, now: Date): VoteSession {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    votesPerPerson: row.votes_per_person,
    onePerObject: row.one_per_object,
    scope: row.scope,
    frameId: row.frame_id,
    shapeTypes: row.shape_types,
    status: effectiveStatus(row, now),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    endsAt: iso(row.ends_at),
    closedAt: iso(effectiveClosedAt(row, now)),
    revealedAt: iso(row.revealed_at),
  }
}

export const voteClosed = () => conflict('VOTE_CLOSED', 'This vote has ended.')
export const notEligible = () =>
  new ApiError(400, 'NOT_ELIGIBLE', "That object can't receive votes in this vote.")

/** Just enough to find the board (for the access check) without locking anything. */
export async function findSession(q: Queryable, sessionId: string): Promise<SessionRow | null> {
  return q.maybeOne<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM vote_sessions WHERE id = $1`, [sessionId])
}

/** Row lock on the session: serializes every ballot change of that vote (budget checks stay exact). */
export async function lockSession(tx: Queryable, sessionId: string): Promise<SessionRow> {
  return tx.one<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM vote_sessions WHERE id = $1 FOR UPDATE`, [
    sessionId,
  ])
}

/** The open vote of a board, else the most recent one. */
export async function currentSession(q: Queryable, boardId: string): Promise<SessionRow | null> {
  return q.maybeOne<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM vote_sessions WHERE board_id = $1
      ORDER BY (status = 'open') DESC, created_at DESC, id DESC LIMIT 1`,
    [boardId],
  )
}

export interface Aggregates {
  totalVotesCast: number
  participants: number
  participantsDone: number
}

export async function aggregates(q: Queryable, sessionId: string): Promise<Aggregates> {
  return q.one<Aggregates>(
    `SELECT
       (SELECT coalesce(sum(count), 0)::int FROM votes WHERE session_id = $1) AS "totalVotesCast",
       (SELECT count(*)::int FROM (
          SELECT user_id FROM votes WHERE session_id = $1
          UNION SELECT user_id FROM vote_done WHERE session_id = $1) p) AS "participants",
       (SELECT count(*)::int FROM vote_done WHERE session_id = $1) AS "participantsDone"`,
    [sessionId],
  )
}

export async function myBallot(
  q: Queryable,
  sessionId: string,
  userId: string,
): Promise<Map<string, number>> {
  const rows = await q.query<{ shape_id: string; count: number }>(
    'SELECT shape_id, count FROM votes WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  )
  return new Map(rows.rows.map((r) => [r.shape_id, r.count]))
}

/** Per-object totals. ONLY call for a revealed vote. */
export async function revealedResults(q: Queryable, sessionId: string): Promise<VoteResult[]> {
  const rows = await q.query<{ shape_id: string; n: number }>(
    'SELECT shape_id, sum(count)::int AS n FROM votes WHERE session_id = $1 GROUP BY shape_id',
    [sessionId],
  )
  return rankVoteResults(rows.rows.map((r) => ({ shapeId: r.shape_id, count: r.n })))
}

export async function voteState(
  q: Queryable,
  row: SessionRow,
  userId: string,
  now: Date,
): Promise<WorkshopVoteState> {
  const session = toVoteSession(row, now)
  const [agg, mine, done] = [
    await aggregates(q, row.id),
    await myBallot(q, row.id, userId),
    await q.maybeOne('SELECT 1 AS ok FROM vote_done WHERE session_id = $1 AND user_id = $2', [
      row.id,
      userId,
    ]),
  ]
  let used = 0
  for (const n of mine.values()) used += n
  return {
    session,
    myVotes: Object.fromEntries(mine),
    myRemaining: Math.max(0, row.votes_per_person - used),
    done: !!done,
    ...agg,
    results: session.status === 'revealed' ? await revealedResults(q, row.id) : null,
  }
}

export function voteEvent(row: SessionRow, agg: Aggregates, now: Date): WorkshopVoteEvent {
  return {
    sessionId: row.id,
    status: effectiveStatus(row, now),
    endsAt: iso(row.ends_at),
    ...agg,
  }
}

export async function summaries(q: Queryable, boardId: string, now: Date): Promise<VoteSessionSummary[]> {
  const rows = await q.query<SessionRow & { total: number; participants: number }>(
    `SELECT ${SESSION_COLUMNS.split(', ')
      .map((c) => `s.${c}`)
      .join(', ')},
       (SELECT coalesce(sum(count), 0)::int FROM votes v WHERE v.session_id = s.id) AS total,
       (SELECT count(*)::int FROM (
          SELECT user_id FROM votes WHERE session_id = s.id
          UNION SELECT user_id FROM vote_done WHERE session_id = s.id) p) AS participants
       FROM vote_sessions s WHERE s.board_id = $1
      ORDER BY s.created_at DESC, s.id DESC LIMIT 50`,
    [boardId],
  )
  return rows.rows.map(({ total, participants, ...row }) => ({
    ...toVoteSession(row, now),
    totalVotesCast: total,
    participants,
  }))
}

export type CastOutcome = 'added' | 'removed'

/**
 * Applies one +1/-1 under the session lock. Rules (all server-side):
 * - the vote must be open (not closed, revealed or past its end time);
 * - +1 needs a vote left (sum of the caller's dots < votes per person);
 * - +1 with one-per-object needs the caller to have no dot on that object yet;
 * - -1 needs one of the caller's own dots on that object.
 * Eligibility of the object (scope, types) is checked by the caller before the transaction, because
 * it needs the canvas snapshot and must not hold the lock across a network call.
 */
export async function castInLockedSession(
  tx: Queryable,
  row: SessionRow,
  userId: string,
  shapeId: string,
  delta: 1 | -1,
  now: Date,
): Promise<CastOutcome> {
  if (effectiveStatus(row, now) !== 'open') throw voteClosed()
  const mine = await myBallot(tx, row.id, userId)
  const existing = mine.get(shapeId) ?? 0
  if (delta === 1) {
    let used = 0
    for (const n of mine.values()) used += n
    if (used >= row.votes_per_person) throw conflict('NO_VOTES_LEFT', "You've used all your votes.")
    if (row.one_per_object && existing >= 1)
      throw conflict('ONE_PER_OBJECT', 'This vote allows one vote per object.')
    await tx.query(
      `INSERT INTO votes (session_id, workspace_id, user_id, shape_id, count, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5)
       ON CONFLICT (session_id, user_id, shape_id) DO UPDATE SET count = votes.count + 1, updated_at = $5`,
      [row.id, row.workspace_id, userId, shapeId, now],
    )
    return 'added'
  }
  if (existing === 0) throw conflict('NO_VOTE_TO_REMOVE', "You haven't voted on that object.")
  if (existing === 1) {
    await tx.query('DELETE FROM votes WHERE session_id = $1 AND user_id = $2 AND shape_id = $3', [
      row.id,
      userId,
      shapeId,
    ])
  } else {
    await tx.query(
      'UPDATE votes SET count = count - 1, updated_at = $4 WHERE session_id = $1 AND user_id = $2 AND shape_id = $3',
      [row.id, userId, shapeId, now],
    )
  }
  return 'removed'
}
