// POST /api/boards/:bid/duplicate (DSH-02) and the files of a restored-from-trash board (DSH-03).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import {
  assertValid,
  baseRecords,
  createFakeSync,
  type FakeSync,
  fileStatus,
  imageAssetRec,
  imageRec,
  noteRec,
  upload,
} from './helpers.ts'

let api: TestApi
let sync: FakeSync
let bob: Client
let carol: Client
let dave: Client
let boardId: string

beforeEach(async () => {
  sync = createFakeSync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  await api.login('owner')
  bob = await api.login('bob')
  carol = await api.login('carol')
  dave = await api.login('dave')
  boardId = await createBoard(bob, DEV_STUDIO, 'Moodboard')
  sync.setBoard(boardId, [...baseRecords(), noteRec('n1', 'live content')])
})
afterEach(() => api.close())

const duplicate = (c: Client, body: unknown = {}, bid = boardId) =>
  c.req('POST', `/api/boards/${bid}/duplicate`, body)
const grant = (role: string, who: Client) =>
  bob.req('PUT', `/api/boards/${boardId}/members/${who.userId}`, { role })
const membersOf = async (bid: string) =>
  (
    await api.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM board_members WHERE board_id = $1 ORDER BY role, user_id',
      [bid],
    )
  ).rows

describe('POST /api/boards/:bid/duplicate', () => {
  it('copies the live board into a private board owned by the caller', async () => {
    await bob.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_view' })
    await grant('editor', carol)
    const res = await duplicate(bob)
    expect(res.statusCode).toBe(201)
    const { board } = res.json()
    expect(board).toMatchObject({ title: 'Copy of Moodboard', visibility: 'private', role: 'owner' })
    expect(sync.records(board.id).map((r) => r.id)).toEqual(sync.records(boardId).map((r) => r.id))
    expect(await membersOf(board.id)).toEqual([{ user_id: bob.userId, role: 'owner' }])
    expect((await carol.req('GET', `/api/boards/${board.id}`)).statusCode).toBe(404)
  })

  it('keepSharing (owner only) copies visibility and people grants, never links', async () => {
    await bob.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_view' })
    await grant('editor', carol)
    await grant('commenter', dave)
    await bob.req('POST', `/api/boards/${boardId}/invitations`, { role: 'viewer' })
    const res = await duplicate(bob, { keepSharing: true, title: 'Shared copy' })
    expect(res.statusCode).toBe(201)
    const { board } = res.json()
    expect(board).toMatchObject({ title: 'Shared copy', visibility: 'workspace_view' })
    expect(await membersOf(board.id)).toEqual(
      [
        { user_id: dave.userId, role: 'commenter' },
        { user_id: carol.userId, role: 'editor' },
        { user_id: bob.userId, role: 'owner' },
      ].sort((a, b) => (a.role + a.user_id < b.role + b.user_id ? -1 : 1)),
    )
    expect((await api.db.query('SELECT 1 FROM invitations WHERE board_id = $1', [board.id])).rowCount).toBe(0)
    expect((await carol.req('GET', `/api/boards/${board.id}`)).json().role).toBe('editor')
    // an editor of the source may duplicate, but not with its sharing settings
    expect((await duplicate(carol, { keepSharing: true })).statusCode).toBe(403)
    expect((await duplicate(carol)).statusCode).toBe(201)
  })

  it('viewers may duplicate (view + member); outsiders 404, guests 403, signed-out 401', async () => {
    await grant('viewer', carol)
    const res = await duplicate(carol)
    expect(res.statusCode).toBe(201)
    expect(res.json().board.role).toBe('owner')
    const outsider = await api.login('erin')
    expect((await duplicate(outsider)).statusCode).toBe(404)
    expect((await api.anon('POST', `/api/boards/${boardId}/duplicate`, {})).statusCode).toBe(401)
    expect((await duplicate(bob, { keepSharing: 'yes' })).statusCode).toBe(400)
    // guest: a board invitation into bob's personal workspace
    const personal = await createBoard(bob, bob.personalWorkspaceId, 'Personal')
    const inv = await bob.req('POST', `/api/boards/${personal}/invitations`, { role: 'editor' })
    const token = new URL(inv.json().url).pathname.split('/').pop() ?? ''
    await outsider.req('POST', `/api/invitations/${token}/accept`)
    expect((await outsider.req('GET', `/api/boards/${personal}`)).statusCode).toBe(200)
    expect((await duplicate(outsider, {}, personal)).statusCode).toBe(403)
  })

  it('works on archived boards (view) and not on trashed ones (404)', async () => {
    await bob.req('POST', `/api/boards/${boardId}/archive`)
    expect((await duplicate(bob)).statusCode).toBe(201)
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect((await duplicate(bob)).statusCode).toBe(404)
  })

  it('files follow copies of copies (transitive), for people who can view the copy', async () => {
    const photo = await upload(api, bob, boardId)
    const records = [
      ...baseRecords(),
      imageAssetRec('p', photo.assetId, photo.versionId),
      imageRec('img', 'p'),
    ]
    assertValid(records)
    sync.setBoard(boardId, records)
    const copy = (await duplicate(bob)).json().board.id
    expect(await fileStatus(bob, photo, copy)).toBe(200)
    // carol can view the copy only (not the original)
    await bob.req('PUT', `/api/boards/${copy}/members/${carol.userId}`, { role: 'viewer' })
    expect(await fileStatus(carol, photo, boardId)).toBe(404)
    expect(await fileStatus(carol, photo, copy)).toBe(200)
    const second = await duplicate(carol, {}, copy)
    expect(second.json()).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
    expect(await fileStatus(carol, photo, second.json().board.id)).toBe(200)
  })

  it('503 when the sync server is unreachable, and no board row is created', async () => {
    const count = async () => (await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n
    const before = await count()
    sync.unavailable = true
    const res = await duplicate(bob)
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('SYNC_UNAVAILABLE')
    expect(await count()).toBe(before)
  })
})

describe('restored from trash (DSH-03): content and files come back', () => {
  it('the canvas is untouched and its files are served again', async () => {
    const photo = await upload(api, bob, boardId)
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect(await fileStatus(bob, photo, boardId)).toBe(404)
    const before = JSON.stringify(sync.boards.get(boardId))
    expect((await bob.req('POST', `/api/boards/${boardId}/restore`)).statusCode).toBe(200)
    expect(await fileStatus(bob, photo, boardId)).toBe(200)
    expect(JSON.stringify(sync.boards.get(boardId))).toBe(before)
    expect(sync.seeds).toHaveLength(0) // restoring from trash never re-seeds or copies
  })
})
