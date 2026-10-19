// OWNER: WS4 (wave V, breakouts). The rows of migration 0038 (breakout_sessions, breakout_members) and their queries.
// Every lookup of a session names the board's `status IN ('active', 'archived')` (an importing or trashed board's
// session answers as one that does not exist); the routes then check the caller's access to that board.
//
// Lock order (apps/api/src/access.ts): a transaction that changes a session takes its row FOR UPDATE (step 2, a row
// that belongs to the board) and only then touches its members (step 5-like rows of the session). Start takes the
// board row first (step 1, requireBoardAction forUpdate) and inserts the session under it.

import {
  BREAKOUT_RECENT_MS,
  type BreakoutGroup,
  type BreakoutMember,
  type BreakoutMode,
  type BreakoutSession,
  type BreakoutStatus,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'

export interface SessionRow {
  id: string
  workspace_id: string
  board_id: string
  mode: BreakoutMode
  groups: BreakoutGroup[]
  group_cap: number | null
  status: BreakoutStatus
  rev: number
  created_by: string | null
  created_at: Date
  ends_at: Date | null
  ended_at: Date | null
}

export interface MemberRow {
  user_id: string
  name: string
  group_id: string
}

export const SESSION_COLUMNS =
  's.id, s.workspace_id, s.board_id, s.mode, s.groups, s.group_cap, s.status, s.rev, s.created_by, s.created_at, s.ends_at, s.ended_at'
const RETURNING =
  'id, workspace_id, board_id, mode, groups, group_cap, status, rev, created_by, created_at, ends_at, ended_at'

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** A jsonb column as the driver hands it (pg parses it; a text value is parsed here). */
const groupsOf = (v: unknown): BreakoutGroup[] =>
  (typeof v === 'string' ? JSON.parse(v) : v) as BreakoutGroup[]

const normalize = (r: SessionRow): SessionRow => ({ ...r, groups: groupsOf(r.groups) })

export function toSession(r: SessionRow): BreakoutSession {
  return {
    id: r.id,
    boardId: r.board_id,
    groups: r.groups.map((g) => ({ id: g.id, name: g.name, frameId: g.frameId })),
    mode: r.mode,
    groupCap: r.group_cap,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    endsAt: iso(r.ends_at),
    endedAt: iso(r.ended_at),
    rev: r.rev,
  }
}

export const toMember = (m: MemberRow): BreakoutMember => ({
  userId: m.user_id,
  name: m.name,
  groupId: m.group_id,
})

/** The board's running session, else the last one that ended within BREAKOUT_RECENT_MS of `at`, else null. */
export async function currentSession(q: Queryable, boardId: string, at: Date): Promise<SessionRow | null> {
  const row = await q.maybeOne<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM breakout_sessions s
       JOIN boards b ON b.id = s.board_id AND b.status IN ('active', 'archived')
      WHERE s.board_id = $1 AND (s.status = 'running' OR s.ended_at > $2)
      ORDER BY (s.status = 'running') DESC, s.created_at DESC
      LIMIT 1`,
    [boardId, new Date(at.getTime() - BREAKOUT_RECENT_MS)],
  )
  return row ? normalize(row) : null
}

/** A session by id (null when unknown, or its board is gone, trashed or importing). */
export async function findSession(q: Queryable, id: string): Promise<SessionRow | null> {
  const row = await q.maybeOne<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
       FROM breakout_sessions s
       JOIN boards b ON b.id = s.board_id AND b.status IN ('active', 'archived')
      WHERE s.id = $1`,
    [id],
  )
  return row ? normalize(row) : null
}

