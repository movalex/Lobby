// Wave J refix round 1.
// IO-6: an account whose addresses were confirmed more than a day ago (stale) but whose stored address still
// qualifies counted as INSIDE for the visibility rule (IO-2b, and the copy's "made private" in IO-2a) while
// "Duplicate, keep sharing" counted it as not confirmed and left its grant out. So the copy said it left
// someone out while its workspace visibility still reached them, and a raise in an internal-only scope went
// through for a member nobody had confirmed for a day (a former colleague whose company address was removed
// becomes an outside account with that access at their next sign-in). Now there is one rule: only a confirmed
// creator is inside. Before deciding, the api confirms such accounts with the provider (outside any
// transaction, a bounded number): a colleague who still qualifies is confirmed and counts as inside; one who
// no longer qualifies, or whom the provider cannot confirm right now, counts as outside (fails closed).
// IO-7: under open email sign-in (everyone who signs in is a creator) keep sharing left out a colleague who
// had not opened Lobby for a day and called them "not confirmed as Dark Burn Creative or Trailer Park Group".
// Nobody is left out there for being stale (only name-only guests, which are never copied).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHARED_WORKSPACE_ID } from '../../../src/auth/shared-workspace.ts'
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

  it('the provider cannot confirm her right now: she counts as not inside (fails closed), both ways alike', async () => {
    fakeClerk.failures.set('user_carol', () => clerkError(503, 'service_unavailable'))
    refused(await visibility(bob, plain, 'workspace_view'), 'project')
    const body = await duplicate()
    // The copy agrees with what it says: she was left out, and its visibility does not reach her either.
    expect(body.outsideLeftOut).toBe(1)
    expect(body.board.visibility).toBe('private')
    expect((await grantsOf(w.api, body.board.id))[carol.userId]).toBeUndefined()
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
