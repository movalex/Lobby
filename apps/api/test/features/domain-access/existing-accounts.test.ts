// Decision 4 (docs/DOMAIN-ACCESS-CONTRACTS.md §0, §5; §11.1 existing-accounts.test.ts): existing
// accounts keep every membership, grant and ownership they have. Losing creator status removes
// nothing; it only stops creating and handing out access.

import { Me } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, devEmail, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, noteRec } from '../history/helpers.ts'

let api: TestApi
let alice: Client // Dev Studio owner
let bob: Client // the existing account under test
let ownBoard: string // bob's own board (personal workspace)
let studioBoard: string // a Dev Studio board bob owns
let grantedBoard: string // alice's board, bob is an editor by grant
let snapshot: string

beforeEach(async () => {
  const sync = createFakeSync()
  api = await createTestApi({
    deps: { syncInternal: sync },
    env: { DRAFTROOM_CREATOR_EMAILS: 'owner@personal.example.test' },
  })
  alice = await api.login('alice')
  bob = await api.login('bob', 'Bob')
  ownBoard = await createBoard(bob, bob.personalWorkspaceId, 'Mine')
  studioBoard = await createBoard(bob, DEV_STUDIO, 'Studio board')
  grantedBoard = await createBoard(alice, DEV_STUDIO, 'Granted')
  for (const b of [ownBoard, studioBoard, grantedBoard])
    sync.setBoard(b, [...baseRecords(), noteRec('n1', 'x')])
  expect(
    (await alice.req('PUT', `/api/boards/${grantedBoard}/members/${bob.userId}`, { role: 'editor' }))
      .statusCode,
  ).toBe(200)
  snapshot = (await bob.req('POST', `/api/boards/${studioBoard}/snapshots`, { name: 'v1' })).json().id
})
afterEach(() => api.close())

describe('an existing account that is no longer a creator', () => {
  it('keeps every workspace, grant and ownership; boards open with the same role and tickets work', async () => {
    const before = Me.parse((await bob.req('GET', '/api/me')).json())
    const roles: Record<string, string> = {}
    for (const b of [ownBoard, studioBoard, grantedBoard])
      roles[b] = (await bob.req('GET', `/api/boards/${b}`)).json().role

    // The same handle signs in again with an outside address (every dev login replaces the address).
    const outside = await api.login('bob', undefined, { email: 'bob@client.example.test' })
    expect(outside.userId).toBe(bob.userId)
    expect(outside.me.access).toEqual({ creator: false, reason: 'outside', email: 'bob@client.example.test' })
    expect(outside.me.workspaces).toEqual(before.workspaces)
    const me = Me.parse((await outside.req('GET', '/api/me')).json())
    expect(me.workspaces).toEqual(before.workspaces)
    for (const b of [ownBoard, studioBoard, grantedBoard]) {
      expect((await outside.req('GET', `/api/boards/${b}`)).json().role).toBe(roles[b])
      const ticket = await outside.req('POST', `/api/boards/${b}/ticket`)
      expect(ticket.statusCode, ticket.body).toBe(200)
    }
    expect(roles).toEqual({ [ownBoard]: 'owner', [studioBoard]: 'owner', [grantedBoard]: 'editor' })
  })

  it('every create and hand-out route answers 403 CREATOR_REQUIRED', async () => {
    const outside = await api.login('bob', undefined, { email: 'bob@client.example.test' })
    const project = (await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'P' })).json()
      .id
    const probes: [string, string, unknown][] = [
      [`/api/workspaces/${outside.personalWorkspaceId}/boards`, 'POST', { title: 'x' }],
      [`/api/workspaces/${DEV_STUDIO}/boards`, 'POST', { title: 'x' }],
      [`/api/workspaces/${outside.personalWorkspaceId}/projects`, 'POST', { name: 'x' }],
      [`/api/projects/${project}`, 'PATCH', { name: 'x' }],
      [`/api/workspaces/${outside.personalWorkspaceId}/boards/import`, 'POST', {}],
      [`/api/boards/${ownBoard}/duplicate`, 'POST', {}],
      [`/api/snapshots/${snapshot}/restore-as-new`, 'POST', {}],
      [
        `/api/workspaces/${outside.personalWorkspaceId}/invitations`,
        'POST',
        { role: 'member', email: devEmail('x') },
      ],
      [`/api/boards/${ownBoard}/invitations`, 'POST', { role: 'viewer', email: devEmail('x') }],
      [`/api/boards/${ownBoard}/invitations/email`, 'POST', { role: 'viewer', email: devEmail('x') }],
      [`/api/boards/${ownBoard}/review-links`, 'POST', { role: 'viewer' }],
      [`/api/boards/${ownBoard}/transfer-ownership`, 'POST', { userId: alice.userId }],
    ]
    const counts = async () =>
      await api.db.one<{ b: number; p: number; i: number }>(
        'SELECT (SELECT count(*)::int FROM boards) AS b, (SELECT count(*)::int FROM projects) AS p, (SELECT count(*)::int FROM invitations) AS i',
      )
    const before = await counts()
    for (const [url, method, body] of probes) {
      const res = await outside.req(method as 'POST', url, body)
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403)
      expect(res.json().error.code, url).toBe('CREATOR_REQUIRED')
    }
    expect(await counts()).toEqual(before)
    // Board settings that are not access stay the owner's (§15): renaming, archiving.
    expect((await outside.req('PATCH', `/api/boards/${ownBoard}`, { title: 'Renamed' })).statusCode).toBe(200)
    expect((await outside.req('POST', `/api/boards/${ownBoard}/archive`)).statusCode).toBe(200)
  })

  it('the exception address keeps full rights and never gets a second personal workspace', async () => {
    const owner = await api.login('bob', undefined, { email: 'owner@personal.example.test' })
    expect(owner.me.access).toEqual({
      creator: true,
      reason: 'exception',
      email: 'owner@personal.example.test',
    })
    expect(
      (await owner.req('POST', `/api/workspaces/${owner.personalWorkspaceId}/boards`, { title: 'x' }))
        .statusCode,
    ).toBe(201)
    await owner.req('GET', '/api/me')
    await api.login('bob', undefined, { email: 'owner@personal.example.test' })
    const personal = await api.db.query('SELECT id FROM workspaces WHERE personal_of = $1', [bob.userId])
    expect(personal.rows).toEqual([{ id: bob.personalWorkspaceId }])
    const owned = await api.db.query(
      "SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner'",
      [bob.userId],
    )
    expect(owned.rows).toEqual([{ workspace_id: bob.personalWorkspaceId }])
  })
})
