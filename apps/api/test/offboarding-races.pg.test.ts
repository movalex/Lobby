// Removing a workspace member against the same person being GIVEN access, on a real Postgres (PGlite has
// one connection, so two transactions never wait for each other there): set DRAFTROOM_TEST_DATABASE_URL to
// a database these tests may create and drop schemas in. Skipped otherwise.
//
// Wave D's removal takes the workspace_members row and then the board_members rows; the paths that give
// access (accepting a multi-use link, approving an access request) used to take them the other way round
// or not at all (redeemInvitation read its `prior` grant FOR UPDATE and only then inserted the guest
// membership ON CONFLICT DO NOTHING). Two failures followed (wave D review, D4 item 1):
//   1. a DEADLOCK: a removal that deleted the membership and waited for the grant row, against a redeem that
//      held that grant row and waited for the deleted membership row (one side answered 500);
//   2. an ORPHAN grant: the redeem passed its membership step without locking the row, a removal ran in
//      full (membership and sweep), and the redeem's grant landed afterwards: a grant of a person who is
//      no member, which comes back to life if they ever join the workspace again.
// Both go away when every path takes the membership row first (a no-op DO UPDATE locks it) and the grant
// after it. Each test below stops the REAL access-giving route midway (the paused Db in race-support.ts),
// runs the REAL removal route against it, lets the first go on and checks the outcome; one stops the
// removal instead (after it has deleted the membership), which with the old order was an actual deadlock
// and not only its precursor. The last one races them at random.

import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { guestLink, tokenOf } from './features/guests/support.ts'
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
  paused: PausingDb
  alice: Client // owns Dev Studio
  bob: Client // a member of it: the person who is removed
  /** A private board of Dev Studio that alice owns. */
  board: string
}

async function world(): Promise<World> {
  const base = await openTestDb()
  const paused = pausingDb(base)
  const api = await createTestApi({ db: paused.db })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const board = await createBoard(alice, DEV_STUDIO, 'Private board')
  return { api, paused, alice, bob, board }
}

