import { BoardDetail, BoardWithRole, ListBoardsResponse, Project } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
} from './helpers.ts'

let api: TestApi
let alice: Client // Dev Studio owner (first login)
let bob: Client // Dev Studio member
let carol: Client // Dev Studio member

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
})
afterEach(() => api.close())

const list = async (c: Client, wid: string, query = '') => {
  const res = await c.req('GET', `/api/workspaces/${wid}/boards${query}`)
  expect(res.statusCode, res.body).toBe(200)
  return ListBoardsResponse.parse(res.json()).boards
}
const audits = async (action: string) =>
  (await api.db.query<{ target: string }>('SELECT target FROM audit_events WHERE action = $1', [action])).rows

describe('create + get', () => {
  it('creates a private board owned by its creator', async () => {
    const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: '  Roadmap  ' })
    expect(res.statusCode).toBe(201)
    const board = BoardWithRole.parse(res.json())
    expect(board).toMatchObject({
      workspaceId: DEV_STUDIO,
      title: 'Roadmap',
      visibility: 'private',
      status: 'active',
      createdBy: bob.userId,
      role: 'owner',
      projectId: null,
      trashedAt: null,
      lastOpenedAt: null,
    })
    expect(board.id).toMatch(/^b-[0-9a-z]{10}$/)
    const grant = await api.db.one('SELECT role, added_by FROM board_members WHERE board_id = $1', [board.id])
    expect(grant).toEqual({ role: 'owner', added_by: bob.userId })
  })

  it('takes authorship from the session, never from the body', async () => {
    const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, {
      title: 'Mine',
      createdBy: carol.userId,
      workspaceId: bob.personalWorkspaceId,
      visibility: 'workspace_edit',
      status: 'archived',
    })
    const board = BoardWithRole.parse(res.json())
    expect(board).toMatchObject({
      createdBy: bob.userId,
      workspaceId: DEV_STUDIO,
      visibility: 'private',
      status: 'active',
    })
    const events = await api.db.query('SELECT actor_id FROM audit_events WHERE target = $1', [board.id])
    expect(events.rows).toEqual([{ actor_id: bob.userId }])
  })

  it('validates the title', async () => {
    for (const title of ['', '   ', 'x'.repeat(121)]) {
      expect((await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title })).statusCode).toBe(400)
    }
    expect((await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, {})).statusCode).toBe(400)
  })

  it('GET returns board, role and workspace, and touches last_opened_at only', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Plan')
    const before = await api.db.one<{ updated_at: Date }>('SELECT updated_at FROM boards WHERE id = $1', [id])
    const res = await bob.req('GET', `/api/boards/${id}`)
    expect(res.statusCode).toBe(200)
    const detail = BoardDetail.parse(res.json())
    expect(detail.role).toBe('owner')
    expect(detail.workspace).toEqual({ id: DEV_STUDIO, name: 'Dev Studio', role: 'member' })
    expect(detail.board.lastOpenedAt).not.toBeNull()
    expect(detail.board.updatedAt).toBe(before.updated_at.toISOString())
  })

  it("GET states the caller's workspace role as it is now (wave M round 2: the board cache is for members only)", async () => {
    const id = await createBoard(alice, DEV_STUDIO, 'Grants')
    expect(
      (await alice.req('PUT', `/api/boards/${id}/members/${carol.userId}`, { role: 'editor' })).statusCode,
    ).toBe(200)
    const roleOf = async () =>
      BoardDetail.parse((await carol.req('GET', `/api/boards/${id}`)).json()).workspace.role
    expect(await roleOf()).toBe('member')
    // lowered to workspace guest: the board grant stays, so the board still answers, with the new role
    const patch = await alice.req('PATCH', `/api/workspaces/${DEV_STUDIO}/members/${carol.userId}`, {
      role: 'guest',
    })
    expect(patch.statusCode, patch.body).toBe(200)
    expect(await roleOf()).toBe('guest')
    expect(BoardDetail.parse((await alice.req('GET', `/api/boards/${id}`)).json()).workspace.role).toBe(
      'owner',
    )
  })

  it('guests cannot create boards; non-members get 404 for the workspace', async () => {
    await api.db.query(
      "UPDATE workspace_members SET role = 'guest' WHERE user_id = $1 AND workspace_id = $2",
      [carol.userId, DEV_STUDIO],
    )
    expect((await carol.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'x' })).statusCode).toBe(
      403,
    )
    expect(
      (await carol.req('POST', `/api/workspaces/${bob.personalWorkspaceId}/boards`, { title: 'x' }))
        .statusCode,
    ).toBe(404)
  })

  it('requires a signed-in user', async () => {
    expect((await api.anon('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'x' })).statusCode).toBe(
      401,
    )
    expect((await api.anon('GET', `/api/workspaces/${DEV_STUDIO}/boards`)).statusCode).toBe(401)
  })
})

