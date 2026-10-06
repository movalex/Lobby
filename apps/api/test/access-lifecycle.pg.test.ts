// Wave J, J2 on a real Postgres (PGlite has one connection, so two transactions never wait for each other
// there): set DRAFTROOM_TEST_DATABASE_URL to a database these tests may create and drop schemas in. Skipped
// otherwise.
//
// J2 made two removals take more rows, and both must keep the lock order of access.ts (the workspace row,
// the board row, rows of the board, the membership, the grants), or a removal and a path that gives access
// deadlock (one side a 500) or leave access behind:
//   - a BOARD removal (routes/members.ts DELETE) now denies the person's pending request for the board and
//     revokes the unused invitations to it addressed to them (INV-5, INV-3), after the board row and before
//     their membership row; an approval and an accept take the board row first too, so they queue on it;
//   - a WORKSPACE removal (routes/workspaces.ts) now also revokes the unused invitations addressed to the
//     leaver (INV-3), with the other invitation rows it takes, before it deletes the membership; an accept
//     holds its invitation row before it takes the membership, so the removal waits for it and then finds
//     it used (and sweeps the grant it gave), or holds it first and the accept finds it revoked (410).
// Each test stops the REAL route of one side midway (the paused Db in race-support.ts), runs the REAL other
// route against it, lets the first go on, and checks the outcome. The ones marked "(fails without J2)"
// end with access the removal should have ended when the J2 change is reverted; the others pin that the
// new statements wait in the right place and never deadlock. Then the per-board request cap (INV-6) under
// simultaneous requests, and a random round of all of it.

import { InvitationCreated } from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCESS_REQUEST_BOARD_LIMIT } from '../src/features/dashboard/access-requests.ts'
import { guestLink, tokenOf } from './features/guests/support.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from './helpers.ts'
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
  bob: Client // a member, a creator: owns `board`
  carol: Client // a member
  erin: Client // an outsider with an account
  /** A private board of Dev Studio that bob owns. */
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
  const carol = await api.login('carol')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const board = await createBoard(bob, DEV_STUDIO, 'Private board')
  return { api, paused, alice, bob, carol, erin, board }
}

const MEMBERSHIP_INSERT = /INSERT INTO workspace_members/
const BOARD_REQUEST_DENIAL = /UPDATE access_requests SET status = 'denied'/
const BOARD_INVITE_REVOKE = /UPDATE invitations SET revoked_at = \$4/
const WORKSPACE_INVITE_REVOKE = /invited_email = ANY/

const removeFromBoard = (c: Client, board: string, uid: string) =>
  c.req('DELETE', `/api/boards/${board}/members/${uid}`)
const removeFromWorkspace = (c: Client, uid: string) =>
  c.req('DELETE', `/api/workspaces/${DEV_STUDIO}/members/${uid}`)
const accept = (c: Client, url: string) => c.req('POST', `/api/invitations/${tokenOf(url)}/accept`)

async function invite(c: Client, path: string, body: Record<string, unknown>) {
  const res = await c.req('POST', path, body)
  expect(res.statusCode, res.body).toBe(201)
  return InvitationCreated.parse(res.json())
}
const boardInvite = (c: Client, board: string, role: string, to: Client) =>
  invite(c, `/api/boards/${board}/invitations`, { role, email: devEmail(to.me.user.name) })

const grantOf = async (api: TestApi, board: string, uid: string) =>
  (
    await api.db.maybeOne<{ role: string }>(
      'SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2',
      [board, uid],
    )
  )?.role ?? null
const membership = async (api: TestApi, uid: string) =>
  (
    await api.db.maybeOne<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [DEV_STUDIO, uid],
    )
  )?.role ?? null
const statusOf = async (api: TestApi, id: string) =>
  (await api.db.one<{ status: string }>('SELECT status FROM access_requests WHERE id = $1', [id])).status
const invitationState = async (api: TestApi, id: string) =>
  api.db.one<{ revoked: boolean; used: boolean }>(
    'SELECT revoked_at IS NOT NULL AS revoked, redeemed_by IS NOT NULL AS used FROM invitations WHERE id = $1',
    [id],
  )

