// The creator's own owner grant against a member removal, on a real Postgres (PGlite has one connection, so
// two transactions never wait for each other there): set DRAFTROOM_TEST_DATABASE_URL to a database these
// tests may create and drop schemas in. Skipped otherwise. The statement order is checked on PGlite in
// creator-grant.test.ts.
//
// Board creation (POST /api/workspaces/:wid/boards) and createBoardFrom (restore as new, duplicate, import)
// gave the creator an owner grant after an UNLOCKED read of their workspace role. A member removal takes the
// workspace row first, deletes the membership and sweeps the leaver's grants, so one that ran in full between
// that read and assertBoardRoom's workspace-row lock (FOR NO KEY UPDATE) left a new board with an owner grant
// for a person who is no member (wave F's follow-up, wave I item I2). The creation now takes the workspace
// row first and decides the role after it, as the removal does (access.ts requireCreatingRoleLocked: an
// unlocked peek that lets strangers and guests leave without the lock, then the workspace row, then the role
// again).
//
// Each test below stops the REAL route midway (the paused Db in race-support.ts), runs the REAL removal
// against it, lets the first go on and checks the outcome. The duplicate stands for createBoardFrom (restore
// as new and import call the same function). The last two race them at random.
//
// Which tests fail on the old code (the unlocked role read, then assertBoardRoom's lock): the two "runs in
// full" tests (the removal commits between the creation's role read and its lock: the old code answered 201
// with an owner grant for a non-member) and the board creation's "waits at the workspace row, then finds
// nobody" outcome. The two "holds the workspace row" tests, the guest test and the copy's "early room check"
// test pass on the old code as well: they keep the guarantees that did not change (a removal that comes later
// waits and sweeps; the early room check) or check the new one (a guest takes no lock).
//
// NOT RUN where this was written (no Postgres, no Docker on the dev machine): run this file once against a
// Postgres 18 (the CI postgres job, or the NAS container) before relying on the waiting claims below.

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
  paused: PausingDb
  sync: FakeSync
  alice: Client // owns Dev Studio
  bob: Client // a member and a creator: makes the boards, and is the person who is removed
  /** A board of Dev Studio that alice owns and every member may see (workspace_view): what bob duplicates. */
  source: string
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
  const source = await createBoard(alice, DEV_STUDIO, 'Shared board')
  await api.db.query("UPDATE boards SET visibility = 'workspace_view' WHERE id = $1", [source])
  sync.setBoard(source, [...baseRecords(), noteRec('n1', 'live content')])
  return { api, paused, sync, alice, bob, source }
}

const remove = (c: Client, uid: string) => c.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${uid}`)
const create = (c: Client, title = 'New board') =>
  c.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title })
const duplicate = (c: Client, board: string) => c.req('POST', `/api/boards/${board}/duplicate`, {})

const orphans = (api: TestApi, uid: string) => orphanGrants(api.db, DEV_STUDIO, uid)
const membership = (api: TestApi, uid: string) =>
  api.db.maybeOne<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [DEV_STUDIO, uid],
  )
const grantsOf = async (api: TestApi, uid: string) =>
  (
    await api.db.query<{ board_id: string }>('SELECT board_id FROM board_members WHERE user_id = $1', [uid])
  ).rows.map((r) => r.board_id)
const boardsMadeBy = async (api: TestApi, uid: string) =>
  (await api.db.query<{ id: string }>('SELECT id FROM boards WHERE created_by = $1', [uid])).rows.map(
    (r) => r.id,
  )
const sweptCount = async (api: TestApi) =>
  (
    await api.db.one<{ detail: { boardGrantsRemoved: number } }>(
      "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
    )
  ).detail.boardGrantsRemoved

/** bob a plain member again, with no grants and nothing he made. */
async function resetBob(w: World) {
  await w.api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'member'`,
    [DEV_STUDIO, w.bob.userId],
  )
}

// The creator's role read (requireWorkspaceRole): the first statement of the creation's transaction. With
// the fix it is a peek that holds no lock; the lock statement follows (requireCreatingRoleLocked), then the
// same read again.
const ROLE_READ = /SELECT role FROM workspace_members WHERE workspace_id = \$1 AND user_id = \$2/
// the creator's lock on the workspace row (requireCreatingRoleLocked, assertBoardRoom: the removal's differs)
const WORKSPACE_LOCK = /SELECT id FROM workspaces WHERE id = \$1 FOR NO KEY UPDATE/

