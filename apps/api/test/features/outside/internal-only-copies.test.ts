// Wave J pre-deploy review, IO-2: two creator paths handed new access to outside accounts already in an
// internal-only scope.
// (a) "Duplicate, keep sharing" into an internal-only scope copies only confirmed creators' grants and
//     says how many people it left out; the copy is private while its visibility would reach a
//     workspace member who is outside or unconfirmed (and says so).
// (b) Raising a board's visibility in an internal-only scope is refused with the scope's 409
//     INTERNAL_ONLY while it would raise a workspace member who is outside or unconfirmed (owners and
//     admins see every board already; a workspace guest gets nothing from the visibility).
// Under the dev provider (the domain rules of Clerk domain access), under Clerk, and under open email
// sign-in (everyone who signs in is a creator: nobody is left out, nothing is refused for being outside).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHARED_WORKSPACE_ID } from '../../../src/auth/shared-workspace.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkUser, clerkWorld } from '../domain-access/clerk-fake.ts'
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
  projectOf,
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

const LEFT_OUT_TWO =
  'This project is internal only, so 2 people who are not confirmed as Dark Burn Creative or Trailer Park Group were not given access to the copy.'
const MADE_PRIVATE =
  'This project is internal only and its workspace has members who are not confirmed as Dark Burn Creative or Trailer Park Group, so the copy is private.'

