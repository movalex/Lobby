// Tenant boundary: a user of workspace A must not be able to read, change or even detect workspace
// B's boards, members, projects, tickets or invitations by id. Every probe answers 404, exactly like
// an id that does not exist.

import { InvitationCreated, Project } from '@draftroom/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, devEmail, type TestApi } from './helpers.ts'

let api: TestApi
let owner: Client // owns workspace B (their personal workspace)
let intruder: Client // member of workspace A only
let wsB: string
let boardB: string
let projectB: string
let invitationB: string
let boardInviteB: string
// Domain access: single-use invitations name an address (so the 400 for a missing one never masks a 404).
const INVITEE = devEmail('invitee')

beforeAll(async () => {
  api = await createTestApi()
  owner = await api.login('owner-b')
  intruder = await api.login('intruder')
  wsB = owner.personalWorkspaceId
  boardB = await createBoard(owner, wsB, 'Tenant B board')
  // Even workspace-wide visibility must not leak across workspaces.
  await owner.req('PATCH', `/api/boards/${boardB}`, { visibility: 'workspace_edit' })
  projectB = Project.parse(
    (await owner.req('POST', `/api/workspaces/${wsB}/projects`, { name: 'B' })).json(),
  ).id
  invitationB = InvitationCreated.parse(
    (
      await owner.req('POST', `/api/workspaces/${wsB}/invitations`, { role: 'member', email: INVITEE })
    ).json(),
  ).id
  boardInviteB = InvitationCreated.parse(
    (await owner.req('POST', `/api/boards/${boardB}/invitations`, { role: 'viewer', email: INVITEE })).json(),
  ).id
  // Both users also share Dev Studio; that shared tenant must not bridge into B.
})
afterAll(() => api.close())

const probes = (): Array<[string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, unknown]> => [
  ['list boards', 'GET', `/api/workspaces/${wsB}/boards`, undefined],
  ['create board', 'POST', `/api/workspaces/${wsB}/boards`, { title: 'x' }],
  ['get board', 'GET', `/api/boards/${boardB}`, undefined],
  ['patch board', 'PATCH', `/api/boards/${boardB}`, { title: 'pwned' }],
  ['archive', 'POST', `/api/boards/${boardB}/archive`, undefined],
  ['trash', 'POST', `/api/boards/${boardB}/trash`, undefined],
  ['restore', 'POST', `/api/boards/${boardB}/restore`, undefined],
  ['members', 'GET', `/api/boards/${boardB}/members`, undefined],
  ['grant self', 'PUT', `/api/boards/${boardB}/members/placeholder`, { role: 'owner' }],
  ['revoke owner', 'DELETE', `/api/boards/${boardB}/members/placeholder-owner`, undefined],
  ['ticket', 'POST', `/api/boards/${boardB}/ticket`, undefined],
  ['board invitation', 'POST', `/api/boards/${boardB}/invitations`, { role: 'viewer', email: INVITEE }],
  ['workspace invitation', 'POST', `/api/workspaces/${wsB}/invitations`, { role: 'member', email: INVITEE }],
  ['revoke ws invitation', 'DELETE', `/api/invitations/${invitationB}`, undefined],
  ['revoke board invitation', 'DELETE', `/api/invitations/${boardInviteB}`, undefined],
  ['workspace members', 'GET', `/api/workspaces/${wsB}/members`, undefined],
  ['projects', 'GET', `/api/workspaces/${wsB}/projects`, undefined],
  ['create project', 'POST', `/api/workspaces/${wsB}/projects`, { name: 'x' }],
  ['patch project', 'PATCH', `/api/projects/${projectB}`, { name: 'pwned' }],
  [
    'file meta',
    'GET',
    `/api/boards/${boardB}/assets/ast_00000000000000000000/ver_00000000000000000000`,
    undefined,
  ],
]

describe('tenant isolation', () => {
  it('every workspace-B resource is 404 for a user outside workspace B', async () => {
    for (const [name, method, rawUrl, body] of probes()) {
      const url = rawUrl.replace('placeholder-owner', owner.userId).replace('placeholder', intruder.userId)
      const res = await intruder.req(method, url, body)
      expect(res.statusCode, `${name}: ${res.body}`).toBe(404)
      expect(res.json().error.code, name).toBe('NOT_FOUND')
    }
  })

  it('answers exactly like ids that do not exist', async () => {
    const missing = await intruder.req('GET', '/api/boards/b-0000000000')
    const foreign = await intruder.req('GET', `/api/boards/${boardB}`)
    expect(foreign.statusCode).toBe(missing.statusCode)
    expect(foreign.body).toBe(missing.body)
    const missingWs = await intruder.req('GET', '/api/workspaces/wsp_00000000000000000000/boards')
    const foreignWs = await intruder.req('GET', `/api/workspaces/${wsB}/boards`)
    expect(foreignWs.body).toBe(missingWs.body)
  })

  it('changed nothing in workspace B', async () => {
    const board = await api.db.one('SELECT title, status FROM boards WHERE id = $1', [boardB])
    expect(board).toEqual({ title: 'Tenant B board', status: 'active' })
    const project = await api.db.one('SELECT name FROM projects WHERE id = $1', [projectB])
    expect(project).toEqual({ name: 'B' })
    const grants = await api.db.query('SELECT user_id FROM board_members WHERE board_id = $1', [boardB])
    expect(grants.rows).toEqual([{ user_id: owner.userId }])
    const invites = await api.db.query('SELECT revoked_at FROM invitations WHERE workspace_id = $1', [wsB])
    expect(invites.rows.every((r) => r.revoked_at === null)).toBe(true)
    const intruderMemberships = await api.db.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [wsB, intruder.userId],
    )
    expect(intruderMemberships.rows).toEqual([])
  })

  it("the owner's boards never appear in another workspace's listings", async () => {
    for (const ws of intruder.me.workspaces) {
      const res = await intruder.req('GET', `/api/workspaces/${ws.id}/boards`)
      expect(res.json().boards.map((b: { id: string }) => b.id)).not.toContain(boardB)
    }
  })

  it('a stale board grant does not survive leaving the workspace', async () => {
    const id = await createBoard(owner, wsB, 'Was shared')
    await api.db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [wsB, intruder.userId],
    )
    await owner.req('PUT', `/api/boards/${id}/members/${intruder.userId}`, { role: 'editor' })
    expect((await intruder.req('GET', `/api/boards/${id}`)).statusCode).toBe(200)
    await api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      wsB,
      intruder.userId,
    ])
    expect((await intruder.req('GET', `/api/boards/${id}`)).statusCode).toBe(404)
    expect((await intruder.req('POST', `/api/boards/${id}/ticket`)).statusCode).toBe(404)
  })
})
