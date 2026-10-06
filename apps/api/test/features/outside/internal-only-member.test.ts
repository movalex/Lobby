// Wave J second review of IO-1/IO-2 (IO-3): a workspace role of 'member' gives the visibility's role on
// EVERY board of the workspace, whatever its project. So a project's "Internal only" switch could be
// stepped around by making an outside account a member (a guest raised to member, or a workspace
// invitation as member): their board stayed workspace-visible because the visibility check (IO-2b) only
// counts members. Now each of those is refused with the project's 409 INTERNAL_ONLY while a board of an
// internal-only project is not private (the trash too) and would give that account more than its own
// grant does; for a confirmed creator, a private board, or an own grant that reaches the role, nothing
// changes. Each is decided in the route's transaction, under the workspace row lock the switch takes.
//
// And (minor): the root hooks on other workstreams' routes read the switch before the route's
// transaction; a direct grant (PUT board members, the email invite's "granted" path) and a workspace role
// raise now decide again in their transaction, so a switch turned on (or a move into an internal-only
// project) between the hook's read and the route is still refused. The tests below commit that change
// right after the hook's read, as another connection would.

import { InvitationCreated } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { type ClerkWorld, clerkUser, clerkWorld } from '../domain-access/clerk-fake.ts'
import { tokenOf } from '../guests/support.ts'
import {
  addMember,
  grant,
  grantsOf,
  move,
  newProject,
  refused,
  setProject,
  visibility,
} from './internal-only-support.ts'

vi.mock('@clerk/backend', async () => (await import('../domain-access/clerk-fake.ts')).clerkBackendModule)

type Query = TestApi['db']['query']

/**
 * Runs `then` (with the unwrapped query) right after the first read on the pool (`api.db`: query, one
 * or maybeOne) whose SQL matches: a change another connection commits between that read (a root hook's) and
 * the route's transaction.
 */
function commitAfter(api: TestApi, sql: RegExp, then: (q: Query) => Promise<unknown>): () => void {
  const db = api.db
  const saved = { query: db.query, one: db.one, maybeOne: db.maybeOne }
  let armed = true
  const after = async () => {
    if (!armed) return
    armed = false
    await then(saved.query)
  }
  const wrap = <F extends (text: string, params?: readonly unknown[]) => Promise<unknown>>(f: F) =>
    (async (text: string, params?: readonly unknown[]) => {
      const result = await f(text, params)
      if (armed && sql.test(text)) await after()
      return result
    }) as unknown as F
  db.query = wrap(saved.query)
  db.one = wrap(saved.one)
  db.maybeOne = wrap(saved.maybeOne)
  return () => {
    Object.assign(db, saved)
  }
}

/** The root hooks' reads (outside.ts boardInternalOnly, workspaceInternalOnly). */
const BOARD_SWITCH_READ = /SELECT w\.internal_only AS ws, p\.internal_only AS prj/
const WORKSPACE_SWITCH_READ = /SELECT internal_only AS ws FROM workspaces WHERE id = \$1/

const roleIn = async (api: TestApi, wid: string, userId: string) =>
  (
    await api.db.maybeOne<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [wid, userId],
    )
  )?.role ?? null

