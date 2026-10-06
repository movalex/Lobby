// Wave J pre-deploy review, IO-1: the "Internal only" switch of a project cannot be stepped around by
// moving the board out of the project. Every refusal reads the board's current project, so a board that
// leaves an internal-only project (to no project, or to a project that is not internal only) would be
// open to outside sharing again. Only a workspace owner or admin who is a creator (the people who may
// turn the switch off) may take it out; anyone else gets the project's 409 INTERNAL_ONLY and the board
// stays put. Moving into an internal-only project, or between two of them, stays open to whoever may
// move the board. Under the dev provider (the domain rules of Clerk domain access), under Clerk, and
// under open email sign-in (the rule is about the role there too).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHARED_WORKSPACE_ID } from '../../../src/auth/shared-workspace.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkUser, clerkWorld } from '../domain-access/clerk-fake.ts'
import {
  addMember,
  emailLogin,
  grant,
  internalProjectIn,
  move,
  newProject,
  OPEN_ENV,
  projectOf,
  refused,
  setProject,
} from './internal-only-support.ts'

vi.mock('@clerk/backend', async () => (await import('../domain-access/clerk-fake.ts')).clerkBackendModule)

describe('IO-1 under the dev provider (outside accounts are not creators)', () => {
  let api: TestApi
  let alice: Client // Dev Studio owner (creator)
  let bob: Client // creator member, owns `board`
  let carol: Client // creator member
  let pat: Client // outside account, Dev Studio guest
  let project: string
  let board: string

  beforeEach(async () => {
    api = await createTestApi()
    alice = await api.login('alice')
    bob = await api.login('bob')
    carol = await api.login('carol')
    pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
    await addMember(api, DEV_STUDIO, pat.userId, 'guest')
    project = await newProject(bob, DEV_STUDIO, 'Secret')
    board = await createBoard(bob, DEV_STUDIO, 'Internal plan')
    expect((await move(bob, board, project)).statusCode).toBe(200)
    const on = await setProject(alice, project, true)
    expect(on.statusCode, on.body).toBe(200)
  })
  afterEach(() => api.close())

  it('is refused for a creator member (the review scenario): the board stays and links stay off', async () => {
    // bob may not turn the switch off...
    expect((await setProject(bob, project, false)).statusCode).toBe(403)
    // ...nor step around it by moving the board out of the project.
    refused(await move(bob, board, null), 'project')
    const other = await newProject(bob, DEV_STUDIO, 'Open')
    refused(await move(bob, board, other), 'project')
    // A move together with a rename changes nothing at all.
    refused(await bob.req('PATCH', `/api/boards/${board}`, { title: 'Renamed', projectId: null }), 'project')
    expect(await projectOf(api, board)).toBe(project)
    const title = await api.db.one<{ title: string }>('SELECT title FROM boards WHERE id = $1', [board])
    expect(title.title).toBe('Internal plan')
    // Every outside-sharing path stays closed.
    refused(await bob.req('POST', `/api/boards/${board}/review-links`, { role: 'commenter' }), 'project')
    refused(
      await bob.req('POST', `/api/boards/${board}/invitations`, {
        role: 'viewer',
        email: 'x@client.example.test',
      }),
      'project',
    )
    // A rename alone is untouched.
    expect((await bob.req('PATCH', `/api/boards/${board}`, { title: 'Renamed' })).statusCode).toBe(200)
  })

  it('is open to a workspace owner or admin who is a creator; never to an outside admin', async () => {
    // An outside admin (pre-existing, decision 4) cannot turn the switch off, so cannot move out either.
    await addMember(api, DEV_STUDIO, pat.userId, 'admin')
    refused(await move(pat, board, null), 'project')
    // An admin who is a creator can.
    await addMember(api, DEV_STUDIO, carol.userId, 'admin')
    const out = await move(carol, board, null)
    expect(out.statusCode, out.body).toBe(200)
    expect(await projectOf(api, board)).toBeNull()
    // And the owner.
    expect((await move(bob, board, project)).statusCode).toBe(200)
    const back = await move(alice, board, null)
    expect(back.statusCode, back.body).toBe(200)
    const link = await bob.req('POST', `/api/boards/${board}/review-links`, { role: 'commenter' })
    expect(link.statusCode, link.body).toBe(201)
  })

  it('moving in, between two internal-only projects, and to the same project stays open', async () => {
    const second = await newProject(bob, DEV_STUDIO, 'Also secret')
    expect((await setProject(alice, second, true)).statusCode).toBe(200)
    expect((await move(bob, board, project)).statusCode).toBe(200)
    const between = await move(bob, board, second)
    expect(between.statusCode, between.body).toBe(200)
    expect(await projectOf(api, board)).toBe(second)
    const fresh = await createBoard(bob, DEV_STUDIO, 'New one')
    expect((await move(bob, fresh, project)).statusCode).toBe(200)
    // Once the switch is off, anyone who may move the board moves it.
    expect((await setProject(alice, project, false)).statusCode).toBe(200)
    expect((await move(bob, fresh, null)).statusCode).toBe(200)
  })

  it('a viewer or a stranger still gets the route’s own answer (nothing new is revealed)', async () => {
    await grant(api, board, pat.userId, 'viewer', bob.userId)
    expect((await move(pat, board, null)).statusCode).toBe(403)
    const quinn = await api.login('quinn', 'Quinn', { email: 'quinn@client.example.test' })
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1', [quinn.userId])
    expect((await move(quinn, board, null)).statusCode).toBe(404)
  })
})

