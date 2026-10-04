// Wave F, F1: the two board-grant paths wave E left open against a member removal (its follow-ups): the
// transfer of ownership (features/dashboard/sharing.ts) and the grant copy of a keep-sharing duplicate
// (features/history/new-board.ts). Both used to give a grant for a person whose workspace membership they
// had not locked (the transfer: an unlocked read; the copy: no membership join at all), so a removal that
// ran between their read and their insert (membership deleted, their grants swept) left an ORPHAN grant:
// it gives nothing while the person is no member, and comes back to life if they ever join again.
//
// PGlite has one connection, so two transactions never wait for each other here. These tests check what
// can be seen on it: the logic (who gets a copied grant), the order of a transaction's statements (the
// board row, then the membership FOR SHARE, then the grant: access.ts), and the row lock itself, read off
// the membership row's xmax (a row locked by a transaction carries that transaction's id there, also after
// it committed; a row nobody locked carries 0). The interleavings against a real removal are in
// grant-paths.pg.test.ts (set DRAFTROOM_TEST_DATABASE_URL).

import { openTestDb } from '@draftroom/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { singleUseInvite } from './features/dashboard/setup.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from './helpers.ts'
import { orphanGrants } from './race-support.ts'
import { indexOfStatement, type StatementLog, statementLog } from './statement-log.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

interface World {
  api: TestApi
  log: StatementLog
  sync: FakeSync
  alice: Client // owns Dev Studio
  bob: Client // a member: owns the board
  carol: Client // a member
  dave: Client // a member
  erin: Client // not a member (removed from Dev Studio)
  board: string
}

async function world(): Promise<World> {
  const base = await openTestDb()
  const log = statementLog(base)
  const sync = createFakeSync()
  const api = await createTestApi({ db: log.db, deps: { syncInternal: sync } })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const dave = await api.login('dave')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const board = await createBoard(bob, DEV_STUDIO, 'Campaign review')
  sync.setBoard(board, [...baseRecords(), noteRec('n1', 'live content')])
  log.reset()
  return { api, log, sync, alice, bob, carol, dave, erin, board }
}

/** The row lock on a membership: '0' for a row nobody has locked since it was written, else a transaction id. */
async function lockedBy(api: TestApi, c: Client): Promise<string> {
  const r = await api.db.one<{ x: string }>(
    'SELECT xmax::text AS x FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [DEV_STUDIO, c.userId],
  )
  return r.x
}

/**
 * A board's grants in code-unit order of user id, the order the expectations below sort into. Sorted here and not
 * by the database: `ORDER BY user_id` follows the database's collation, which is bytewise on PGlite (C) but
 * linguistic on a Postgres in en_US.utf8 (CI's postgres:18 image), where 'usr_b…' comes before 'usr_Y…'. User ids
 * are random mixed-case base62, so with an ORDER BY here the two- and three-grant checks below failed on a real
 * Postgres whenever the ids' case order disagreed (7 of 10 runs of this file on postgres:18; CI's red "Database tests
 * on Postgres 18 (shard 3 of 3)").
 */
const grantsOf = async (api: TestApi, board: string) =>
  (
    await api.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM board_members WHERE board_id = $1',
      [board],
    )
  ).rows.sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0))

const transfer = (c: Client, board: string, to: Client) =>
  c.req('POST', `/api/boards/${board}/transfer-ownership`, { userId: to.userId })
const duplicate = (c: Client, board: string, body: unknown = {}) =>
  c.req('POST', `/api/boards/${board}/duplicate`, body)

describe('transfer of ownership: the target membership is locked before the grant', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
  })

  it('takes the board row, then the membership FOR SHARE, then writes the grant', async () => {
    const res = await transfer(w.bob, w.board, w.carol)
    expect(res.statusCode, res.body).toBe(200)
    const tx = w.log.transactions.find((t) => indexOfStatement(t, /DO UPDATE SET role = 'owner'/) >= 0)
    expect(tx, 'the transfer ran in one transaction').toBeDefined()
    if (!tx) return
    const board = indexOfStatement(tx, /FROM boards b .* FOR UPDATE OF b/)
    const membership = indexOfStatement(tx, /FROM workspace_members wm .* FOR SHARE OF wm/)
    const grant = indexOfStatement(tx, /INSERT INTO board_members/)
    // Before the fix the target was read without a lock (no FOR SHARE at all).
    expect(membership, tx.statements.join('\n')).toBeGreaterThanOrEqual(0)
    expect(board).toBeGreaterThanOrEqual(0)
    expect(board).toBeLessThan(membership)
    expect(membership).toBeLessThan(grant)
  })

  it("holds a row lock on the target's membership row (and on nobody else's)", async () => {
    expect(await lockedBy(w.api, w.carol)).toBe('0')
    expect((await transfer(w.bob, w.board, w.carol)).statusCode).toBe(200)
    // locked by the transfer's transaction ...
    expect(await lockedBy(w.api, w.carol)).not.toBe('0')
    // ... and not the caller's (or anyone else's) membership
    expect(await lockedBy(w.api, w.bob)).toBe('0')
    expect(await lockedBy(w.api, w.dave)).toBe('0')
  })

  it('a target who left the workspace is a 404 that changes nothing', async () => {
    await w.api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      w.dave.userId,
      DEV_STUDIO,
    ])
    const before = await grantsOf(w.api, w.board)
    expect((await transfer(w.bob, w.board, w.dave)).statusCode).toBe(404)
    expect(await grantsOf(w.api, w.board)).toEqual(before)
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.dave.userId)).toEqual([])
  })

  it('still makes a member an owner and steps the caller down, in one change', async () => {
    const res = await transfer(w.bob, w.board, w.carol)
    expect(res.statusCode, res.body).toBe(200)
    expect(await grantsOf(w.api, w.board)).toEqual(
      [
        { user_id: w.bob.userId, role: 'editor' },
        { user_id: w.carol.userId, role: 'owner' },
      ].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    )
    // a person who is already an owner stays one: nothing to undo, nothing locked wrongly
    expect((await transfer(w.alice, w.board, w.carol)).statusCode).toBe(200)
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.carol.userId)).toEqual([])
  })
})