describe('IO-2 under the dev provider (outside accounts are not creators)', () => {
  let api: TestApi
  let sync: FakeSync
  let alice: Client // Dev Studio owner (creator)
  let bob: Client // creator member, owns `board`
  let carol: Client // creator member
  let pat: Client // outside account, Dev Studio guest
  let project: string
  let board: string

  beforeEach(async () => {
    sync = createFakeSync()
    api = await createTestApi({ deps: { syncInternal: sync } })
    alice = await api.login('alice')
    bob = await api.login('bob')
    carol = await api.login('carol')
    pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
    await addMember(api, DEV_STUDIO, pat.userId, 'guest')
    project = await newProject(bob, DEV_STUDIO, 'Secret')
    board = await createBoard(bob, DEV_STUDIO, 'Internal plan')
    sync.setBoard(board, [...baseRecords(), noteRec('n1', 'x')])
    expect((await move(bob, board, project)).statusCode).toBe(200)
    const on = await setProject(alice, project, true)
    expect(on.statusCode, on.body).toBe(200)
  })
  afterEach(() => api.close())

  const duplicate = async (c: Client) => {
    const res = await c.req('POST', `/api/boards/${board}/duplicate`, { keepSharing: true })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as Created
  }

  describe('(a) "Duplicate, keep sharing" into an internal-only scope', () => {
    it('copies only confirmed creators’ grants and says how many people were left out', async () => {
      await grant(api, board, carol.userId, 'commenter', bob.userId)
      await grant(api, board, pat.userId, 'viewer', bob.userId)
      const dave = await api.login('dave')
      await grant(api, board, dave.userId, 'editor', bob.userId)
      // dave is a creator whose addresses are not confirmed: left out too (fails closed).
      await api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [dave.userId])
      const body = await duplicate(bob)
      expect(await grantsOf(api, body.board.id)).toEqual({
        [bob.userId]: 'owner',
        [carol.userId]: 'commenter',
      })
      expect(body.outsideLeftOut).toBe(2)
      expect(body.warnings).toEqual([LEFT_OUT_TWO])
      // The audit row says so too (a count, no names).
      const audit = await api.db.one<{ detail: { outsideLeftOut?: number } }>(
        "SELECT detail FROM audit_events WHERE action = 'board.create' AND target = $1",
        [body.board.id],
      )
      expect(audit.detail.outsideLeftOut).toBe(2)
    })

    it('the workspace switch gives the workspace’s words; one person reads “1 person”', async () => {
      expect(
        (await alice.req('PUT', `/api/workspaces/${DEV_STUDIO}/internal-only`, { internalOnly: true }))
          .statusCode,
      ).toBe(200)
      await grant(api, board, pat.userId, 'viewer', bob.userId)
      const body = await duplicate(bob)
      expect(body.outsideLeftOut).toBe(1)
      expect(body.warnings).toEqual([
        'This workspace is internal only, so 1 person who is not confirmed as Dark Burn Creative or Trailer Park Group was not given access to the copy.',
      ])
    })

    it('the copy of a workspace-visible board is private while the workspace has an outside member', async () => {
      const sam = await api.login('sam', 'Sam', { email: 'sam@client.example.test' })
      await addMember(api, DEV_STUDIO, sam.userId, 'member')
      await api.db.query("UPDATE boards SET visibility = 'workspace_view' WHERE id = $1", [board])
      const body = await duplicate(bob)
      expect(body.board.visibility).toBe('private')
      expect(await visibilityOf(api, body.board.id)).toBe('private')
      expect(body.warnings).toEqual([MADE_PRIVATE])
      // Without an outside member, the copy keeps the visibility.
      await api.db.query('DELETE FROM workspace_members WHERE user_id = $1', [sam.userId])
      const again = await duplicate(bob)
      expect(again.board.visibility).toBe('workspace_view')
      expect(again.warnings).toEqual([])
    })

    it('with the switch off, every grant is copied as before (and nothing is said)', async () => {
      await grant(api, board, pat.userId, 'viewer', bob.userId)
      expect((await setProject(alice, project, false)).statusCode).toBe(200)
      const body = await duplicate(bob)
      expect(await grantsOf(api, body.board.id)).toEqual({ [bob.userId]: 'owner', [pat.userId]: 'viewer' })
      expect(body.outsideLeftOut ?? 0).toBe(0)
      expect(body.warnings).toEqual([])
    })

    it('a plain duplicate (no keep sharing) is private with no grants, as before', async () => {
      await grant(api, board, pat.userId, 'viewer', bob.userId)
      const res = await bob.req('POST', `/api/boards/${board}/duplicate`, {})
      expect(res.statusCode, res.body).toBe(201)
      const body = res.json() as Created
      expect(await grantsOf(api, body.board.id)).toEqual({ [bob.userId]: 'owner' })
      expect(body.outsideLeftOut ?? 0).toBe(0)
      expect(body.warnings).toEqual([])
    })
  })

  describe('(b) raising the visibility in an internal-only scope', () => {
    let sam: Client
    beforeEach(async () => {
      sam = await api.login('sam', 'Sam', { email: 'sam@client.example.test' })
      await addMember(api, DEV_STUDIO, sam.userId, 'member')
    })

    it('is refused while a workspace member is outside; lowering stays open', async () => {
      refused(await visibility(bob, board, 'workspace_view'), 'project')
      expect(await visibilityOf(api, board)).toBe('private')
      // The workspace switch gives the workspace's words.
      expect(
        (await alice.req('PUT', `/api/workspaces/${DEV_STUDIO}/internal-only`, { internalOnly: true }))
          .statusCode,
      ).toBe(200)
      refused(await visibility(bob, board, 'workspace_view'), 'workspace')
      // A board outside the project in an internal-only workspace too.
      const plain = await createBoard(bob, DEV_STUDIO, 'Plain')
      refused(await visibility(bob, plain, 'workspace_edit'), 'workspace')
      // Lowering is never refused.
      await api.db.query("UPDATE boards SET visibility = 'workspace_edit' WHERE id = $1", [plain])
      expect((await visibility(bob, plain, 'workspace_view')).statusCode).toBe(200)
      // view -> edit raises the outside member too.
      refused(await visibility(bob, plain, 'workspace_edit'), 'workspace')
    })

    it('an unconfirmed member counts; an outside guest or admin does not (visibility gives them nothing new)', async () => {
      await addMember(api, DEV_STUDIO, sam.userId, 'guest')
      const dave = await api.login('dave')
      await api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [dave.userId])
      refused(await visibility(bob, board, 'workspace_view'), 'project')
      await addMember(api, DEV_STUDIO, dave.userId, 'admin')
      await addMember(api, DEV_STUDIO, pat.userId, 'admin')
      const res = await visibility(bob, board, 'workspace_view')
      expect(res.statusCode, res.body).toBe(200)
    })

    it('a member whose own grant already covers the new role is not raised; the switch off allows it', async () => {
      await grant(api, board, sam.userId, 'editor', bob.userId)
      const res = await visibility(bob, board, 'workspace_edit')
      expect(res.statusCode, res.body).toBe(200)
      await api.db.query("UPDATE boards SET visibility = 'private' WHERE id = $1", [board])
      await api.db.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [
        board,
        sam.userId,
      ])
      refused(await visibility(bob, board, 'workspace_view'), 'project')
      expect((await setProject(alice, project, false)).statusCode).toBe(200)
      expect((await visibility(bob, board, 'workspace_view')).statusCode).toBe(200)
    })

    it('moving a private board in and raising it in one request is decided on the project it lands in', async () => {
      const plain = await createBoard(bob, DEV_STUDIO, 'Plain')
      refused(
        await bob.req('PATCH', `/api/boards/${plain}`, { projectId: project, visibility: 'workspace_view' }),
        'project',
      )
      expect(await projectOf(api, plain)).toBeNull()
      expect(await visibilityOf(api, plain)).toBe('private')
    })
  })
})

