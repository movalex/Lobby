// Wave V follow-up (gate review u2): a person who loses access to a board leaves its running breakouts in the same
// transaction as the loss, and an open activity there takes no more answers from them.
//
// Every transaction that can take someone's view of a board away (a board member removed, a workspace member removed
// or lowered to guest, a link revoked or expired that removes its guests, a guest's grants swept, a board's
// visibility lowered) calls, in this order:
//   1. `lockForAccessLoss` at step 2 of the lock order (apps/api/src/access.ts: after the workspace and board rows,
//      before any membership, grant or guest user row). It locks the running breakout sessions and the open activities
//      in its scope, FOR UPDATE: the rows every placement in a group (breakouts/index.ts `change`, under the session's
//      row lock) and every answer (live-activities `answer`, under the activity's row lock) take before they re-check
//      the person's access inside their own transaction;
//   2. its own change of grants, memberships or visibility;
//   3. `dropLostMembers`, which re-reads every member of those sessions (in its scope) against the access this
//      transaction now leaves, deletes the members who may no longer view the board, and moves those sessions' `rev`.
// So a placement or an answer either commits before the loss (the loss then waits for its row and removes the
// placement; the answer was given while they had access and counts) or runs after it and sees the access gone (assign
// is refused; dealing, a late join and a self-join leave the person out; the answer is refused). Start makes a session
// no loss can lock yet: it deals under the board row lock and sweeps itself once more after its COMMIT
// (breakouts/index.ts).
//
// The board ids returned are the ones whose session changed: the caller tells them (notifier.accessChanged, after
// COMMIT), which the breakouts feature hears through the event hub and answers with the session's new state.
// Ended sessions keep their members (the session summary's record of who was in which group).

import type { Queryable } from '@draftroom/db'
import { can } from '@draftroom/permissions'
import { loadBoardAccessMany, pairKey } from '../../access.ts'

/** One board (everyone on it, or only `userIds`), or `userIds` on every board of a workspace, or anywhere. */
export type AccessLossScope =
  | { readonly boardId: string; readonly userIds?: readonly string[] }
  | { readonly workspaceId: string; readonly userIds: readonly string[] }
  | { readonly anywhere: true; readonly userIds: readonly string[] }

export interface AccessLossLocks {
  readonly scope: AccessLossScope
  readonly sessions: readonly { id: string; board_id: string }[]
}

const usersOf = (scope: AccessLossScope): string[] | null =>
  scope.userIds === undefined ? null : [...new Set(scope.userIds)]

/** Step 2 of the lock order: the running sessions and open activities the loss may touch, locked in id order. */
export async function lockForAccessLoss(tx: Queryable, scope: AccessLossScope): Promise<AccessLossLocks> {
  const users = usersOf(scope)
  if (users !== null && users.length === 0) return { scope, sessions: [] }
  // EVERY running session of the scope's boards, whoever is in it now: a placement of these people that has not
  // committed yet is invisible here, and only the lock makes it wait or be waited for (a filter on the current members
  // would leave exactly that session unlocked; the real-Postgres test caught it). At most one per board.
  // `anywhere` (a guest's grants swept): the boards they hold a grant on, the only ones such a guest can be on.
  const boards =
    'boardId' in scope
      ? { sql: 'board_id = $1', key: scope.boardId as unknown }
      : 'workspaceId' in scope
        ? { sql: 'workspace_id = $1', key: scope.workspaceId as unknown }
        : {
            sql: 'board_id IN (SELECT bm.board_id FROM board_members bm WHERE bm.user_id = ANY($1::text[]))',
            key: users as unknown,
          }
  const sessions = await tx.query<{ id: string; board_id: string }>(
    `SELECT id, board_id FROM breakout_sessions
      WHERE ${boards.sql} AND status = 'running'
      ORDER BY id
        FOR UPDATE`,
    [boards.key],
  )
  await tx.query(
    `SELECT id FROM live_activities WHERE ${boards.sql} AND status = 'open' ORDER BY id FOR UPDATE`,
    [boards.key],
  )
  return { scope, sessions: sessions.rows }
}

/**
 * Step 3: deletes the members of the locked sessions (those in the scope's `userIds`, or all) who may no longer view
 * the board as this transaction leaves it, and moves each changed session's `rev`. Returns the changed boards' ids.
 */
export async function dropLostMembers(tx: Queryable, locks: AccessLossLocks): Promise<string[]> {
  if (locks.sessions.length === 0) return []
  const users = usersOf(locks.scope)
  const members = await tx.query<{ session_id: string; board_id: string; user_id: string }>(
    `SELECT m.session_id, s.board_id, m.user_id
       FROM breakout_members m JOIN breakout_sessions s ON s.id = m.session_id
      WHERE m.session_id = ANY($1::text[]) AND ($2::text[] IS NULL OR m.user_id = ANY($2::text[]))
      ORDER BY m.session_id, m.user_id`,
    [locks.sessions.map((s) => s.id), users],
  )
  if (members.rows.length === 0) return []
  const access = await loadBoardAccessMany(
    tx,
    members.rows.map((m) => ({ boardId: m.board_id, userId: m.user_id })),
  )
  const lost = new Map<string, { boardId: string; userIds: string[] }>()
  for (const m of members.rows) {
    const a = access.get(pairKey({ boardId: m.board_id, userId: m.user_id }))
    if (a && can(a.role, 'view', a.board.status)) continue
    const entry = lost.get(m.session_id) ?? { boardId: m.board_id, userIds: [] }
    entry.userIds.push(m.user_id)
    lost.set(m.session_id, entry)
  }
  const boards = new Set<string>()
  for (const [sessionId, { boardId, userIds }] of lost) {
    await tx.query('DELETE FROM breakout_members WHERE session_id = $1 AND user_id = ANY($2::text[])', [
      sessionId,
      userIds,
    ])
    await tx.query('UPDATE breakout_sessions SET rev = rev + 1 WHERE id = $1', [sessionId])
    boards.add(boardId)
  }
  return [...boards]
}