describe('IO-1 under Clerk domain access', () => {
  let w: ClerkWorld
  let alice: Client // owner of her personal workspace (darkburn.com)
  let bob: Client // creator member (trailerparkgroup.com)
  let sam: Client // outside account, made an admin
  let project: string
  let board: string

  beforeEach(async () => {
    w = await clerkWorld()
    clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
    clerkUser('user_bob', ['lobby-test-bob@trailerparkgroup.com'])
    clerkUser('user_sam', ['sam@client.example.test'])
    alice = await w.signIn('user_alice')
    bob = await w.signIn('user_bob')
    sam = await w.signIn('user_sam')
    const wid = alice.personalWorkspaceId
    await addMember(w.api, wid, bob.userId, 'member')
    await addMember(w.api, wid, sam.userId, 'admin')
    project = await newProject(alice, wid, 'Secret')
    board = await createBoard(bob, wid, 'Internal plan')
    expect((await move(bob, board, project)).statusCode).toBe(200)
    expect((await setProject(alice, project, true)).statusCode).toBe(200)
  })
  afterEach(() => w.api.close())

  it('a creator member and an outside admin cannot move the board out; the owner can', async () => {
    refused(await move(bob, board, null), 'project')
    refused(await move(sam, board, null), 'project')
    expect(await projectOf(w.api, board)).toBe(project)
    const out = await move(alice, board, null)
    expect(out.statusCode, out.body).toBe(200)
    expect(await projectOf(w.api, board)).toBeNull()
  })
})

describe('IO-1 under open email sign-in (everyone who signs in is a creator)', () => {
  let api: TestApi
  beforeEach(async () => {
    api = await createTestApi({ env: OPEN_ENV })
  })
  afterEach(() => api.close())

  it('the rule is about the role: a member cannot move a board out; an admin can', async () => {
    const dana = await emailLogin(api, 'dana@example.com', 'Dana')
    const erin = await emailLogin(api, 'erin@another.test', 'Erin')
    const project = await internalProjectIn(api, SHARED_WORKSPACE_ID, 'Secret')
    const create = await dana.req('POST', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`, { title: 'Set' })
    expect(create.statusCode, create.body).toBe(201)
    const board = (create.json() as { id: string }).id
    expect((await move(dana, board, project)).statusCode).toBe(200)
    refused(await move(dana, board, null), 'project')
    await addMember(api, SHARED_WORKSPACE_ID, erin.userId, 'admin')
    const out = await move(erin, board, null)
    expect(out.statusCode, out.body).toBe(200)
  })
})
