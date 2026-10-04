// The transfer of ownership and the grant copy of a keep-sharing duplicate against a member removal, on a
// real Postgres (PGlite has one connection, so two transactions never wait for each other there): set
// DRAFTROOM_TEST_DATABASE_URL to a database these tests may create and drop schemas in. Skipped otherwise.
// The logic and the lock statements are checked on PGlite in grant-paths.test.ts.
//
// Wave E made every path that gives a grant to "a member" take the membership row first (FOR SHARE, or a
// no-op DO UPDATE) and the grant after it, because a removal (routes/workspaces.ts) deletes the membership
// and then sweeps the grants: it waits for the grant being given and sweeps it, or goes first and the grant
// finds nobody. Two paths were left (wave E follow-ups, F1):
//   - POST /api/boards/:bid/transfer-ownership read the target's membership without a lock, then inserted
//     the owner grant: a removal that ran in full between the two left an orphan grant;
//   - the grant copy of POST /api/boards/:bid/duplicate (keepSharing) joined no membership at all.
// Each test below stops the REAL route midway (the paused Db in race-support.ts), runs the REAL removal
// against it, lets the first go on and checks the outcome. Only the last-but-one models a removal that does
// not take the workspace row first (every route's does), as a plain transaction: the copy must not depend
// on the workspace row that assertBoardRoom happens to hold. The last two race them at random.

import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'
import { orphanGrants, type PausingDb, pausingDb, waitedOrFinished } from './race-support.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 10)

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

interface World {
  api: TestApi
  /** The pool underneath the paused Db: for what must not be paused (a removal made by hand). */
  base: Db
  paused: PausingDb
  sync: FakeSync
  alice: Client // owns Dev Studio, and so every board of it
  bob: Client // a member: the person who is removed
  /** A private board of Dev Studio that alice owns. */
  board: string
}

async function world(): Promise<World> {
  const base = await openTestDb()
  const paused = pausingDb(base)
  const sync = createFakeSync()
  const api = await createTestApi({ db: paused.db, deps: { syncInternal: sync } })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const board = await createBoard(alice, DEV_STUDIO, 'Private board')
  sync.setBoard(board, [...baseRecords(), noteRec('n1', 'live content')])
  return { api, base, paused, sync, alice, bob, board }
}

const remove = (c: Client, uid: string) => c.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${uid}`)
const transfer = (c: Client, board: string, to: Client) =>
  c.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: to.userId })
const duplicate = (c: Client, board: string) =>
  c.req('POST', `/api/boards/${board}/duplicate`, { keepSharing: true })

const orphans = (api: TestApi, uid: string) => orphanGrants(api.db, DEV_STUDIO, uid)

const membership = (api: TestApi, uid: string) =>
  api.db.maybeOne<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [DEV_STUDIO, uid],
  )
const grantOf = (api: TestApi, board: string, uid: string) =>
  api.db.maybeOne<{ role: string }>('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [
    board,
    uid,
  ])
const giveGrant = (api: TestApi, board: string, c: Client, role: string, by: Client) =>
  api.db.query(
    `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [board, c.userId, role, by.userId],
  )
const sweptCount = async (api: TestApi) =>
  (
    await api.db.one<{ detail: { boardGrantsRemoved: number } }>(
      "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
    )
  ).detail.boardGrantsRemoved
const copyOf = (res: { json(): unknown }) => (res.json() as { board: { id: string } }).board.id

/** A membership removal that takes no workspace row (the routes' removal always does): the membership, then the sweep. */
const rawRemoval = (base: Db, uid: string) =>
  base.transaction(async (tx) => {
    await tx.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      uid,
    ])
    await tx.query(
      `DELETE FROM board_members bm USING boards b
        WHERE bm.board_id = b.id AND b.workspace_id = $1 AND bm.user_id = $2`,
      [DEV_STUDIO, uid],
    )
  })