describe('IO-3: making an outside account a workspace member (dev provider)', () => {
  let api: TestApi
  let alice: Client // Dev Studio owner (creator)
  let bob: Client // creator member, owns `board`
  let pat: Client // outside account, Dev Studio guest
  let project: string
  let board: string // in `project`, workspace_edit

  const patch = (uid: string, role: string) =>
    alice.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${uid}`, { role })
  const wsInvite = (email: string, role = 'member') =>
    alice.req('POST', `/api/workspaces/${DEV_STUDIO}/invitations`, { role, email })

  beforeEach(async () => {
    api = await createTestApi()
    alice = await api.login('alice')
    bob = await api.login('bob')
    pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
    await addMember(api, DEV_STUDIO, pat.userId, 'guest')
    project = await newProject(bob, DEV_STUDIO, 'Secret')
    board = await createBoard(bob, DEV_STUDIO, 'Internal plan')
    expect((await move(bob, board, project)).statusCode).toBe(200)
    // Allowed by IO-2b: pat is a guest, whom the visibility gives nothing.
    expect((await visibility(bob, board, 'workspace_edit')).statusCode).toBe(200)
    expect((await setProject(alice, project, true)).statusCode).toBe(200)
  })
  afterEach(() => api.close())

  it('a guest raised to member: refused for an outside account (the review scenario), not for a creator', async () => {
    refused(await patch(pat.userId, 'member'), 'project')
    expect(await roleIn(api, DEV_STUDIO, pat.userId)).toBe('guest')
    expect((await pat.req('GET', `/api/boards/${board}`)).statusCode).not.toBe(200)
    // A creator guest is raised as before.
    const dora = await api.login('dora')
    await addMember(api, DEV_STUDIO, dora.userId, 'guest')
    expect((await patch(dora.userId, 'member')).statusCode).toBe(200)
    // A board in the trash counts too (a restore would open it).
    await api.db.query("UPDATE boards SET status = 'trashed', trashed_at = now() WHERE id = $1", [board])
    refused(await patch(pat.userId, 'member'), 'project')
  })

  it('a private board, or an own grant that already reaches the role, refuses nothing', async () => {
    // A viewer grant is below what workspace_edit gives: still refused.
    await grant(api, board, pat.userId, 'viewer', bob.userId)
    refused(await patch(pat.userId, 'member'), 'project')
    await grant(api, board, pat.userId, 'editor', bob.userId)
    expect((await patch(pat.userId, 'member')).statusCode).toBe(200)
    expect((await patch(pat.userId, 'guest')).statusCode).toBe(200)
    await api.db.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [board, pat.userId])
    expect((await visibility(bob, board, 'private')).statusCode).toBe(200)
    expect((await patch(pat.userId, 'member')).statusCode).toBe(200)
    // The visibility side then refuses (IO-2b): both sides agree.
    refused(await visibility(bob, board, 'workspace_view'), 'project')
  })

  it('a workspace invitation as member: refused when created, and when accepted (one from before)', async () => {
    const quinn = await api.login('quinn', 'Quinn', { email: 'quinn@client.example.test' })
    await api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      quinn.userId,
    ])
    refused(await wsInvite('quinn@client.example.test'), 'project')
    // As a workspace guest (nothing from the visibility), and to a creator address: as before.
    expect((await wsInvite('olga@client.example.test', 'guest')).statusCode).toBe(201)
    const forErin = await wsInvite(devEmail('erin'))
    expect(forErin.statusCode, forErin.body).toBe(201)
    // One from while the board was private, accepted after it was opened to the workspace.
    expect((await visibility(bob, board, 'private')).statusCode).toBe(200)
    const before = await wsInvite('quinn@client.example.test')
    expect(before.statusCode, before.body).toBe(201)
    const inv = InvitationCreated.parse(before.json())
    expect((await visibility(bob, board, 'workspace_edit')).statusCode).toBe(200)
    refused(await quinn.req('POST', `/api/invitations/${tokenOf(inv.url)}/accept`), 'project')
    expect(await roleIn(api, DEV_STUDIO, quinn.userId)).toBeNull()
    expect(await api.db.one('SELECT redeemed_by FROM invitations WHERE id = $1', [inv.id])).toEqual({
      redeemed_by: null,
    })
    expect((await quinn.req('GET', `/api/boards/${board}`)).statusCode).not.toBe(200)
    expect((await quinn.req('POST', `/api/boards/${board}/ticket`)).statusCode).not.toBe(200)
    // The creator accepts.
    const erin = await api.login('erin')
    await api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      DEV_STUDIO,
      erin.userId,
    ])
    const url = InvitationCreated.parse(forErin.json()).url
    expect((await erin.req('POST', `/api/invitations/${tokenOf(url)}/accept`)).statusCode).toBe(200)
    expect(await roleIn(api, DEV_STUDIO, erin.userId)).toBe('member')
  })

  it('a workspace switch turned on after the hook read it still refuses the raise', async () => {
    expect((await setProject(alice, project, false)).statusCode).toBe(200)
    const undo = commitAfter(api, WORKSPACE_SWITCH_READ, (q) =>
      q('UPDATE workspaces SET internal_only = true WHERE id = $1', [DEV_STUDIO]),
    )
    try {
      refused(await patch(pat.userId, 'member'), 'workspace')
    } finally {
      undo()
    }
    expect(await roleIn(api, DEV_STUDIO, pat.userId)).toBe('guest')
  })
})

describe('minor: a direct grant decides the switch in its own transaction', () => {
  it('PUT board members: a move into an internal-only project after the hook read is still refused', async () => {
    const api = await createTestApi()
    try {
      const alice = await api.login('alice')
      const bob = await api.login('bob')
      const pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
      await addMember(api, DEV_STUDIO, pat.userId, 'guest')
      const open = await newProject(bob, DEV_STUDIO, 'Open')
      const secret = await newProject(bob, DEV_STUDIO, 'Secret')
      expect((await setProject(alice, secret, true)).statusCode).toBe(200)
      const board = await createBoard(bob, DEV_STUDIO, 'Plan')
      expect((await move(bob, board, open)).statusCode).toBe(200)
      const undo = commitAfter(api, BOARD_SWITCH_READ, (q) =>
        q('UPDATE boards SET project_id = $2 WHERE id = $1', [board, secret]),
      )
      try {
        refused(
          await bob.req('PUT', `/api/boards/${board}/members/${pat.userId}`, { role: 'editor' }),
          'project',
        )
      } finally {
        undo()
      }
      expect((await grantsOf(api, board))[pat.userId]).toBeUndefined()
      // Without the race, a board outside the switch is shared as before.
      const other = await createBoard(bob, DEV_STUDIO, 'Other')
      expect(
        (await bob.req('PUT', `/api/boards/${other}/members/${pat.userId}`, { role: 'editor' })).statusCode,
      ).toBe(200)
    } finally {
      await api.close()
    }
  })

  it('the email invite’s granted path (Clerk): a switch turned on after the hook read is still refused', async () => {
    const w: ClerkWorld = await clerkWorld()
    try {
      clerkUser('user_alice', ['lobby-test-alice@darkburn.com'])
      clerkUser('user_kim', ['kim@client.example.test'])
      const alice = await w.signIn('user_alice')
      const kim = await w.signIn('user_kim')
      const wid = alice.personalWorkspaceId
      const project = await newProject(alice, wid, 'Secret')
      const board = await createBoard(alice, wid, 'Plan')
      expect((await move(alice, board, project)).statusCode).toBe(200)
      const undo = commitAfter(w.api, BOARD_SWITCH_READ, (q) =>
        q('UPDATE projects SET internal_only = true WHERE id = $1', [project]),
      )
      try {
        refused(
          await alice.req('POST', `/api/boards/${board}/invitations/email`, {
            role: 'editor',
            email: 'kim@client.example.test',
          }),
          'project',
        )
      } finally {
        undo()
      }
      expect((await grantsOf(w.api, board))[kim.userId]).toBeUndefined()
      expect((await kim.req('GET', `/api/boards/${board}`)).statusCode).not.toBe(200)
    } finally {
      await w.api.close()
    }
  })
})