describe('visibility: private by default', () => {
  it('other members cannot see or open a private board until it is shared or visibility changes', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Secret')
    expect((await list(carol, DEV_STUDIO)).map((b) => b.id)).not.toContain(id)
    expect((await carol.req('GET', `/api/boards/${id}`)).statusCode).toBe(404)
    expect((await carol.req('GET', `/api/boards/${id}/members`)).statusCode).toBe(404)

    // workspace_view -> every member can view (not edit)
    expect((await bob.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_view' })).statusCode).toBe(
      200,
    )
    const seen = (await list(carol, DEV_STUDIO)).find((b) => b.id === id)
    expect(seen?.role).toBe('viewer')
    expect(BoardDetail.parse((await carol.req('GET', `/api/boards/${id}`)).json()).role).toBe('viewer')

    // workspace_edit -> editor
    await bob.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_edit' })
    expect((await list(carol, DEV_STUDIO)).find((b) => b.id === id)?.role).toBe('editor')

    // back to private -> gone again
    await bob.req('PATCH', `/api/boards/${id}`, { visibility: 'private' })
    expect((await carol.req('GET', `/api/boards/${id}`)).statusCode).toBe(404)

    // an explicit grant also shares it
    expect(
      (await bob.req('PUT', `/api/boards/${id}/members/${carol.userId}`, { role: 'commenter' })).statusCode,
    ).toBe(200)
    expect((await list(carol, DEV_STUDIO)).find((b) => b.id === id)?.role).toBe('commenter')
  })

  it('workspace owners/admins see every board as owner', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Private to bob')
    expect((await list(alice, DEV_STUDIO)).find((b) => b.id === id)?.role).toBe('owner')
    expect(BoardDetail.parse((await alice.req('GET', `/api/boards/${id}`)).json()).role).toBe('owner')
  })

  it('records visibility changes in the audit log and tells sync', async () => {
    const id = await createBoard(bob, DEV_STUDIO)
    api.notifications.length = 0
    await bob.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_view' })
    expect(api.notifications).toEqual([{ boardId: id }])
    expect(await audits('board.visibility')).toEqual([{ target: id }])
    // Same value again: no change, no notification.
    await bob.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_view' })
    expect(api.notifications).toHaveLength(1)
  })
})

describe('patch permissions', () => {
  it('editors can rename but not change visibility; commenters and viewers can do neither', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Old')
    await bob.req('PUT', `/api/boards/${id}/members/${carol.userId}`, { role: 'editor' })
    const renamed = await carol.req('PATCH', `/api/boards/${id}`, { title: 'New' })
    expect(renamed.statusCode).toBe(200)
    expect(BoardWithRole.parse(renamed.json())).toMatchObject({ title: 'New', role: 'editor' })
    expect((await carol.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_edit' })).statusCode).toBe(
      403,
    )

    for (const role of ['commenter', 'viewer'] as const) {
      await bob.req('PUT', `/api/boards/${id}/members/${carol.userId}`, { role })
      expect((await carol.req('PATCH', `/api/boards/${id}`, { title: 'Nope' })).statusCode, role).toBe(403)
      expect(
        (await carol.req('PATCH', `/api/boards/${id}`, { visibility: 'workspace_edit' })).statusCode,
        role,
      ).toBe(403)
      expect(
        (await carol.req('PUT', `/api/boards/${id}/members/${alice.userId}`, { role: 'viewer' })).statusCode,
        role,
      ).toBe(403)
      expect(
        (
          await carol.req('POST', `/api/boards/${id}/invitations`, {
            role: 'viewer',
            email: 'pat@client.example.test',
          })
        ).statusCode,
        role,
      ).toBe(403)
      expect((await carol.req('POST', `/api/boards/${id}/archive`)).statusCode, role).toBe(403)
    }
    const row = await api.db.one('SELECT title, visibility FROM boards WHERE id = $1', [id])
    expect(row).toEqual({ title: 'New', visibility: 'private' })
  })

  it('rejects an empty patch and unknown projects', async () => {
    const id = await createBoard(bob, DEV_STUDIO)
    expect((await bob.req('PATCH', `/api/boards/${id}`, {})).statusCode).toBe(400)
    expect(
      (await bob.req('PATCH', `/api/boards/${id}`, { projectId: 'prj_00000000000000000000' })).statusCode,
    ).toBe(400)
  })
})

