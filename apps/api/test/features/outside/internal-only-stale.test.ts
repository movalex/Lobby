// Wave J refix round 1.
// IO-6: an account whose addresses were confirmed more than a day ago (stale) but whose stored address still
// qualifies counted as INSIDE for the visibility rule (IO-2b, and the copy's "made private" in IO-2a) while
// "Duplicate, keep sharing" counted it as not confirmed and left its grant out. So the copy said it left
// someone out while its workspace visibility still reached them, and a raise in an internal-only scope went
// through for a member nobody had confirmed for a day (a former colleague whose company address was removed
// becomes an outside account with that access at their next sign-in). Now there is one rule: only a confirmed
// creator is inside. Before deciding, the api confirms such accounts with the provider (outside any
// transaction, a bounded number): a colleague who still qualifies is confirmed and counts as inside; one who
// no longer qualifies counts as outside; one the provider cannot confirm right now changes nothing (fails closed;
// since IO-11 the answer is the retryable 503).
// IO-7: under open email sign-in (everyone who signs in is a creator) keep sharing left out a colleague who
// had not opened Lobby for a day and called them "not confirmed as Dark Burn Creative or Trailer Park Group".
// Nobody is left out there for being stale (only name-only guests, which are never copied).

import { COLLEAGUES_UNCONFIRMED_CODE, COLLEAGUES_UNCONFIRMED_MESSAGE } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHARED_WORKSPACE_ID } from '../../../src/auth/shared-workspace.ts'
import { staleConfirmLimits } from '../../../src/features/dashboard/outside.ts'
import { type Client, createBoard, createTestApi, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkError, clerkUser, clerkWorld, fakeClerk } from '../domain-access/clerk-fake.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from '../history/helpers.ts'
import {
  addMember,
  emailLogin,
  grant,
  grantsOf,
  internalProjectIn,
  move,
  newProject,
  OPEN_ENV,
  refused,
  setProject,
  visibility,
  visibilityOf,
} from './internal-only-support.ts'

vi.mock('@clerk/backend', async () => (await import('../domain-access/clerk-fake.ts')).clerkBackendModule)

interface Created {
  board: { id: string; visibility: string }
  warnings: string[]
  outsideLeftOut?: number
}

const HOUR = 60 * 60 * 1000
const staleFor = (api: TestApi, userId: string, hours = 25) =>
  api.db.query('UPDATE users SET identity_checked_at = $2 WHERE id = $1', [
    userId,
    new Date(api.clock.now().getTime() - hours * HOUR),
  ])