describe('keep-sharing duplicate: only people who still belong to the workspace get a copied grant', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
    // the grants are written directly: a PUT would lock the grantee's membership row (loadTarget) and spoil the
    // row-lock checks below, which start from rows nobody has locked
    for (const [who, role] of [
      [w.carol, 'editor'],
      [w.dave, 'commenter'],
    ] as const)
      await w.api.db.query(
        `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, now())`,
        [w.board, who.userId, role, w.bob.userId],
      )
    w.log.reset()
  })

  it('does not copy a source grant that outlived its membership (an orphan stays behind, not copied)', async () => {
    // erin left Dev Studio, but her grant on the board is still there (what the wave D/E races could leave)
    await w.api.db.query(
      `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, 'editor', $3, now())`,
      [w.board, w.erin.userId, w.bob.userId],
    )
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.erin.userId)).toEqual([w.board])
    const res = await duplicate(w.bob, w.board, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    const copy = (res.json() as { board: { id: string } }).board.id
    // before the fix the copy had erin as well: a second orphan grant, on the new board
    expect(await grantsOf(w.api, copy)).toEqual(
      [
        { user_id: w.bob.userId, role: 'owner' },
        { user_id: w.carol.userId, role: 'editor' },
        { user_id: w.dave.userId, role: 'commenter' },
      ].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    )
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.erin.userId)).toEqual([w.board])
  })

  it('still copies a workspace guest (a member with the guest role) who holds a grant', async () => {
    // erin accepts a single-use link to the board: a workspace guest with an editor grant
    const invite = await singleUseInvite(w.bob, w.board, 'editor', devEmail('erin'))
    const token = invite.url.slice(invite.url.lastIndexOf('/') + 1)
    expect((await w.erin.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect(
      (
        await w.api.db.one<{ role: string }>(
          'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
          [DEV_STUDIO, w.erin.userId],
        )
      ).role,
    ).toBe('guest')
    const res = await duplicate(w.bob, w.board, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    const copy = (res.json() as { board: { id: string } }).board.id
    expect((await grantsOf(w.api, copy)).map((g) => [g.user_id, g.role]).sort()).toEqual(
      [
        [w.bob.userId, 'owner'],
        [w.carol.userId, 'editor'],
        [w.dave.userId, 'commenter'],
        [w.erin.userId, 'editor'],
      ].sort(),
    )
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.erin.userId)).toEqual([])
  })

  it('reads the memberships it copies FOR SHARE, before it writes any copied grant', async () => {
    expect((await duplicate(w.bob, w.board, { keepSharing: true })).statusCode).toBe(201)
    const tx = w.log.transactions.find((t) => indexOfStatement(t, /INSERT INTO boards/) >= 0)
    expect(tx, 'the copy ran in one transaction').toBeDefined()
    if (!tx) return
    const lock = indexOfStatement(tx, /JOIN workspace_members wm .* FOR SHARE OF wm/)
    expect(lock, tx.statements.join('\n')).toBeGreaterThanOrEqual(0)
    // the owner's own grant is the first INSERT INTO board_members; the copy of the others comes after the lock
    const firstGrant = indexOfStatement(tx, /INSERT INTO board_members/)
    const copied = indexOfStatement(tx, /INSERT INTO board_members/, firstGrant + 1)
    expect(copied).toBeGreaterThan(lock)
  })

  it('holds a row lock on each copied grantee (and on nobody the copy does not give a grant)', async () => {
    // frank is a member with no grant on the board: the copy has no reason to touch his membership
    const frank = await w.api.login('frank')
    for (const c of [w.carol, w.dave, frank]) expect(await lockedBy(w.api, c)).toBe('0')
    expect((await duplicate(w.bob, w.board, { keepSharing: true })).statusCode).toBe(201)
    expect(await lockedBy(w.api, w.carol)).not.toBe('0')
    expect(await lockedBy(w.api, w.dave)).not.toBe('0')
    expect(await lockedBy(w.api, frank)).toBe('0')
  })

  it('a plain duplicate (no sharing) copies no grant and locks no membership', async () => {
    const res = await duplicate(w.bob, w.board)
    expect(res.statusCode, res.body).toBe(201)
    const copy = (res.json() as { board: { id: string } }).board.id
    expect(await grantsOf(w.api, copy)).toEqual([{ user_id: w.bob.userId, role: 'owner' }])
    expect(await lockedBy(w.api, w.carol)).toBe('0')
  })
})