describe.skipIf(!PG)('transfer of ownership against a member removal (real Postgres)', () => {
  it('the transfer holds the target membership (read, grant not yet written): the removal waits, then sweeps the new owner grant', async () => {
    const w = await world()
    // stops once the target's membership has been read FOR SHARE (members.ts loadTarget): its lock is held
    const pause = w.paused.arm(/FOR SHARE OF wm/, 'after')
    const transferring = transfer(w.alice, w.board, w.bob)
    const pid = await pause.reached
    const removing = remove(w.alice, w.bob.userId)
    try {
      // The removal deletes the membership row the transfer holds, so it waits for the transfer to commit.
      // Before the fix the read took no lock: the removal ran in full (membership, sweep) and the owner
      // grant was written after it, for someone who is no member.
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [transferred, removed] = await Promise.all([transferring, removing])
    expect(transferred.statusCode, transferred.body).toBe(200)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantOf(w.api, w.board, w.bob.userId)).toBeNull()
    expect(await sweptCount(w.api)).toBe(1) // the grant the transfer made, swept by the removal that waited
  })

  it('the removal holds the membership (deleted, grants not yet swept): the transfer waits, then finds nobody (404)', async () => {
    const w = await world()
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = remove(w.alice, w.bob.userId)
    const pid = await pause.reached
    // The pre-check (unlocked) still sees the member: the transaction's locked read is what must wait.
    const transferring = transfer(w.alice, w.board, w.bob)
    try {
      expect(await waitedOrFinished(w.api.db, pid, transferring)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, transferred] = await Promise.all([removing, transferring])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(transferred.statusCode, transferred.body).toBe(404)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantOf(w.api, w.board, w.bob.userId)).toBeNull()
  })

  it('transfers against removals at random: nothing answers 5xx (no deadlock) and no orphan grant is left', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      // bob a plain member again, without a grant
      await w.api.db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
        [DEV_STUDIO, w.bob.userId],
      )
      await w.api.db.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [
        w.board,
        w.bob.userId,
      ])
      const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 25))
      const answers = await Promise.all([
        jitter().then(() => remove(w.alice, w.bob.userId)),
        jitter().then(() => transfer(w.alice, w.board, w.bob)),
      ])
      for (const [k, res] of answers.entries())
        if (res.statusCode >= 500)
          failures.push(`${k ? 'transfer' : 'removal'}: ${res.statusCode} ${res.body}`)
      // either order ends the same way: bob is out, with nothing left behind
      expect(await orphans(w.api, w.bob.userId), `round ${i}`).toEqual([])
      expect(await membership(w.api, w.bob.userId), `round ${i}`).toBeNull()
    }
    expect(failures).toEqual([])
  })
})

describe.skipIf(!PG)('keep-sharing duplicate against a member removal (real Postgres)', () => {
  it('the copy is under way (it holds the workspace row): the removal waits for it and sweeps the copied grant', async () => {
    const w = await world()
    await giveGrant(w.api, w.board, w.bob, 'editor', w.alice)
    // stops right after the copy's board row is written: the workspace row (assertBoardRoom) is held
    const pause = w.paused.arm(/INSERT INTO boards/, 'after')
    const duplicating = duplicate(w.alice, w.board)
    const pid = await pause.reached
    const removing = remove(w.alice, w.bob.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [copied, removed] = await Promise.all([duplicating, removing])
    expect(copied.statusCode, copied.body).toBe(201)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await grantOf(w.api, copyOf(copied), w.bob.userId)).toBeNull()
    expect(await sweptCount(w.api)).toBe(2) // bob's grant on the source and on the copy
  })

  it('the removal came first (membership deleted, grants not yet swept): the copy waits, and bob is not on it', async () => {
    const w = await world()
    await giveGrant(w.api, w.board, w.bob, 'editor', w.alice)
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = remove(w.alice, w.bob.userId)
    const pid = await pause.reached
    const duplicating = duplicate(w.alice, w.board)
    try {
      // the copy asks for room in the workspace (the workspace row the removal holds) before it copies anything
      expect(await waitedOrFinished(w.api.db, pid, duplicating)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, copied] = await Promise.all([removing, duplicating])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(copied.statusCode, copied.body).toBe(201)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await grantOf(w.api, copyOf(copied), w.bob.userId)).toBeNull()
  })

  it('a membership deleted by a path that takes no workspace row, while the copy has read it: the deletion waits and sweeps the copied grant', async () => {
    const w = await world()
    await giveGrant(w.api, w.board, w.bob, 'editor', w.alice)
    // stops once the copy has read its grantees' memberships FOR SHARE (their locks are held)
    const pause = w.paused.arm(/FOR SHARE OF wm/, 'after')
    const duplicating = duplicate(w.alice, w.board)
    const pid = await pause.reached
    const removing = rawRemoval(w.base, w.bob.userId)
    try {
      // Before the fix the copy locked no membership: the deletion and its sweep ran in full here, and the
      // copied grant was written after them, for someone who is no member.
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [copied] = await Promise.all([duplicating, removing])
    expect(copied.statusCode, copied.body).toBe(201)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantOf(w.api, copyOf(copied), w.bob.userId)).toBeNull()
  })

  it('copies against removals at random: nothing answers 5xx (no deadlock) and no orphan grant is left', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      // bob a member again, with a grant on the source board
      await w.api.db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
        [DEV_STUDIO, w.bob.userId],
      )
      await giveGrant(w.api, w.board, w.bob, 'editor', w.alice)
      const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 25))
      const answers = await Promise.all([
        jitter().then(() => remove(w.alice, w.bob.userId)),
        jitter().then(() => duplicate(w.alice, w.board)),
      ])
      for (const [k, res] of answers.entries())
        if (res.statusCode >= 500) failures.push(`${k ? 'copy' : 'removal'}: ${res.statusCode} ${res.body}`)
      expect(await orphans(w.api, w.bob.userId), `round ${i}`).toEqual([])
    }
    expect(failures).toEqual([])
  })
})
