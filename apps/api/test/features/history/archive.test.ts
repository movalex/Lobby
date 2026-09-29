// GET /api/boards/:bid/export (BoardArchiveV1) and POST /api/workspaces/:wid/boards/import.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  devEmail,
  ORIGIN,
  type TestApi,
} from '../../helpers.ts'
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
  type Rec,
  upload,
} from './helpers.ts'

let api: TestApi
let sync: FakeSync
let owner: Client
let bob: Client
let carol: Client
let boardId: string
let photo: { assetId: string; versionId: string; sha256: string }

beforeEach(async () => {
  sync = createFakeSync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  owner = await api.login('owner')
  bob = await api.login('bob')
  carol = await api.login('carol')
  boardId = await createBoard(bob, DEV_STUDIO, 'Pitch / v2')
  photo = await upload(api, bob, boardId, 'hero.png')
  const hidden = await createBoard(owner, DEV_STUDIO, 'Hidden')
  const secret = await upload(api, owner, hidden, 'secret.png')
  const records: Rec[] = [
    ...baseRecords(),
    noteRec('n1', 'Tagline'),
    imageAssetRec('hero', photo.assetId, photo.versionId),
    imageRec('img', 'hero'),
    fileCardRec('forged', secret.assetId, secret.versionId),
  ]
  assertValid(records)
  sync.setBoard(boardId, records)
})
afterEach(() => api.close())

const exportBoard = (c: Client, bid = boardId) => c.req('GET', `/api/boards/${bid}/export`)
const importArchive = (c: Client, body: unknown, query = '', wid = DEV_STUDIO) =>
  c.req('POST', `/api/workspaces/${wid}/boards/import${query}`, body)

describe('GET /api/boards/:bid/export', () => {
  it('returns the board archive with the files this board can show, as a download', async () => {
    const res = await exportBoard(bob)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Pitch / v2.lobby.json"; filename*=UTF-8''Pitch%20%2F%20v2.lobby.json`,
    )
    const archive = res.json()
    expect(archive).toMatchObject({ format: 'draftroom-board', version: 1 })
    expect(archive.records.map((r: Rec) => r.id)).toEqual(
      expect.arrayContaining(['page:page', 'shape:n1', 'shape:img', 'asset:hero', 'shape:forged']),
    )
    // only the file uploaded to this board is in the manifest (the forged reference is not)
    expect(archive.assets).toEqual([
      {
        assetId: photo.assetId,
        versionId: photo.versionId,
        name: 'hero.png',
        mimeType: 'image/png',
        sizeBytes: expect.any(Number),
        sha256: photo.sha256,
      },
    ])
  })

  it('is open to viewers and closed to everyone else', async () => {
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
    expect((await exportBoard(carol)).statusCode).toBe(200)
    const outsider = await api.login('dave')
    expect((await exportBoard(outsider)).statusCode).toBe(404)
    expect((await api.anon('GET', `/api/boards/${boardId}/export`)).statusCode).toBe(401)
    sync.unavailable = true
    expect((await exportBoard(bob)).statusCode).toBe(503)
  })
})