describe('projects', () => {
  it('create, list, rename, archive; boards can join a project of their own workspace only', async () => {
    const created = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Q3' })
    expect(created.statusCode).toBe(201)
    const project = Project.parse(created.json())
    expect(project).toMatchObject({ workspaceId: DEV_STUDIO, name: 'Q3', archivedAt: null })

    const listRes = await carol.req('GET', `/api/workspaces/${DEV_STUDIO}/projects`)
    expect(listRes.json().projects.map((p: { id: string }) => p.id)).toEqual([project.id])

    const renamed = await carol.req('PATCH', `/api/projects/${project.id}`, { name: 'Q3 plan' })
    expect(Project.parse(renamed.json()).name).toBe('Q3 plan')
    const archived = Project.parse(
      (await bob.req('PATCH', `/api/projects/${project.id}`, { archived: true })).json(),
    )
    expect(archived.archivedAt).not.toBeNull()
    const unarchived = Project.parse(
      (await bob.req('PATCH', `/api/projects/${project.id}`, { archived: false })).json(),
    )
    expect(unarchived.archivedAt).toBeNull()

    const inProject = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, {
      title: 'P',
      projectId: project.id,
    })
    expect(BoardWithRole.parse(inProject.json()).projectId).toBe(project.id)
    const other = await createBoard(bob, DEV_STUDIO, 'Other')
    const filtered = await list(bob, DEV_STUDIO, `?projectId=${project.id}`)
    expect(filtered.map((b) => b.title)).toEqual(['P'])
    expect(filtered.map((b) => b.id)).not.toContain(other)

    // A project from bob's personal workspace cannot hold a Dev Studio board.
    const foreign = Project.parse(
      (await bob.req('POST', `/api/workspaces/${bob.personalWorkspaceId}/projects`, { name: 'Mine' })).json(),
    )
    expect(
      (await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'X', projectId: foreign.id }))
        .statusCode,
    ).toBe(400)
    expect((await bob.req('PATCH', `/api/boards/${other}`, { projectId: foreign.id })).statusCode).toBe(400)
    // Moving out of a project.
    const moved = await bob.req('PATCH', `/api/boards/${BoardWithRole.parse(inProject.json()).id}`, {
      projectId: null,
    })
    expect(BoardWithRole.parse(moved.json()).projectId).toBeNull()
  })

  it('guests cannot list or create projects', async () => {
    await api.db.query(
      "UPDATE workspace_members SET role = 'guest' WHERE user_id = $1 AND workspace_id = $2",
      [carol.userId, DEV_STUDIO],
    )
    const project = Project.parse(
      (await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Q' })).json(),
    )
    expect((await carol.req('GET', `/api/workspaces/${DEV_STUDIO}/projects`)).statusCode).toBe(403)
    expect(
      (await carol.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'x' })).statusCode,
    ).toBe(403)
    expect((await carol.req('PATCH', `/api/projects/${project.id}`, { name: 'x' })).statusCode).toBe(404)
    expect((await carol.req('GET', `/api/workspaces/${DEV_STUDIO}/members`)).statusCode).toBe(403)
  })
})

