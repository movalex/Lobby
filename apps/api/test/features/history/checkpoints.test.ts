// Named checkpoints (REV-08): save / list / restore as a NEW PRIVATE board (PRF-08), with files
// carried over as links, the sync seed conflict handled, tenancy and permission failures.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import {
  assertValid,
  baseRecords,
  createFakeSync,
  type FakeSync,
  fileCardRec,
  fileStatus,
  imageAssetRec,
  imageRec,
  noteRec,
  recordEvents,
  upload,
} from './helpers.ts'

let api: TestApi
let sync: FakeSync
let events: EventHub
let owner: Client // owns Dev Studio (first login)
let bob: Client // member
let carol: Client // member
let boardId: string

beforeEach(async () => {
  sync = createFakeSync()
  events = new EventHub()
  api = await createTestApi({ deps: { syncInternal: sync, events } })
  owner = await api.login('owner')
  bob = await api.login('bob')
  carol = await api.login('carol')
  boardId = await createBoard(bob, DEV_STUDIO, 'Campaign')
  const records = [...baseRecords(), noteRec('n1', 'first idea')]
  assertValid(records)
  sync.setBoard(boardId, records)
})
afterEach(() => api.close())

const save = (c: Client, name = 'Before the review', bid = boardId) =>
  c.req('POST', `/api/boards/${bid}/snapshots`, { name })
const grant = (role: string, who = carol) =>
  bob.req('PUT', `/api/boards/${boardId}/members/${who.userId}`, { role })

describe('POST /api/boards/:bid/snapshots', () => {
  it('stores the live board as a named checkpoint (atomic file + row) and tells the board', async () => {
    const got = recordEvents(events, boardId)
    const res = await save(bob)
    expect(res.statusCode).toBe(201)
    const snap = res.json()
    expect(snap).toMatchObject({
      boardId,
      name: 'Before the review',
      kind: 'manual',
      createdBy: { id: bob.userId, name: 'bob' },
      documentClock: 42,
      recordCount: 3,
    })
    expect(snap.id).toMatch(/^snp_/)
    const file = join(api.config.dataDir, 'snapshots', boardId, `${snap.id}.json`)
    const body = JSON.parse(readFileSync(file, 'utf8'))
    expect(body).toMatchObject({ format: 'draftroom-checkpoint', version: 1, boardId, documentClock: 42 })
    expect(body.documents.map((d: { state: { id: string } }) => d.state.id)).toContain('shape:n1')
    expect(snap.sizeBytes).toBe(readFileSync(file).length)
    expect(got).toEqual([{ type: 'history.snapshot', data: { snapshotId: snap.id } }])
  })

  it('needs edit: viewers and commenters get 403, outsiders 404, signed-out 401', async () => {
    for (const role of ['viewer', 'commenter']) {
      await grant(role)
      expect((await save(carol)).statusCode, role).toBe(403)
    }
    const outsider = await api.login('dave')
    expect((await save(outsider)).statusCode).toBe(404)
    expect((await api.anon('POST', `/api/boards/${boardId}/snapshots`, { name: 'x' })).statusCode).toBe(401)
    await grant('editor')
    expect((await save(carol)).statusCode).toBe(201)
  })

  it('validates the name and refuses archived (read-only) and trashed boards', async () => {
    expect((await save(bob, '')).statusCode).toBe(400)
    expect((await save(bob, 'x'.repeat(121))).statusCode).toBe(400)
    await bob.req('POST', `/api/boards/${boardId}/archive`)
    expect((await save(bob)).statusCode).toBe(403)
    expect((await bob.req('GET', `/api/boards/${boardId}/snapshots`)).statusCode).toBe(200) // still viewable
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect((await save(bob)).statusCode).toBe(404)
    expect((await bob.req('GET', `/api/boards/${boardId}/snapshots`)).statusCode).toBe(404)
  })

  it('answers 503 and stores nothing when the sync server is unreachable', async () => {
    sync.unavailable = true
    const res = await save(bob)
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('SYNC_UNAVAILABLE')
    expect((await api.db.query('SELECT 1 FROM board_snapshots')).rowCount).toBe(0)
    expect(existsSync(join(api.config.dataDir, 'snapshots', boardId))).toBe(false)
  })
})