describe('IO-2b under Clerk domain access', () => {
  let w: ClerkWorld
  let alice: Client // owner of her personal workspace (darkburn.com)
  let bob: Client // creator member (trailerparkgroup.com)
  let sam: Client // outside member
  let wid: string
  let board: string

  beforeEach(async () => {
    w = await clerkWorld()
    clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
    clerkUser('user_bob', ['lobby-test-bob@trailerparkgroup.com'])
    clerkUser('user_sam', ['sam@client.example.test'])
    alice = await w.signIn('user_alice')
    bob = await w.signIn('user_bob')
    sam = await w.signIn('user_sam')
    wid = alice.personalWorkspaceId
    await addMember(w.api, wid, bob.userId, 'member')
    await addMember(w.api, wid, sam.userId, 'member')
    const project = await newProject(alice, wid, 'Secret')
    board = await createBoard(bob, wid, 'Internal plan')
    expect((await move(bob, board, project)).statusCode).toBe(200)
    expect((await setProject(alice, project, true)).statusCode).toBe(200)
  })
  afterEach(() => w.api.close())

  it('the outside member blocks a raise; without them it passes', async () => {
    refused(await visibility(bob, board, 'workspace_view'), 'project')
    await w.api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      wid,
      sam.userId,
    ])
    const res = await visibility(bob, board, 'workspace_view')
    expect(res.statusCode, res.body).toBe(200)
  })
})

describe('IO-2 under open email sign-in (everyone who signs in is a creator)', () => {
  let api: TestApi
  let sync: FakeSync
  beforeEach(async () => {
    sync = createFakeSync()
    api = await createTestApi({ env: OPEN_ENV, deps: { syncInternal: sync } })
  })
  afterEach(() => api.close())

  it('nothing is refused or left out for being outside', async () => {
    const dana = await emailLogin(api, 'dana@example.com', 'Dana')
    const sam = await emailLogin(api, 'sam@another.test', 'Sam')
    const project = await internalProjectIn(api, SHARED_WORKSPACE_ID, 'Secret')
    const create = await dana.req('POST', `/api/workspaces/${SHARED_WORKSPACE_ID}/boards`, { title: 'Set' })
    expect(create.statusCode, create.body).toBe(201)
    const board = (create.json() as { id: string }).id
    sync.setBoard(board, [...baseRecords(), noteRec('n1', 'x')])
    expect((await move(dana, board, project)).statusCode).toBe(200)
    // (b): every member is inside, so the raise passes.
    const raised = await visibility(dana, board, 'workspace_view')
    expect(raised.statusCode, raised.body).toBe(200)
    // (a): sam's grant is copied, the copy keeps its visibility; nobody is left out.
    await grant(api, board, sam.userId, 'editor', dana.userId)
    const dup = await dana.req('POST', `/api/boards/${board}/duplicate`, { keepSharing: true })
    expect(dup.statusCode, dup.body).toBe(201)
    const body = dup.json() as Created
    expect(await grantsOf(api, body.board.id)).toEqual({ [dana.userId]: 'owner', [sam.userId]: 'editor' })
    expect(body.board.visibility).toBe('workspace_view')
    expect(body.outsideLeftOut ?? 0).toBe(0)
    expect(body.warnings).toEqual([])
  })
})