/** Whether another connection can take the workspace row right now (false: somebody holds it). */
async function rowIsFree(api: TestApi): Promise<boolean> {
  try {
    await api.db.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [DEV_STUDIO])
    return true
  } catch (e) {
    if ((e as { code?: string }).code === '55P03') return false // lock_not_available
    throw e
  }
}

describe.skipIf(!PG)('board creation against a member removal (real Postgres)', () => {
  it('the removal is under way (membership deleted, grants not yet swept): the creation waits at the workspace row, then finds nobody (404)', async () => {
    const w = await world()
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = remove(w.alice, w.bob.userId)
    const pid = await pause.reached
    // The removal holds the workspace row and has deleted bob's membership (not committed): bob's peek still
    // sees the member row, so the creation asks for the workspace row and must wait there, then read again.
    const creating = create(w.bob)
    try {
      expect(await waitedOrFinished(w.api.db, pid, creating)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, created] = await Promise.all([removing, creating])
    expect(removed.statusCode, removed.body).toBe(200)
    // Before the fix the role was read before the lock: the creation went on after the removal's sweep and
    // answered 201 with a board and an owner grant for someone who is no member.
    expect(created.statusCode, created.body).toBe(404)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await boardsMadeBy(w.api, w.bob.userId)).toEqual([])
    expect(await grantsOf(w.api, w.bob.userId)).toEqual([])
  })

  it("a removal runs in full right after the creator's first look at their role: the creation then finds nobody (404)", async () => {
    const w = await world()
    const pause = w.paused.arm(ROLE_READ, 'after')
    const creating = create(w.bob)
    const pid = await pause.reached
    // The peek holds no lock, so the removal is not held up: it commits (membership deleted, grants swept).
    const removing = remove(w.alice, w.bob.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('finished')
    } finally {
      pause.release()
    }
    const [created, removed] = await Promise.all([creating, removing])
    expect(removed.statusCode, removed.body).toBe(200)
    // Before the fix this is the orphan: the role read said member, the removal ran in full, and the creation
    // then took the workspace row and wrote a board and an owner grant (201).
    expect(created.statusCode, created.body).toBe(404)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await boardsMadeBy(w.api, w.bob.userId)).toEqual([])
    expect(await grantsOf(w.api, w.bob.userId)).toEqual([])
  })

  it('the creation holds the workspace row (nothing written yet): the removal waits, then sweeps the new owner grant', async () => {
    const w = await world()
    const pause = w.paused.arm(WORKSPACE_LOCK, 'after')
    const creating = create(w.bob)
    const pid = await pause.reached
    expect(await rowIsFree(w.api), 'a creator holds the workspace row from here on').toBe(false)
    const removing = remove(w.alice, w.bob.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [created, removed] = await Promise.all([creating, removing])
    expect(created.statusCode, created.body).toBe(201)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantsOf(w.api, w.bob.userId)).toEqual([])
    expect(await sweptCount(w.api)).toBe(1) // the owner grant the creation wrote, swept by the removal that waited
  })

  it('a guest-role member never holds the workspace row: it is free while their request is stopped after its role read', async () => {
    const w = await world()
    await w.api.db.query(
      "UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2",
      [DEV_STUDIO, w.bob.userId],
    )
    const pause = w.paused.arm(ROLE_READ, 'after')
    const creating = create(w.bob)
    await pause.reached
    try {
      expect(await rowIsFree(w.api), 'a guest must not hold up everyone else in the workspace').toBe(true)
    } finally {
      pause.release()
    }
    const created = await creating
    expect(created.statusCode, created.body).toBe(403)
    expect(await boardsMadeBy(w.api, w.bob.userId)).toEqual([])
  })

  it('creates against removals at random: nothing answers 5xx (no deadlock) and no orphan grant is left', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      await resetBob(w)
      const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 25))
      const answers = await Promise.all([
        jitter().then(() => remove(w.alice, w.bob.userId)),
        jitter().then(() => create(w.bob, `Round ${i}`)),
      ])
      for (const [k, res] of answers.entries())
        if (res.statusCode >= 500) failures.push(`${k ? 'create' : 'removal'}: ${res.statusCode} ${res.body}`)
      // either order ends the same way: bob is out, with no grant left behind
      expect(await orphans(w.api, w.bob.userId), `round ${i}`).toEqual([])
      expect(await membership(w.api, w.bob.userId), `round ${i}`).toBeNull()
    }
    expect(failures).toEqual([])
  })
})