describe('POST /api/workspaces/:wid/boards/import', () => {
  it('round-trips an export into a new private board with fresh ids, files linked when viewable', async () => {
    const archive = (await exportBoard(bob)).json()
    const res = await importArchive(bob, archive, '?title=Imported%20pitch')
    expect(res.statusCode).toBe(201)
    const { board, linkedFiles, droppedFiles, warnings } = res.json()
    expect(board).toMatchObject({
      title: 'Imported pitch',
      visibility: 'private',
      role: 'owner',
      workspaceId: DEV_STUDIO,
    })
    expect({ linkedFiles, droppedFiles }).toEqual({ linkedFiles: 1, droppedFiles: 1 })
    expect(warnings.join(' ')).toMatch(/not available to you/)
    const seeded = sync.records(board.id)
    const shapes = seeded.filter((r) => r.typeName === 'shape')
    expect(shapes).toHaveLength(3)
    expect(shapes.every((s) => !['shape:n1', 'shape:img', 'shape:forged'].includes(s.id))).toBe(true) // new ids
    expect(shapes.every((s) => s.parentId === 'page:page')).toBe(true)
    assertValid(seeded)
    expect(await fileStatus(bob, photo, board.id)).toBe(200)
    const members = await api.db.query('SELECT user_id FROM board_members WHERE board_id = $1', [board.id])
    expect(members.rows).toEqual([{ user_id: bob.userId }])
  })

  it('drops files the importer cannot view in this workspace (they stay 404 on the new board)', async () => {
    const archive = (await exportBoard(bob)).json()
    // carol cannot view bob's board, so the photo is not hers to carry over
    const res = await importArchive(carol, archive)
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ linkedFiles: 0, droppedFiles: 2 })
    expect(res.json().board.title).toBe('Imported board')
    expect(await fileStatus(carol, photo, res.json().board.id)).toBe(404)
    // once she can view the source board, the same file is linkable
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
    const again = await importArchive(carol, archive)
    expect(again.json()).toMatchObject({ linkedFiles: 1, droppedFiles: 1 })
    expect(await fileStatus(carol, photo, again.json().board.id)).toBe(200)
  })

  it('rejects broken or foreign files with a message and creates nothing', async () => {
    const count = async () => (await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n
    const before = await count()
    for (const body of [{}, { format: 'miro' }, { format: 'draftroom-board', version: 99 }, []]) {
      const res = await importArchive(bob, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(res.json().error.code).toBe('INVALID_ARCHIVE')
    }
    const archive = (await exportBoard(bob)).json()
    archive.records.push({ id: 'shape:evil', typeName: 'shape', type: 'iframe-of-doom', props: {} })
    const bad = await importArchive(bob, archive)
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.message).toMatch(/can't be imported/)
    const notJson = await api.app.inject({
      method: 'POST',
      url: `/api/workspaces/${DEV_STUDIO}/boards/import`,
      payload: '{"format": ',
      headers: { origin: ORIGIN, cookie: bob.cookie, 'content-type': 'application/json' },
    })
    expect(notJson.statusCode).toBe(400)
    expect(await count()).toBe(before)
    expect(sync.seeds).toHaveLength(0)
  })

  it('accepts archives up to 25 MB and refuses bigger bodies with 413', async () => {
    const archive = (await exportBoard(bob)).json()
    const big = JSON.stringify(archive).replace('"records":[', `"records":[${' '.repeat(1024 * 1024)}`)
    const ok = await api.app.inject({
      method: 'POST',
      url: `/api/workspaces/${DEV_STUDIO}/boards/import`,
      payload: big,
      headers: { origin: ORIGIN, cookie: bob.cookie, 'content-type': 'application/json' },
    })
    expect(ok.statusCode).toBe(201) // > 256 KB (the default JSON limit) but under 25 MB
    const tooBig = await api.app.inject({
      method: 'POST',
      url: `/api/workspaces/${DEV_STUDIO}/boards/import`,
      payload: `{"pad":"${'x'.repeat(26 * 1024 * 1024)}"}`,
      headers: { origin: ORIGIN, cookie: bob.cookie, 'content-type': 'application/json' },
    })
    expect(tooBig.statusCode).toBe(413)
  })

  it('needs a workspace member: outsiders 404, guests 403; a project must be in the workspace', async () => {
    const archive = (await exportBoard(bob)).json()
    // every dev login joins Dev Studio; bob's personal workspace is closed to dave
    const outsider = await api.login('dave')
    expect((await importArchive(outsider, archive, '', bob.personalWorkspaceId)).statusCode).toBe(404)
    expect((await importArchive(bob, archive, '', 'wsp_nope')).statusCode).toBe(404)
    expect((await api.anon('POST', `/api/workspaces/${DEV_STUDIO}/boards/import`, archive)).statusCode).toBe(
      401,
    )
    // a project of another workspace
    const project = await bob.req('POST', `/api/workspaces/${bob.personalWorkspaceId}/projects`, {
      name: 'Mine',
    })
    expect((await importArchive(bob, archive, `?projectId=${project.json().id}`)).statusCode).toBe(400)
    const here = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Clients' })
    const inProject = await importArchive(bob, archive, `?projectId=${here.json().id}`)
    expect(inProject.statusCode).toBe(201)
    expect(inProject.json().board.projectId).toBe(here.json().id)
    // guest of bob's personal workspace through a board invitation
    const personal = await createBoard(bob, bob.personalWorkspaceId, 'Personal')
    const inv = await bob.req('POST', `/api/boards/${personal}/invitations`, {
      role: 'editor',
      email: devEmail('dave'),
    })
    await outsider.req('POST', `/api/invitations/${new URL(inv.json().url).pathname.split('/').pop()}/accept`)
    expect((await importArchive(outsider, archive, '', bob.personalWorkspaceId)).statusCode).toBe(403)
  })
})