describe('listing', () => {
  it('filters by status and title, most recently opened first', async () => {
    const a = await createBoard(bob, DEV_STUDIO, 'Alpha plan')
    const b = await createBoard(bob, DEV_STUDIO, 'Beta 100%_done')
    const c = await createBoard(bob, DEV_STUDIO, 'Gamma')
    api.clock.advance(1000)
    await bob.req('GET', `/api/boards/${a}`)
    api.clock.advance(1000)
    await bob.req('GET', `/api/boards/${c}`)
    expect((await list(bob, DEV_STUDIO)).map((x) => x.id)).toEqual([c, a, b])
    expect((await list(bob, DEV_STUDIO, '?q=PLAN')).map((x) => x.id)).toEqual([a])
    // LIKE wildcards in the query are literal
    expect((await list(bob, DEV_STUDIO, `?q=${encodeURIComponent('%_')}`)).map((x) => x.id)).toEqual([b])
    expect((await list(bob, DEV_STUDIO, `?q=${encodeURIComponent('%')}`)).map((x) => x.id)).toEqual([b])
    await bob.req('POST', `/api/boards/${b}/archive`)
    expect((await list(bob, DEV_STUDIO, '?status=archived')).map((x) => x.id)).toEqual([b])
    expect((await list(bob, DEV_STUDIO)).map((x) => x.id)).toEqual([c, a])
    expect((await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards?status=deleted`)).statusCode).toBe(400)
  })
})

describe('archive / trash / restore', () => {
  it('owner archives (read-only), trashes (hidden) and restores; each step is audited and pushed to sync', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Lifecycle')
    await bob.req('PUT', `/api/boards/${id}/members/${carol.userId}`, { role: 'editor' })
    api.notifications.length = 0

    const archived = await bob.req('POST', `/api/boards/${id}/archive`)
    expect(BoardWithRole.parse(archived.json())).toMatchObject({ status: 'archived', trashedAt: null })
    // Archived: still visible, but not editable (rename is refused for the editor).
    expect(BoardDetail.parse((await carol.req('GET', `/api/boards/${id}`)).json()).board.status).toBe(
      'archived',
    )
    expect((await carol.req('PATCH', `/api/boards/${id}`, { title: 'x' })).statusCode).toBe(403)

    const trashed = await bob.req('POST', `/api/boards/${id}/trash`)
    expect(BoardWithRole.parse(trashed.json())).toMatchObject({
      status: 'trashed',
      trashedAt: expect.any(String),
    })
    // Trashed: nobody can open it (owners neither); only owners see it in the trash list.
    expect((await carol.req('GET', `/api/boards/${id}`)).statusCode).toBe(404)
    expect((await bob.req('GET', `/api/boards/${id}`)).statusCode).toBe(404)
    expect((await list(bob, DEV_STUDIO, '?status=trashed')).map((b) => b.id)).toEqual([id])
    expect((await list(carol, DEV_STUDIO, '?status=trashed')).map((b) => b.id)).toEqual([])
    expect((await carol.req('POST', `/api/boards/${id}/restore`)).statusCode).toBe(404)

    const restored = await bob.req('POST', `/api/boards/${id}/restore`)
    expect(BoardWithRole.parse(restored.json())).toMatchObject({ status: 'active', trashedAt: null })
    expect(BoardDetail.parse((await carol.req('GET', `/api/boards/${id}`)).json()).role).toBe('editor')

    expect(api.notifications).toEqual([{ boardId: id }, { boardId: id }, { boardId: id }])
    for (const action of ['board.archive', 'board.trash', 'board.restore'])
      expect(await audits(action), action).toEqual([{ target: id }])
  })

  it('repeating a transition is a no-op for owners; archiving a trashed board is a conflict', async () => {
    const id = await createBoard(bob, DEV_STUDIO)
    await bob.req('POST', `/api/boards/${id}/archive`)
    api.notifications.length = 0
    expect((await bob.req('POST', `/api/boards/${id}/archive`)).statusCode).toBe(200)
    expect((await bob.req('POST', `/api/boards/${id}/trash`)).statusCode).toBe(200)
    expect((await bob.req('POST', `/api/boards/${id}/trash`)).statusCode).toBe(200)
    const conflict = await bob.req('POST', `/api/boards/${id}/archive`)
    expect(conflict.statusCode).toBe(409)
    expect(api.notifications).toHaveLength(1) // only the real archived -> trashed change
  })

  it('editors cannot archive, trash or restore', async () => {
    const id = await createBoard(bob, DEV_STUDIO)
    await bob.req('PUT', `/api/boards/${id}/members/${carol.userId}`, { role: 'editor' })
    for (const action of ['archive', 'trash', 'restore'])
      expect((await carol.req('POST', `/api/boards/${id}/${action}`)).statusCode, action).toBe(403)
    expect((await api.db.one('SELECT status FROM boards WHERE id = $1', [id])).status).toBe('active')
  })
})

describe('GET /internal/boards/:bid/touched (canvas edits, RETRO-19)', () => {
  const touched = (bid: string, at?: number, secret: string | null = INTERNAL_SECRET) =>
    api.app.inject({
      method: 'GET',
      url: `/internal/boards/${bid}/touched${at === undefined ? '' : `?at=${at}`}`,
      headers: secret === null ? {} : { 'x-draftroom-internal': secret },
    })
  const updatedAt = async (id: string) =>
    (await api.db.one<{ updated_at: Date }>('SELECT updated_at FROM boards WHERE id = $1', [id])).updated_at

  it('moves updated_at forward to the edit time, so the list says "edited" and sorts by it; never backwards or into the future', async () => {
    const older = await createBoard(bob, DEV_STUDIO, 'Older board')
    api.clock.advance(60 * 60_000)
    const newer = await createBoard(bob, DEV_STUDIO, 'Newer board')
    const created = await updatedAt(older)
    api.clock.advance(10 * 60_000)
    const editAt = api.clock.now().getTime() - 1_000
    const res = await touched(older, editAt)
    expect(res.statusCode, res.body).toBe(204)
    expect((await updatedAt(older)).getTime()).toBe(editAt)
    // M1's list (and the dashboard's "Edited …" / "Last edited" sort) now puts it first.
    const boards = await list(bob, DEV_STUDIO)
    expect(boards.map((b) => b.title).slice(0, 2)).toEqual(['Older board', 'Newer board'])
    expect(boards.find((b) => b.id === older)?.updatedAt).toBe(new Date(editAt).toISOString())
    // an older report (a late trailing call) changes nothing
    expect((await touched(older, created.getTime())).statusCode).toBe(204)
    expect((await updatedAt(older)).getTime()).toBe(editAt)
    // a clock ahead of ours is clamped to now; no `at` means now
    const future = api.clock.now().getTime() + 86_400_000
    expect((await touched(newer, future)).statusCode).toBe(204)
    expect((await updatedAt(newer)).getTime()).toBeLessThanOrEqual(api.clock.now().getTime())
    expect((await touched(newer)).statusCode).toBe(204)
    // opening a board is still not an edit
    api.clock.advance(5 * 60_000)
    const before = await updatedAt(older)
    expect((await bob.req('GET', `/api/boards/${older}`)).statusCode).toBe(200)
    expect(await updatedAt(older)).toEqual(before)
  })

  it('requires the internal secret (a browser session is not one); unknown or trashed boards change nothing', async () => {
    const id = await createBoard(bob, DEV_STUDIO, 'Secret board')
    const before = await updatedAt(id)
    api.clock.advance(60_000)
    expect((await touched(id, undefined, null)).statusCode).toBe(401)
    expect((await touched(id, undefined, 'x'.repeat(INTERNAL_SECRET.length))).statusCode).toBe(401)
    const withCookie = await api.app.inject({
      method: 'GET',
      url: `/internal/boards/${id}/touched`,
      headers: { cookie: bob.cookie },
    })
    expect(withCookie.statusCode).toBe(401)
    expect(await updatedAt(id)).toEqual(before)
    expect((await touched('b-doesnotexist')).statusCode).toBe(204)
    expect((await touched('not a board id')).statusCode).toBe(404)
    expect((await touched(id, -5)).statusCode).toBe(400)

    expect((await bob.req('POST', `/api/boards/${id}/trash`)).statusCode).toBe(200)
    const trashedAt = await updatedAt(id)
    api.clock.advance(60_000)
    expect((await touched(id)).statusCode).toBe(204)
    expect(await updatedAt(id)).toEqual(trashedAt)
  })
})