describe.skipIf(!PG)('createBoardFrom (a duplicate) against a member removal (real Postgres)', () => {
  it('the removal is under way (membership deleted, grants not yet swept): the copy waits at the early room check, then finds nobody (404)', async () => {
    const w = await world()
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = remove(w.alice, w.bob.userId)
    const pid = await pause.reached
    const copying = duplicate(w.bob, w.source)
    try {
      // The copy first asks for room in the workspace (assertBoardRoom, before the seed): the row the removal
      // holds. It waits there, so by the time its transaction reads the role the removal has committed: the
      // same answer as before the fix (this keeps the early check honest; it does not prove the new order).
      expect(await waitedOrFinished(w.api.db, pid, copying)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, copied] = await Promise.all([removing, copying])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(copied.statusCode, copied.body).toBe(404)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await boardsMadeBy(w.api, w.bob.userId)).toEqual([])
    expect(await grantsOf(w.api, w.bob.userId)).toEqual([])
  })

  it("a removal runs in full right after the first look at the creator's role inside the copy's transaction: the copy then finds nobody (404)", async () => {
    const w = await world()
    // the first transaction statement of the copy that reads the creator's role: after the seed
    const pause = w.paused.arm(ROLE_READ, 'after')
    const copying = duplicate(w.bob, w.source)
    const pid = await pause.reached
    // The peek holds no lock, so the removal is not held up: it commits (membership deleted, grants swept).
    const removing = remove(w.alice, w.bob.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('finished')
    } finally {
      pause.release()
    }
    const [copied, removed] = await Promise.all([copying, removing])
    expect(removed.statusCode, removed.body).toBe(200)
    // Before the fix: 201, with a copy and an owner grant for someone who is no member.
    expect(copied.statusCode, copied.body).toBe(404)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await boardsMadeBy(w.api, w.bob.userId)).toEqual([])
    expect(await grantsOf(w.api, w.bob.userId)).toEqual([])
  })

  it('the copy holds the workspace row (nothing written yet): the removal waits, then sweeps the new owner grant', async () => {
    const w = await world()
    // the first transaction statement that takes the workspace row: the copy's, inside its transaction (the
    // early room check runs outside one)
    const pause = w.paused.arm(WORKSPACE_LOCK, 'after')
    const copying = duplicate(w.bob, w.source)
    const pid = await pause.reached
    expect(await rowIsFree(w.api), 'a creator holds the workspace row from here on').toBe(false)
    const removing = remove(w.alice, w.bob.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [copied, removed] = await Promise.all([copying, removing])
    expect(copied.statusCode, copied.body).toBe(201)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await orphans(w.api, w.bob.userId)).toEqual([])
    expect(await membership(w.api, w.bob.userId)).toBeNull()
    expect(await grantsOf(w.api, w.bob.userId)).toEqual([])
    expect(await sweptCount(w.api)).toBe(1) // the copy's owner grant, swept by the removal that waited
  })

  it('copies against removals at random: nothing answers 5xx (no deadlock) and no orphan grant is left', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      await resetBob(w)
      const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 25))
      const answers = await Promise.all([
        jitter().then(() => remove(w.alice, w.bob.userId)),
        jitter().then(() => duplicate(w.bob, w.source)),
      ])
      for (const [k, res] of answers.entries())
        if (res.statusCode >= 500) failures.push(`${k ? 'copy' : 'removal'}: ${res.statusCode} ${res.body}`)
      expect(await orphans(w.api, w.bob.userId), `round ${i}`).toEqual([])
      expect(await membership(w.api, w.bob.userId), `round ${i}`).toBeNull()
    }
    expect(failures).toEqual([])
  })
})
