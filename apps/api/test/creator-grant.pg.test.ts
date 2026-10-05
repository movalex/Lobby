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
// row first and reads the role after it, as the removal does (access.ts, the lock order).
//
// Each test below stops the REAL route midway (the paused Db in race-support.ts), runs the REAL removal
// against it, lets the first go on and checks the outcome. The duplicate stands for createBoardFrom (restore
// as new and import call the same function). The last two race them at random.

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

// the creator's role read (requireWorkspaceRole): the first thing the old code did in the transaction
const ROLE_READ = /SELECT role FROM workspace_members WHERE workspace_id = \$1 AND user_id = \$2/

describe.skipIf(!PG)('board creation against a member removal (real Postgres)', () => {
  it('the removal is under way (membership deleted, grants not yet swept): the creation waits, then finds nobody (404)', async () => {
    const w = await world()
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = remove(w.alice, w.bob.userId)
    const pid = await pause.reached
    // The removal holds the workspace row and has deleted bob's membership (not committed): bob's creation
    // still sees the member row, so it asks for the workspace row and must wait there, then re-read.
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

  it('the creation read the role and holds the workspace row (nothing written yet): the removal waits, then sweeps the new owner grant', async () => {
    const w = await world()
    const pause = w.paused.arm(ROLE_READ, 'after')
    const creating = create(w.bob)
    const pid = await pause.reached
    const removing = remove(w.alice, w.bob.userId)
    try {
      // Before the fix the role read took no lock: the removal ran in full (membership, sweep) right here and
      // the owner grant was written after it.
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
  it('the removal is under way (membership deleted, grants not yet swept): the copy waits, then finds nobody (404)', async () => {
    const w = await world()
    const pause = w.paused.arm(/DELETE FROM workspace_members/, 'after')
    const removing = remove(w.alice, w.bob.userId)
    const pid = await pause.reached
    const copying = duplicate(w.bob, w.source)
    try {
      // the copy first asks for room in the workspace (assertBoardRoom, before the seed): the row the removal holds
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

  it('the copy read the role and holds the workspace row (nothing written yet): the removal waits, then sweeps the new owner grant', async () => {
    const w = await world()
    // the first transaction statement of the copy that reads the creator's role: after the seed, inside the transaction
    const pause = w.paused.arm(ROLE_READ, 'after')
    const copying = duplicate(w.bob, w.source)
    const pid = await pause.reached
    const removing = remove(w.alice, w.bob.userId)
    try {
      // Before the fix the role read took no lock: the removal ran in full here, and the copy's owner grant
      // was written after it, for someone who is no member.
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
