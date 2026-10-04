// Removing a workspace member against what is in flight for them, on a real Postgres (PGlite has one
// connection, so two transactions never wait for each other there): set DRAFTROOM_TEST_DATABASE_URL to a
// database these tests may create and drop schemas in. Skipped otherwise.
//
// Each test holds one side of the race midway in its own transaction (the steps of the board grant, or of
// the access-request approval, written out as they are in members.ts and access-requests.ts), starts the
// removal through the API, waits until the removal is blocked by it, lets the held side finish, and checks
// what is left: the removal waited, and swept what the held side added. (The first needs the membership
// row read FOR SHARE in members.ts `loadTarget`; the second needs the removal to take the request row before
// it deletes the membership, or the approval's guest-membership insert and the removal wait for each other
// and Postgres kills one.)

import type { Db, Queryable } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { requireBoardAction } from '../src/access.ts'
import { loadTarget } from '../src/routes/members.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

/** Resolves once some backend is waiting for a lock that the connection `pid` holds. */
async function blockedBy(db: Db, pid: number, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const r = await db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
      [pid],
    )
    if (r.n > 0) return
    if (Date.now() > until) throw new Error(`${what} never waited for the held lock`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * Runs `fn` in a transaction on its own connection; `fn` starts the request that must wait and says when
 * to go on. The request's answer is returned after the held transaction committed.
 */
async function holding<T>(
  db: Db,
  fn: (tx: Queryable, pid: number) => Promise<{ started: Promise<T> }>,
): Promise<T> {
  const box: { started?: Promise<T> } = {}
  try {
    await db.transaction(async (tx) => {
      const { pid } = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      box.started = (await fn(tx, pid)).started
    })
  } finally {
    await box.started?.catch(() => {})
  }
  if (!box.started) throw new Error('nothing was started')
  return box.started
}

async function world() {
  api = await createTestApi()
  const alice = await api.login('alice') // Dev Studio owner
  const bob = await api.login('bob') // the member who is removed
  const board = await createBoard(alice, DEV_STUDIO, 'Private board')
  return { api, alice, bob, board }
}
const remove = (c: Client, uid: string) => c.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${uid}`)

describe.skipIf(!PG)('removing a member while something is in flight for them (real Postgres)', () => {
  it('a board grant being given to them (members.ts PUT, midway) is swept by the removal that waited for it', async () => {
    const w = await world()
    const removed = await holding(w.api.db, async (tx, pid) => {
      // the PUT: the board row FOR UPDATE, then the target through loadTarget (membership FOR SHARE) ...
      const access = await requireBoardAction(tx, w.board, w.alice.userId, 'manage_access', {
        forUpdate: true,
      })
      await loadTarget(tx, access, w.bob.userId)
      const started = remove(w.alice, w.bob.userId)
      await blockedBy(w.api.db, pid, 'the removal')
      // ... and the grant itself, before it commits
      await tx.query(
        `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'editor', $3, now())`,
        [w.board, w.bob.userId, w.alice.userId],
      )
      return { started }
    })
    expect(removed.statusCode, removed.body).toBe(200)
    // before the fix the removal did not wait: the grant landed after its sweep and outlived the membership
    const left = await w.api.db.query(
      'SELECT user_id FROM board_members WHERE board_id = $1 AND user_id = $2',
      [w.board, w.bob.userId],
    )
    expect(left.rows).toEqual([])
    expect(
      await w.api.db.maybeOne(
        'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [DEV_STUDIO, w.bob.userId],
      ),
    ).toBeNull()
  })

  it('an access request being approved (midway) is finished first; the grant it made goes with the rest, and nothing deadlocks', async () => {
    const w = await world()
    const request = await w.bob.req('POST', `/api/boards/${w.board}/access-requests`, { role: 'editor' })
    expect(request.statusCode, request.body).toBe(202)
    const id = (
      await w.api.db.one<{ id: string }>(
        "SELECT id FROM access_requests WHERE board_id = $1 AND user_id = $2 AND status = 'pending'",
        [w.board, w.bob.userId],
      )
    ).id
    const removed = await holding(w.api.db, async (tx, pid) => {
      // the approval: the board row, then the request row ...
      await tx.query('SELECT id FROM boards WHERE id = $1 FOR UPDATE', [w.board])
      await tx.query('SELECT id FROM access_requests WHERE id = $1 FOR UPDATE', [id])
      const started = remove(w.alice, w.bob.userId)
      await blockedBy(w.api.db, pid, 'the removal') // waiting for the request row
      // ... the guest-membership insert (a row that exists: no wait, as long as the removal has not
      // deleted it; the DO UPDATE locks it, as in access-requests.ts approve), the grant, and the decision
      // (offboarding-races.pg.test.ts runs the real approval against the real removal)
      await tx.query(
        `INSERT INTO workspace_members AS m (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = m.role`,
        [DEV_STUDIO, w.bob.userId],
      )
      await tx.query(
        `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'editor', $3, now())`,
        [w.board, w.bob.userId, w.alice.userId],
      )
      await tx.query(
        `UPDATE access_requests SET status = 'approved', decided_by = $2, decided_at = now(), role_granted = 'editor'
          WHERE id = $1`,
        [id, w.alice.userId],
      )
      return { started }
    })
    expect(removed.statusCode, removed.body).toBe(200)
    // the approval stands as a decision; its grant and the membership are gone
    expect(
      (await w.api.db.one<{ status: string }>('SELECT status FROM access_requests WHERE id = $1', [id]))
        .status,
    ).toBe('approved')
    expect(
      (
        await w.api.db.query('SELECT 1 FROM board_members WHERE board_id = $1 AND user_id = $2', [
          w.board,
          w.bob.userId,
        ])
      ).rows,
    ).toEqual([])
    expect(
      await w.api.db.maybeOne(
        'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [DEV_STUDIO, w.bob.userId],
      ),
    ).toBeNull()
    const entry = await w.api.db.one<{
      detail: { accessRequestsDenied: number; boardGrantsRemoved: number }
    }>("SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1")
    expect(entry.detail).toMatchObject({ accessRequestsDenied: 0, boardGrantsRemoved: 1 })
  })
})