describe('GET /api/boards/:bid/snapshots', () => {
  it('lists newest first for anyone who can view; 404 for others, and never another workspace', async () => {
    await save(bob, 'one')
    api.clock.advance(1000)
    await save(bob, 'two')
    await grant('viewer')
    const res = await carol.req('GET', `/api/boards/${boardId}/snapshots`)
    expect(res.statusCode).toBe(200)
    expect(res.json().snapshots.map((s: { name: string }) => s.name)).toEqual(['two', 'one'])
    const outsider = await api.login('dave')
    expect((await outsider.req('GET', `/api/boards/${boardId}/snapshots`)).statusCode).toBe(404)
    // a board in bob's personal workspace: even the Dev Studio owner sees nothing of it
    const personal = await createBoard(bob, bob.personalWorkspaceId, 'Private stuff')
    await save(bob, 'personal', personal)
    expect((await owner.req('GET', `/api/boards/${personal}/snapshots`)).statusCode).toBe(404)
    expect((await bob.req('GET', `/api/boards/${personal}/snapshots`)).json().snapshots).toHaveLength(1)
  })
})

describe('POST /api/snapshots/:sid/restore-as-new', () => {
  async function checkpoint(c: Client = bob) {
    const res = await save(c)
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }
  const restore = (c: Client, sid: string, body: unknown = {}) =>
    c.req('POST', `/api/snapshots/${sid}/restore-as-new`, body)

  it('creates a new PRIVATE board owned by the caller from the checkpoint; the original is unchanged', async () => {
    // the source is shared every way it can be
    await bob.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_edit' })
    await grant('editor')
    const invite = await bob.req('POST', `/api/boards/${boardId}/invitations`, { role: 'viewer' })
    expect(invite.statusCode).toBe(201)
    const sid = await checkpoint()
    // the live board moves on after the checkpoint
    sync.setBoard(boardId, [...baseRecords(), noteRec('n1', 'edited later'), noteRec('n2', 'new', 'a2')])
    const sourceBefore = JSON.stringify(sync.boards.get(boardId))

    const res = await restore(carol, sid)
    expect(res.statusCode).toBe(201)
    const { board, warnings, linkedFiles, droppedFiles } = res.json()
    expect(board).toMatchObject({
      workspaceId: DEV_STUDIO,
      title: 'Campaign (Before the review)',
      visibility: 'private',
      status: 'active',
      role: 'owner',
      createdBy: carol.userId,
    })
    expect(board.id).not.toBe(boardId)
    expect({ warnings, linkedFiles, droppedFiles }).toEqual({ warnings: [], linkedFiles: 0, droppedFiles: 0 })
    // seeded with the CHECKPOINT content (not the live board)
    const seeded = sync.records(board.id)
    expect(seeded.find((r) => r.id === 'shape:n1')?.props).toMatchObject({
      richText: { content: [{ content: [{ text: 'first idea' }] }] },
    })
    expect(seeded.some((r) => r.id === 'shape:n2')).toBe(false)
    expect(JSON.stringify(sync.boards.get(boardId))).toBe(sourceBefore)
    // private: one grant (the caller), no links, and nobody else sees it
    const members = await api.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM board_members WHERE board_id = $1',
      [board.id],
    )
    expect(members.rows).toEqual([{ user_id: carol.userId, role: 'owner' }])
    expect((await api.db.query('SELECT 1 FROM invitations WHERE board_id = $1', [board.id])).rowCount).toBe(0)
    expect((await bob.req('GET', `/api/boards/${board.id}`)).statusCode).toBe(404)
    expect((await carol.req('GET', `/api/boards/${board.id}`)).statusCode).toBe(200)
    // the source keeps its sharing
    expect((await bob.req('GET', `/api/boards/${boardId}`)).json().board.visibility).toBe('workspace_edit')
  })

  it('takes a title, and anyone who can view the board and create boards may restore', async () => {
    const sid = await checkpoint()
    await grant('viewer')
    const res = await restore(carol, sid, { title: 'My copy' })
    expect(res.statusCode).toBe(201)
    expect(res.json().board.title).toBe('My copy')
    expect((await restore(carol, sid, { title: '' })).statusCode).toBe(400)
  })

  it('404 for callers who cannot view the board, bad ids and other workspaces; 403 for guests', async () => {
    const sid = await checkpoint()
    const outsider = await api.login('dave')
    expect((await restore(outsider, sid)).statusCode).toBe(404)
    expect((await restore(bob, 'snp_nope')).statusCode).toBe(404)
    expect((await restore(bob, 'snp_00000000000000000000')).statusCode).toBe(404)
    // a board in bob's personal workspace, restored by a Dev Studio member who is not in that workspace
    const personal = await createBoard(bob, bob.personalWorkspaceId, 'Personal')
    sync.setBoard(personal, baseRecords())
    const psid = (await save(bob, 'p', personal)).json().id
    expect((await restore(carol, psid)).statusCode).toBe(404)
    // a guest (board invitation into another workspace) can view but not create boards
    const inv = await bob.req('POST', `/api/boards/${personal}/invitations`, { role: 'viewer' })
    const token = new URL(inv.json().url).pathname.split('/').pop() ?? ''
    expect((await carol.req('POST', `/api/invitations/${token}/accept`)).statusCode).toBe(200)
    expect((await carol.req('GET', `/api/boards/${personal}`)).statusCode).toBe(200)
    expect((await restore(carol, psid)).statusCode).toBe(403)
  })

  it('draws a new board id when the sync server already has canvas data for the first one', async () => {
    const sid = await checkpoint()
    sync.conflicts = 1
    const res = await restore(bob, sid)
    expect(res.statusCode).toBe(201)
    const tried = sync.seeds.map((s) => s.boardId)
    expect(tried).toHaveLength(2)
    expect(tried[1]).toBe(res.json().board.id)
    expect(tried[0]).not.toBe(tried[1])
    const rows = await api.db.query('SELECT id FROM boards WHERE id = ANY($1)', [tried])
    expect(rows.rows).toEqual([{ id: tried[1] }]) // only the seeded one exists
  })

  it('carries over only the files the source board can show, as links; others stay 404', async () => {
    const photo = await upload(api, bob, boardId, 'photo.png')
    // a board bob cannot see, with a file whose ids get forged into this board's records
    const hidden = await createBoard(owner, DEV_STUDIO, 'Hidden')
    const secret = await upload(api, owner, hidden, 'secret.png')
    const records = [
      ...baseRecords(),
      imageAssetRec('photo', photo.assetId, photo.versionId),
      imageRec('img', 'photo'),
      fileCardRec('forged', secret.assetId, secret.versionId),
    ]
    assertValid(records)
    sync.setBoard(boardId, records)
    const sid = await checkpoint()
    const res = await restore(bob, sid)
    expect(res.statusCode).toBe(201)
    const copy = res.json().board.id
    expect(res.json()).toMatchObject({ linkedFiles: 1, droppedFiles: 1 })
    expect(res.json().warnings).toHaveLength(1)
    // the copy shows the source's file; the forged one is still not reachable through it
    expect(await fileStatus(bob, photo, copy)).toBe(200)
    expect(await fileStatus(bob, secret, copy)).toBe(404)
    // and the link is for that board only
    const unrelated = await createBoard(bob, DEV_STUDIO, 'Unrelated')
    expect(await fileStatus(bob, photo, unrelated)).toBe(404)
    // people who cannot view the copy get nothing through it
    expect(await fileStatus(carol, photo, copy)).toBe(404)
    const meta = await bob.req('GET', `/api/boards/${copy}/assets/${photo.assetId}/${photo.versionId}`)
    expect(meta.statusCode).toBe(200)
    expect(meta.json().boardId).toBe(boardId)
  })

  it('410 when the checkpoint body is gone from storage', async () => {
    const sid = await checkpoint()
    rmSync(join(api.config.dataDir, 'snapshots', boardId, `${sid}.json`))
    const res = await restore(bob, sid)
    expect(res.statusCode).toBe(410)
    expect(sync.seeds).toHaveLength(0)
  })
})