const remove = (c: Client, uid: string) => c.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${uid}`)
const accept = (c: Client, token: string) => c.req('POST', `/api/invitations/${token}/accept`)

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

const MEMBERSHIP_INSERT = /INSERT INTO workspace_members/

describe.skipIf(!PG)('removing a member while they are given access (real Postgres)', () => {
  it('a removal against the same person accepting a multi-use link they already hold a grant through: no deadlock (D4 item 1)', async () => {
    const w = await world()
    const link = await guestLink(w.alice, w.board, { role: 'viewer' })
    const token = tokenOf(link.url)
    expect((await accept(w.bob, token)).statusCode).toBe(200) // bob holds a grant on the board now

    // Bob accepts again, and the accept stops just before it takes the guest membership: where it used to
    // hold the grant row (its `prior` read) and then waited for the membership row ...
    const pause = w.paused.arm(MEMBERSHIP_INSERT, 'before')
    const accepting = accept(w.bob, token)
    const pid = await pause.reached
    // ... the removal now deletes the membership and goes for the grant rows.
    const removing = remove(w.alice, w.bob.userId)
    try {
      // The accept holds the workspace row (lockInvitation takes it first for every redemption since the
      // Internal only race test, internal-only-locks.pg.test.ts), the board and the link, and nothing the
      // removal would need after them: the removal waits at the workspace row, its first lock, holding
      // nothing. Before D4's fix it waited for the grant row the accept held while the accept waited for the
      // membership: the two deadlocked. (Between those two fixes the removal ran to its end here.)
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, accepted] = await Promise.all([removing, accepting])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(accepted.statusCode, accepted.body).toBe(200)
    // The removal came after the accept and swept what it gave: bob is out, with nothing orphaned
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantOf(w.api, w.board, w.bob.userId)).toBeNull()
  })

  it('the removal held first: it has deleted the membership but not swept the grants, and the same person accepts: the accept waits, then both finish and nothing is orphaned', async () => {
    const w = await world()
    const link = await guestLink(w.alice, w.board, { role: 'viewer' })
    const token = tokenOf(link.url)
    expect((await accept(w.bob, token)).statusCode).toBe(200) // bob holds a grant on the board

    // The removal stops right after its DELETE of the membership row: the row is gone but uncommitted, and
    // the grant rows are still there to be swept.
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = remove(w.alice, w.bob.userId)
    const pid = await pause.reached
    const accepting = accept(w.bob, token)
    try {
      // The accept goes for the membership row first, which the removal holds. Before the fix it read its
      // `prior` grant FOR UPDATE first, and then the removal's sweep waited for that grant row while the
      // accept waited for the membership: a deadlock (one of the two answered 500).
      expect(await waitedOrFinished(w.api.db, pid, accepting)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, accepted] = await Promise.all([removing, accepting])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(accepted.statusCode, accepted.body).toBe(200)
    // the accept came after the removal and joined bob again as a guest, with the link's grant
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toEqual({ role: 'guest' })
    expect(await grantOf(w.api, w.board, w.bob.userId)).toEqual({ role: 'viewer' })
    const entry = await w.api.db.one<{ detail: { boardGrantsRemoved: number } }>(
      "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
    )
    expect(entry.detail.boardGrantsRemoved).toBe(1) // the grant bob held when the removal began
  })

  it('a removal against a member accepting a multi-use link (guest membership step done): it waits, then sweeps the grant (D4 item 1)', async () => {
    const w = await world()
    const link = await guestLink(w.alice, w.board, { role: 'viewer' })
    // Bob is a member without a grant on this board; the accept stops once its membership step has run
    const pause = w.paused.arm(MEMBERSHIP_INSERT, 'after')
    const accepting = accept(w.bob, tokenOf(link.url))
    const pid = await pause.reached
    const removing = remove(w.alice, w.bob.userId)
    try {
      // The membership step took the row (a no-op DO UPDATE), so the removal waits for the accept to commit.
      // Before the fix (DO NOTHING) it took no lock: the removal ran in full here and the grant landed after it.
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, accepted] = await Promise.all([removing, accepting])
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantOf(w.api, w.board, w.bob.userId)).toBeNull()
    const entry = await w.api.db.one<{ detail: { boardGrantsRemoved: number } }>(
      "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
    )
    expect(entry.detail.boardGrantsRemoved).toBe(1)
  })

  it('a removal against an access request being approved (guest membership step done): the request row orders them; the grant goes with the rest', async () => {
    const w = await world()
    const asked = await w.bob.req('POST', `/api/boards/${w.board}/access-requests`, { role: 'editor' })
    expect(asked.statusCode, asked.body).toBe(202)
    const id = (
      await w.api.db.one<{ id: string }>(
        "SELECT id FROM access_requests WHERE board_id = $1 AND user_id = $2 AND status = 'pending'",
        [w.board, w.bob.userId],
      )
    ).id
    const pause = w.paused.arm(MEMBERSHIP_INSERT, 'after')
    const approving = w.alice.req('POST', `/api/access-requests/${id}/approve`, { role: 'editor' })
    const pid = await pause.reached
    const removing = remove(w.alice, w.bob.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, approved] = await Promise.all([removing, approving])
    expect(approved.statusCode, approved.body).toBe(200)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(
      (await w.api.db.one<{ status: string }>('SELECT status FROM access_requests WHERE id = $1', [id]))
        .status,
    ).toBe('approved')
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantOf(w.api, w.board, w.bob.userId)).toBeNull()
  })

  it('removals against accepts at random, with and without a grant to start from: no 5xx (no deadlock) and no orphan grant', async () => {
    const w = await world()
    const link = await guestLink(w.alice, w.board, { role: 'viewer' })
    const token = tokenOf(link.url)
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      // bob a plain member again, with a grant on every other round
      await w.api.db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
        [DEV_STUDIO, w.bob.userId],
      )
      await w.api.db.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [
        w.board,
        w.bob.userId,
      ])
      if (i % 2)
        await w.api.db.query(
          `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'viewer', $3, now())`,
          [w.board, w.bob.userId, w.alice.userId],
        )
      const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 25))
      const answers = await Promise.all([
        jitter().then(() => remove(w.alice, w.bob.userId)),
        jitter().then(() => accept(w.bob, token)),
      ])
      for (const [k, res] of answers.entries())
        if (res.statusCode >= 500) failures.push(`${k ? 'accept' : 'removal'}: ${res.statusCode} ${res.body}`)
      // a person who was removed and then accepted again is a guest with a grant; one removed last has neither
      expect(await orphans(w.api, w.bob.userId), `round ${i}`).toEqual([])
    }
    expect(failures).toEqual([])
  })
})