async function pendingRequest(w: World, c: Client, role = 'editor'): Promise<string> {
  const asked = await c.req('POST', `/api/boards/${w.board}/access-requests`, { role })
  expect(asked.statusCode, asked.body).toBe(202)
  return (
    await w.api.db.one<{ id: string }>(
      "SELECT id FROM access_requests WHERE board_id = $1 AND user_id = $2 AND status = 'pending'",
      [w.board, c.userId],
    )
  ).id
}

describe.skipIf(!PG)('J2: removals against the paths that give access (real Postgres)', () => {
  it('a board removal against an approval of the person’s request (its membership step done): it waits; the grant goes', async () => {
    const w = await world()
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
    const id = await pendingRequest(w, w.carol)
    const pause = w.paused.arm(MEMBERSHIP_INSERT, 'after')
    const approving = w.alice.req('POST', `/api/access-requests/${id}/approve`, {})
    const pid = await pause.reached
    const removing = removeFromBoard(w.bob, w.board, w.carol.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [approved, removed] = await Promise.all([approving, removing])
    expect(approved.statusCode, approved.body).toBe(200)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await statusOf(w.api, id)).toBe('approved')
    expect(await grantOf(w.api, w.board, w.carol.userId)).toBeNull()
  })

  it('(fails without J2) the board removal held first, its request denial done: the approval waits, then finds it answered (409) and grants nothing', async () => {
    const w = await world()
    expect(
      (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'viewer' }))
        .statusCode,
    ).toBe(200)
    const id = await pendingRequest(w, w.carol)
    const pause = w.paused.arm(BOARD_REQUEST_DENIAL, 'after')
    const removing = removeFromBoard(w.bob, w.board, w.carol.userId)
    const pid = await pause.reached
    const approving = w.alice.req('POST', `/api/access-requests/${id}/approve`, {})
    try {
      expect(await waitedOrFinished(w.api.db, pid, approving)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, approved] = await Promise.all([removing, approving])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(approved.statusCode, approved.body).toBe(409)
    expect(await statusOf(w.api, id)).toBe('denied')
    expect(await grantOf(w.api, w.board, w.carol.userId)).toBeNull()
  })

  it('a board removal against the same person accepting a second invitation to the board (membership step done): it waits; the grant goes', async () => {
    const w = await world()
    const first = await boardInvite(w.bob, w.board, 'viewer', w.erin)
    const second = await boardInvite(w.bob, w.board, 'editor', w.erin)
    expect((await accept(w.erin, first.url)).statusCode).toBe(200)
    const pause = w.paused.arm(MEMBERSHIP_INSERT, 'after')
    const accepting = accept(w.erin, second.url)
    const pid = await pause.reached
    const removing = removeFromBoard(w.bob, w.board, w.erin.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [accepted, removed] = await Promise.all([accepting, removing])
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await invitationState(w.api, second.id)).toEqual({ revoked: false, used: true })
    expect(await grantOf(w.api, w.board, w.erin.userId)).toBeNull()
  })

  it('(fails without J2) the board removal held first, its invitation revoke done: the accept waits, then finds the link gone (410)', async () => {
    const w = await world()
    const first = await boardInvite(w.bob, w.board, 'viewer', w.erin)
    const second = await boardInvite(w.bob, w.board, 'editor', w.erin)
    expect((await accept(w.erin, first.url)).statusCode).toBe(200)
    const pause = w.paused.arm(BOARD_INVITE_REVOKE, 'after')
    const removing = removeFromBoard(w.bob, w.board, w.erin.userId)
    const pid = await pause.reached
    const accepting = accept(w.erin, second.url)
    try {
      expect(await waitedOrFinished(w.api.db, pid, accepting)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, accepted] = await Promise.all([removing, accepting])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(accepted.statusCode, accepted.body).toBe(410)
    expect(await invitationState(w.api, second.id)).toEqual({ revoked: true, used: false })
    expect(await grantOf(w.api, w.board, w.erin.userId)).toBeNull()
  })

  it('a workspace removal against the leaver accepting an invitation to another board (membership step done): it waits at the invitation, then sweeps what the accept gave', async () => {
    const w = await world()
    const board2 = await createBoard(w.bob, DEV_STUDIO, 'Board two')
    const first = await boardInvite(w.bob, w.board, 'viewer', w.erin)
    const second = await boardInvite(w.bob, board2, 'editor', w.erin)
    expect((await accept(w.erin, first.url)).statusCode).toBe(200) // erin: a workspace guest
    const pause = w.paused.arm(MEMBERSHIP_INSERT, 'after')
    const accepting = accept(w.erin, second.url)
    const pid = await pause.reached
    const removing = removeFromWorkspace(w.alice, w.erin.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [accepted, removed] = await Promise.all([accepting, removing])
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await invitationState(w.api, second.id)).toEqual({ revoked: false, used: true })
    expect(await membership(w.api, w.erin.userId)).toBeNull()
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.erin.userId)).toEqual([])
  })

  it('(fails without J2) the workspace removal held first, its revoke of the invitations to them done: the accept waits, then finds the link gone (410)', async () => {
    const w = await world()
    const board2 = await createBoard(w.bob, DEV_STUDIO, 'Board two')
    const first = await boardInvite(w.bob, w.board, 'viewer', w.erin)
    const second = await boardInvite(w.bob, board2, 'editor', w.erin)
    expect((await accept(w.erin, first.url)).statusCode).toBe(200)
    const pause = w.paused.arm(WORKSPACE_INVITE_REVOKE, 'after')
    const removing = removeFromWorkspace(w.alice, w.erin.userId)
    const pid = await pause.reached
    const accepting = accept(w.erin, second.url)
    try {
      expect(await waitedOrFinished(w.api.db, pid, accepting)).toBe('waited')
    } finally {
      pause.release()
    }
    const [removed, accepted] = await Promise.all([removing, accepting])
    expect(removed.statusCode, removed.body).toBe(200)
    expect(accepted.statusCode, accepted.body).toBe(410)
    expect(await invitationState(w.api, second.id)).toEqual({ revoked: true, used: false })
    expect(await membership(w.api, w.erin.userId)).toBeNull()
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.erin.userId)).toEqual([])
  })

  it('a workspace removal against the leaver accepting a WORKSPACE invitation (membership step done): it waits, then removes the raised membership', async () => {
    const w = await world()
    const first = await boardInvite(w.bob, w.board, 'viewer', w.erin)
    expect((await accept(w.erin, first.url)).statusCode).toBe(200) // a workspace guest
    const toWorkspace = await invite(w.alice, `/api/workspaces/${DEV_STUDIO}/invitations`, {
      role: 'member',
      email: devEmail('erin'),
    })
    const pause = w.paused.arm(MEMBERSHIP_INSERT, 'after')
    const accepting = accept(w.erin, toWorkspace.url)
    const pid = await pause.reached
    const removing = removeFromWorkspace(w.alice, w.erin.userId)
    try {
      expect(await waitedOrFinished(w.api.db, pid, removing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [accepted, removed] = await Promise.all([accepting, removing])
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await membership(w.api, w.erin.userId)).toBeNull()
    expect(await orphanGrants(w.api.db, DEV_STUDIO, w.erin.userId)).toEqual([])
  })

  it('(INV-6) simultaneous requests from many people on one board: exactly the cap is written', async () => {
    const w = await world()
    const saved = ACCESS_REQUEST_BOARD_LIMIT.max
    ACCESS_REQUEST_BOARD_LIMIT.max = 5
    try {
      const askers: Client[] = []
      for (let i = 0; i < 20; i++) {
        const c = await w.api.login(`asker${i}`)
        await w.api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
          c.userId,
          DEV_STUDIO,
        ])
        askers.push(c)
      }
      const answers = await Promise.all(
        askers.map((c) => c.req('POST', `/api/boards/${w.board}/access-requests`, { role: 'viewer' })),
      )
      for (const a of answers) expect(a.statusCode, a.body).toBe(202)
      const rows = await w.api.db.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM access_requests WHERE board_id = $1',
        [w.board],
      )
      expect(rows.n).toBe(5)
    } finally {
      ACCESS_REQUEST_BOARD_LIMIT.max = saved
    }
  })

  it('(fails without J2, at random) removals, approvals, accepts and link revokes at once, round after round: no 5xx, and nobody removed keeps the board', async () => {
    const w = await world()
    const failures: string[] = []
    for (let i = 0; i < ITER; i++) {
      // carol: a viewer with a pending request for editor; erin: an outsider with a used and an unused
      // invitation to the board; frank-i: an outsider on the board through a review link, whom the
      // workspace removal takes out while an invitation to him is accepted.
      expect(
        (await w.bob.req('PUT', `/api/boards/${w.board}/members/${w.carol.userId}`, { role: 'viewer' }))
          .statusCode,
      ).toBe(200)
      const asked = await w.carol.req('POST', `/api/boards/${w.board}/access-requests`, { role: 'editor' })
      expect(asked.statusCode).toBe(202)
      const request = await w.api.db.maybeOne<{ id: string }>(
        "SELECT id FROM access_requests WHERE board_id = $1 AND user_id = $2 AND status = 'pending'",
        [w.board, w.carol.userId],
      )
      const first = await boardInvite(w.bob, w.board, 'viewer', w.erin)
      expect((await accept(w.erin, first.url)).statusCode).toBe(200)
      const second = await boardInvite(w.bob, w.board, 'editor', w.erin)
      const frank = await w.api.login(`frank${i}`)
      await w.api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
        frank.userId,
        DEV_STUDIO,
      ])
      const review = await guestLink(w.bob, w.board, { role: 'commenter', allowGuests: false })
      expect((await accept(frank, review.url)).statusCode).toBe(200)
      const toFrank = await boardInvite(w.bob, w.board, 'editor', frank)

      const steps: [string, () => Promise<{ statusCode: number; body: string }>][] = [
        ['remove carol', () => removeFromBoard(w.bob, w.board, w.carol.userId)],
        [
          'approve carol',
          async () =>
            request
              ? w.alice.req('POST', `/api/access-requests/${request.id}/approve`, {})
              : { statusCode: 409, body: '' },
        ],
        ['remove erin', () => removeFromBoard(w.bob, w.board, w.erin.userId)],
        ['accept erin', () => accept(w.erin, second.url)],
        ['remove frank', () => removeFromWorkspace(w.alice, frank.userId)],
        ['accept frank', () => accept(frank, toFrank.url)],
        [
          'revoke review',
          () =>
            w.bob.req('POST', `/api/boards/${w.board}/review-links/${review.id}/revoke`, {
              removeAccess: true,
            }),
        ],
      ]
      steps.sort(() => Math.random() - 0.5)
      const answers = await Promise.all(steps.map(async ([what, run]) => [what, await run()] as const))
      for (const [what, res] of answers)
        if (res.statusCode >= 500) failures.push(`round ${i} ${what}: ${res.statusCode} ${res.body}`)

      // whatever the order: the removals win over the grants given at the same time
      if ((await grantOf(w.api, w.board, w.carol.userId)) !== null)
        failures.push(`round ${i}: carol kept a grant`)
      if ((await grantOf(w.api, w.board, w.erin.userId)) !== null)
        failures.push(`round ${i}: erin kept a grant`)
      if ((await membership(w.api, frank.userId)) !== null)
        failures.push(`round ${i}: frank is still a member`)
      const orphans = await orphanGrants(w.api.db, DEV_STUDIO, frank.userId)
      if (orphans.length) failures.push(`round ${i}: frank has orphan grants ${orphans.join(',')}`)
      // a request left pending is a removed person's way back: never
      if (request && (await statusOf(w.api, request.id)) === 'pending')
        failures.push(`round ${i}: carol's request is still pending`)
      // next round: nobody may ask again for a day after a denial
      w.api.clock.advance(24 * 60 * 60 * 1000 + 1000)
    }
    expect(failures).toEqual([])
  }, 120_000)
})