describe('IO-6 under Clerk domain access: a stale colleague, confirmed before the decision', () => {
  let w: ClerkWorld
  let alice: Client // owner of her personal workspace (darkburn.com)
  let bob: Client // creator member (trailerparkgroup.com), owns the boards
  let carol: Client // member (darkburn.com when she signed in), stale by the time of the decision
  let wid: string
  let project: string
  let board: string // in the project, workspace_view, carol has an editor grant
  let plain: string // in the project, private
  let sync: FakeSync

  beforeEach(async () => {
    sync = createFakeSync()
    w = await clerkWorld({ deps: { syncInternal: sync } })
    clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
    clerkUser('user_bob', ['lobby-test-bob@trailerparkgroup.com'])
    clerkUser('user_carol', ['lobby-test-carol@darkburn.com'])
    alice = await w.signIn('user_alice')
    bob = await w.signIn('user_bob')
    carol = await w.signIn('user_carol')
    wid = alice.personalWorkspaceId
    await addMember(w.api, wid, bob.userId, 'member')
    await addMember(w.api, wid, carol.userId, 'member')
    project = await newProject(alice, wid, 'Secret')
    board = await createBoard(bob, wid, 'Internal plan')
    plain = await createBoard(bob, wid, 'Plain')
    sync.setBoard(board, [...baseRecords(), noteRec('n1', 'x')])
    for (const b of [board, plain]) expect((await move(bob, b, project)).statusCode).toBe(200)
    expect((await visibility(bob, board, 'workspace_view')).statusCode).toBe(200)
    await grant(w.api, board, carol.userId, 'editor', bob.userId)
    expect((await setProject(alice, project, true)).statusCode).toBe(200)
    await staleFor(w.api, carol.userId)
    fakeClerk.calls = []
  })
  afterEach(() => {
    fakeClerk.failures.clear()
    return w.api.close()
  })

  const duplicate = async () => {
    const res = await bob.req('POST', `/api/boards/${board}/duplicate`, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as Created
  }

  it('still a colleague: confirmed first, so the raise passes and keep sharing copies her grant', async () => {
    const raised = await visibility(bob, plain, 'workspace_view')
    expect(raised.statusCode, raised.body).toBe(200)
    expect(fakeClerk.calls).toContain('user_carol')
    await staleFor(w.api, carol.userId)
    const body = await duplicate()
    expect(body.board.visibility).toBe('workspace_view')
    expect(body.outsideLeftOut ?? 0).toBe(0)
    expect(body.warnings).toEqual([])
    expect((await grantsOf(w.api, body.board.id))[carol.userId]).toBe('editor')
  })

  it('a former colleague (her company address is gone): refused, and the copy is private without her', async () => {
    clerkUser('user_carol', ['carol@client.example.test'])
    refused(await visibility(bob, plain, 'workspace_view'), 'project')
    expect(await visibilityOf(w.api, plain)).toBe('private')
    await staleFor(w.api, carol.userId)
    const body = await duplicate()
    expect(body.board.visibility).toBe('private')
    expect(body.outsideLeftOut).toBe(1)
    expect((await grantsOf(w.api, body.board.id))[carol.userId]).toBeUndefined()
    // Her next sign-in finds an outside account with no access to the copy.
    const again = await w.signIn('user_carol')
    expect((await again.req('GET', `/api/boards/${body.board.id}`)).statusCode).not.toBe(200)
  })

  // Refix round 3 (IO-11): a colleague the provider could not answer about is not "confirmed outside":
  // nothing changes (fails closed) and the answer is the retryable 503, not the outside refusal or a copy
  // made without her.
  it('the provider cannot confirm her right now: a retryable 503 both ways, nothing changed', async () => {
    fakeClerk.failures.set('user_carol', () => clerkError(503, 'service_unavailable'))
    const raised = await visibility(bob, plain, 'workspace_view')
    expect(raised.statusCode, raised.body).toBe(503)
    expect((raised.json() as { error: { code: string } }).error.code).toBe(COLLEAGUES_UNCONFIRMED_CODE)
    expect(await visibilityOf(w.api, plain)).toBe('private')
    const before = await w.api.db.one<{ n: string }>('SELECT count(*) AS n FROM boards')
    const dup = await bob.req('POST', `/api/boards/${board}/duplicate`, { keepSharing: true })
    expect(dup.statusCode, dup.body).toBe(503)
    expect((dup.json() as { error: { code: string } }).error.code).toBe(COLLEAGUES_UNCONFIRMED_CODE)
    expect((await w.api.db.one<{ n: string }>('SELECT count(*) AS n FROM boards')).n).toBe(before.n)
  })
})

describe('IO-7 under open email sign-in: a colleague who has not opened Lobby for a day', () => {
  let api: TestApi
  let sync: FakeSync
  beforeEach(async () => {
    sync = createFakeSync()
    api = await createTestApi({ env: OPEN_ENV, deps: { syncInternal: sync } })
  })
  afterEach(() => api.close())

  it('keeps their grant on a keep-sharing copy, and says nothing', async () => {
    const dana = await emailLogin(api, 'dana@example.com', 'Dana')
    const sam = await emailLogin(api, 'sam@another.test', 'Sam')
    const project = await internalProjectIn(api, SHARED_WORKSPACE_ID, 'Secret')
    const create = await dana.req('POST', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`, { title: 'Set' })
    expect(create.statusCode, create.body).toBe(201)
    const board = (create.json() as { id: string }).id
    sync.setBoard(board, [...baseRecords(), noteRec('n1', 'x')])
    expect((await move(dana, board, project)).statusCode).toBe(200)
    expect((await visibility(dana, board, 'workspace_view')).statusCode).toBe(200)
    await grant(api, board, sam.userId, 'editor', dana.userId)
    await staleFor(api, sam.userId)
    const dup = await dana.req('POST', `/api/boards/${board}/duplicate`, { keepSharing: true })
    expect(dup.statusCode, dup.body).toBe(201)
    const body = dup.json() as Created
    expect(await grantsOf(api, body.board.id)).toEqual({ [dana.userId]: 'owner', [sam.userId]: 'editor' })
    expect(body.board.visibility).toBe('workspace_view')
    expect(body.outsideLeftOut ?? 0).toBe(0)
    expect(body.warnings).toEqual([])
  })
})

// Wave J refix round 2.
// IO-9: confirmStaleReach confirmed at most 20 accounts, and everyone it did not get to counted as outside
// (IO-6's `NOT o_creator`). So with more than 20 colleagues idle for a day a raise in an internal-only scope
// was refused with the outside message (and went through on a retry), and keep sharing left colleagues out or
// made the copy private as "not confirmed". The budget was also spent on accounts the decision does not count
// (a workspace guest with a grant, a member whose own grant already reaches the role). Now only the counted
// accounts are confirmed, within a budget and a time limit, and when the ones it did not get to are all that
// would decide it the answer is a retryable 503 COLLEAGUES_UNCONFIRMED with nothing changed.
describe('IO-9 under Clerk domain access: more stale colleagues than one decision confirms', () => {
  let w: ClerkWorld
  let alice: Client // owner (darkburn.com)
  let bob: Client // creator member, owns the boards
  let wid: string
  let project: string
  let plain: string // in the project, private
  let shared: string // in the project, workspace_view
  let colleagues: Client[] // members with role 'member' (darkburn.com), stale
  let sync: FakeSync
  const saved = { ...staleConfirmLimits }
  const COLLEAGUES = 5

  beforeEach(async () => {
    sync = createFakeSync()
    w = await clerkWorld({ deps: { syncInternal: sync } })
    clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
    clerkUser('user_bob', ['lobby-test-bob@trailerparkgroup.com'])
    alice = await w.signIn('user_alice')
    bob = await w.signIn('user_bob')
    wid = alice.personalWorkspaceId
    await addMember(w.api, wid, bob.userId, 'member')
    colleagues = []
    for (let i = 0; i < COLLEAGUES; i++) {
      clerkUser(`user_m${i}`, [`lobby-test-m${i}@darkburn.com`])
      const c = await w.signIn(`user_m${i}`)
      await addMember(w.api, wid, c.userId, 'member')
      colleagues.push(c)
    }
    project = await newProject(alice, wid, 'Secret')
    plain = await createBoard(bob, wid, 'Plain')
    shared = await createBoard(bob, wid, 'Shared')
    sync.setBoard(shared, [...baseRecords(), noteRec('n1', 'x')])
    for (const b of [plain, shared]) expect((await move(bob, b, project)).statusCode).toBe(200)
    expect((await visibility(bob, shared, 'workspace_view')).statusCode).toBe(200)
    expect((await setProject(alice, project, true)).statusCode).toBe(200)
    for (const c of colleagues) await staleFor(w.api, c.userId)
    fakeClerk.calls = []
    Object.assign(staleConfirmLimits, { max: 3 })
  })
  afterEach(() => {
    Object.assign(staleConfirmLimits, saved)
    fakeClerk.failures.clear()
    fakeClerk.gate = null
    return w.api.close()
  })

  const unconfirmed = (res: { statusCode: number; body: string; json: () => unknown }) => {
    expect(res.statusCode, res.body).toBe(503)
    expect(res.json()).toEqual({
      error: expect.objectContaining({
        code: COLLEAGUES_UNCONFIRMED_CODE,
        message: COLLEAGUES_UNCONFIRMED_MESSAGE,
      }),
    })
  }
  const boardCount = async () =>
    Number(
      (await w.api.db.one<{ n: string }>('SELECT count(*) AS n FROM boards WHERE workspace_id = $1', [wid]))
        .n,
    )

  it('a raise past the budget is a retryable 503 (nothing changed), and the retry passes', async () => {
    unconfirmed(await visibility(bob, plain, 'workspace_view'))
    expect(await visibilityOf(w.api, plain)).toBe('private')
    expect(fakeClerk.calls).toHaveLength(3)
    const again = await visibility(bob, plain, 'workspace_view')
    expect(again.statusCode, again.body).toBe(200)
    expect(await visibilityOf(w.api, plain)).toBe('workspace_view')
  })

  it('a keep-sharing copy past the budget is a retryable 503 (no board made), and the retry keeps everyone', async () => {
    for (const c of colleagues.slice(0, 2)) await grant(w.api, shared, c.userId, 'editor', bob.userId)
    const before = await boardCount()
    unconfirmed(await bob.req('POST', `/api/boards/${shared}/duplicate`, { keepSharing: true }))
    expect(await boardCount()).toBe(before)
    const again = await bob.req('POST', `/api/boards/${shared}/duplicate`, { keepSharing: true })
    expect(again.statusCode, again.body).toBe(201)
    const body = again.json() as Created
    expect(body.board.visibility).toBe('workspace_view')
    expect(body.outsideLeftOut ?? 0).toBe(0)
    expect(body.warnings).toEqual([])
    const grants = await grantsOf(w.api, body.board.id)
    for (const c of colleagues.slice(0, 2)) expect(grants[c.userId]).toBe('editor')
  })

  it('someone really outside: the outside refusal straight away, not the retryable answer', async () => {
    clerkUser('user_out', ['out@client.example.test'])
    const out = await w.signIn('user_out')
    await addMember(w.api, wid, out.userId, 'member')
    refused(await visibility(bob, plain, 'workspace_view'), 'project')
  })

  it('confirms only the accounts the raise counts (not a guest with a grant, not a member its grant reaches)', async () => {
    Object.assign(staleConfirmLimits, { max: 50 })
    clerkUser('user_g', ['lobby-test-g@darkburn.com'])
    const g = await w.signIn('user_g')
    await addMember(w.api, wid, g.userId, 'guest')
    await grant(w.api, plain, g.userId, 'viewer', bob.userId)
    const [first] = colleagues
    if (!first) throw new Error('no colleagues')
    await grant(w.api, plain, first.userId, 'editor', bob.userId)
    await staleFor(w.api, g.userId)
    fakeClerk.calls = []
    const res = await visibility(bob, plain, 'workspace_view')
    expect(res.statusCode, res.body).toBe(200)
    expect([...fakeClerk.calls].sort()).toEqual(['user_m1', 'user_m2', 'user_m3', 'user_m4'])
  })

  it('a provider too slow for the time limit: a retryable 503, and the retry passes once it answers', async () => {
    Object.assign(staleConfirmLimits, { max: 50, timeMs: 200 })
    let open = () => {}
    fakeClerk.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    unconfirmed(await visibility(bob, plain, 'workspace_view'))
    expect(await visibilityOf(w.api, plain)).toBe('private')
    fakeClerk.gate = null
    open()
    await vi.waitFor(async () => {
      const res = await visibility(bob, plain, 'workspace_view')
      expect(res.statusCode, res.body).toBe(200)
    })
  })

  // Refix round 3 (IO-11): the calls still running at the time limit then failed, so those colleagues were in
  // the provider-failure backoff. The retry the 503 asked for got no provider call for them and counted them
  // as asked: the raise got the outside 409, and a keep-sharing copy was made private without their grants.
  it('a retry while the timed-out colleagues are in the failure backoff: the 503 again, never 409 or a reduced copy', async () => {
    Object.assign(staleConfirmLimits, { max: 50, timeMs: 200 })
    for (const c of colleagues.slice(0, 2)) await grant(w.api, shared, c.userId, 'editor', bob.userId)
    let open = () => {}
    fakeClerk.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    for (let i = 0; i < COLLEAGUES; i++)
      fakeClerk.failures.set(`user_m${i}`, () => clerkError(503, 'service_unavailable'))
    unconfirmed(await visibility(bob, plain, 'workspace_view'))
    fakeClerk.gate = null
    open()
    // The failed calls finish (and set the backoff); then the provider is healthy again.
    await w.api.identity.settled()
    fakeClerk.failures.clear()
    fakeClerk.calls = []
    unconfirmed(await visibility(bob, plain, 'workspace_view'))
    expect(await visibilityOf(w.api, plain)).toBe('private')
    const before = await boardCount()
    unconfirmed(await bob.req('POST', `/api/boards/${shared}/duplicate`, { keepSharing: true }))
    expect(await boardCount()).toBe(before)
    // After the backoff the provider is asked again, and the raise passes.
    w.api.clock.advance(61_000)
    const again = await visibility(bob, plain, 'workspace_view')
    expect(again.statusCode, again.body).toBe(200)
  })
})