/** The session's row, locked (inside a transaction). */
export async function lockSession(tx: Queryable, id: string): Promise<SessionRow> {
  const row = await tx.one<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM breakout_sessions s WHERE s.id = $1 FOR UPDATE OF s`,
    [id],
  )
  return normalize(row)
}

export async function insertSession(
  tx: Queryable,
  v: {
    id: string
    workspaceId: string
    boardId: string
    mode: BreakoutMode
    groups: BreakoutGroup[]
    groupCap: number | null
    createdBy: string
    createdAt: Date
    endsAt: Date | null
  },
): Promise<SessionRow> {
  const row = await tx.one<SessionRow>(
    `INSERT INTO breakout_sessions (id, workspace_id, board_id, mode, groups, group_cap, status, rev, created_by,
       created_at, ends_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'running', 0, $7, $8, $9)
     RETURNING ${RETURNING}`,
    [
      v.id,
      v.workspaceId,
      v.boardId,
      v.mode,
      JSON.stringify(v.groups),
      v.groupCap,
      v.createdBy,
      v.createdAt,
      v.endsAt,
    ],
  )
  return normalize(row)
}

/** rev + 1, and any of the changed columns (inside the transaction holding the row). */
export async function bumpSession(
  tx: Queryable,
  id: string,
  change: { endsAt?: Date | null; end?: Date } = {},
): Promise<SessionRow> {
  const sets = ['rev = rev + 1']
  const params: unknown[] = [id]
  if (change.endsAt !== undefined) {
    params.push(change.endsAt)
    sets.push(`ends_at = $${params.length}`)
  }
  if (change.end) {
    params.push(change.end)
    sets.push(`status = 'ended', ended_at = $${params.length}`)
  }
  const row = await tx.one<SessionRow>(
    `UPDATE breakout_sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING ${RETURNING}`,
    params,
  )
  return normalize(row)
}

/** The session's members with their names now (users.name: a guest's ends in " (guest)"), oldest assignment first. */
export async function membersOf(q: Queryable, sessionId: string): Promise<MemberRow[]> {
  const r = await q.query<MemberRow>(
    `SELECT m.user_id, u.name, m.group_id
       FROM breakout_members m JOIN users u ON u.id = m.user_id
      WHERE m.session_id = $1
      ORDER BY m.assigned_at, m.user_id`,
    [sessionId],
  )
  return r.rows
}

export async function groupCounts(q: Queryable, sessionId: string): Promise<Map<string, number>> {
  const r = await q.query<{ group_id: string; n: number }>(
    'SELECT group_id, count(*)::int AS n FROM breakout_members WHERE session_id = $1 GROUP BY group_id',
    [sessionId],
  )
  return new Map(r.rows.map((x) => [x.group_id, x.n]))
}

/**
 * Puts people in groups (a move replaces their group). Only ids of existing users are written (a guest swept away
 * meanwhile is left out). Returns how many rows changed.
 */
export async function placeMembers(
  tx: Queryable,
  row: Pick<SessionRow, 'id' | 'workspace_id'>,
  moves: ReadonlyMap<string, string>,
  by: 'auto' | 'facilitator' | 'self',
  at: Date,
): Promise<number> {
  if (moves.size === 0) return 0
  const ids = [...moves.keys()]
  const r = await tx.query(
    `INSERT INTO breakout_members (workspace_id, session_id, user_id, group_id, assigned_by, assigned_at)
     SELECT $1, $2, u.id, p.group_id, $5, $6
       FROM unnest($3::text[], $4::text[]) AS p(user_id, group_id)
       JOIN users u ON u.id = p.user_id
     ON CONFLICT (session_id, user_id) DO UPDATE
       SET group_id = EXCLUDED.group_id, assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at
       WHERE breakout_members.group_id IS DISTINCT FROM EXCLUDED.group_id`,
    [row.workspace_id, row.id, ids, ids.map((u) => moves.get(u) as string), by, at],
  )
  return r.rowCount
}

export async function removeMembers(
  tx: Queryable,
  sessionId: string,
  userIds: readonly string[],
): Promise<number> {
  if (userIds.length === 0) return 0
  const r = await tx.query(
    'DELETE FROM breakout_members WHERE session_id = $1 AND user_id = ANY($2::text[])',
    [sessionId, [...userIds]],
  )
  return r.rowCount
}

export async function clearMembers(tx: Queryable, sessionId: string): Promise<number> {
  const r = await tx.query('DELETE FROM breakout_members WHERE session_id = $1', [sessionId])
  return r.rowCount
}
