// The file authorizer's link extension (apps/api/src/files-auth.ts + board_asset_links): a version
// uploaded to board A is viewable on board B only through a link row for (B, asset, version) in the
// same workspace, only by people who can view B, and never on unrelated boards.
import type { FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionStore } from '../../../src/auth/session.ts'
import type { FileAuthorizer } from '../../../src/files/deps.ts'
import { createFileAuthorizer, isAssetLinked } from '../../../src/files-auth.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { fileStatus, upload } from './helpers.ts'

let api: TestApi
let bob: Client
let carol: Client
let source: string
let copy: string
let unrelated: string
let file: { assetId: string; versionId: string }
let authorize: FileAuthorizer

const reqWith = (c: Client | null) =>
  ({ cookies: c ? { dr_session: c.cookie.split('=')[1] } : {} }) as unknown as FastifyRequest
const link = (boardId: string, workspaceId = DEV_STUDIO, f = file) =>
  api.db.query(
    'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
    [workspaceId, boardId, f.assetId, f.versionId],
  )
const asset = () => ({ ...file, ownerBoardId: source })

beforeEach(async () => {
  api = await createTestApi()
  await api.login('owner')
  bob = await api.login('bob')
  carol = await api.login('carol')
  source = await createBoard(bob, DEV_STUDIO, 'Source')
  copy = await createBoard(bob, DEV_STUDIO, 'Copy')
  unrelated = await createBoard(bob, DEV_STUDIO, 'Unrelated')
  file = await upload(api, bob, source)
  authorize = createFileAuthorizer(
    api.db,
    createSessionStore({ db: api.db, secureCookies: false, now: () => new Date() }),
  )
})
afterEach(() => api.close())

describe('linked assets', () => {
  it('without a link another board’s asset is a 404 everywhere but its own board', async () => {
    expect(await fileStatus(bob, file, source)).toBe(200)
    expect(await fileStatus(bob, file, copy)).toBe(404)
    expect(await authorize.linkedAsset?.(reqWith(bob), copy, asset())).toBe(false)
  })

  it('a link makes it viewable on that board (original, meta), still 404 on unrelated boards', async () => {
    await link(copy)
    expect(await authorize.linkedAsset?.(reqWith(bob), copy, asset())).toBe(true)
    expect(await fileStatus(bob, file, copy)).toBe(200)
    expect(
      (await bob.req('GET', `/api/boards/${copy}/assets/${file.assetId}/${file.versionId}`)).statusCode,
    ).toBe(200)
    expect(await fileStatus(bob, file, unrelated)).toBe(404)
    expect(await authorize.linkedAsset?.(reqWith(bob), unrelated, asset())).toBe(false)
  })

  it('only for people who can view the linked board; trashed copies serve nothing', async () => {
    await link(copy)
    expect(await authorize.linkedAsset?.(reqWith(carol), copy, asset())).toBe(false)
    expect(await authorize.linkedAsset?.(reqWith(null), copy, asset())).toBe(false)
    expect(await fileStatus(carol, file, copy)).toBe(404)
    await bob.req('PUT', `/api/boards/${copy}/members/${carol.userId}`, { role: 'viewer' })
    expect(await fileStatus(carol, file, copy)).toBe(200)
    await bob.req('POST', `/api/boards/${copy}/trash`)
    expect(await fileStatus(bob, file, copy)).toBe(404)
  })

  it('never across workspaces, even with a (forged) link row', async () => {
    const foreign = await createBoard(bob, bob.personalWorkspaceId, 'Personal')
    await link(foreign, bob.personalWorkspaceId)
    // the row exists, but the asset's own board is in another workspace
    expect(await isAssetLinked(api.db, bob.personalWorkspaceId, foreign, asset())).toBe(false)
    expect(await fileStatus(bob, file, foreign)).toBe(404)
    // a link row cannot claim another workspace for a board (composite foreign key)
    await expect(link(copy, bob.personalWorkspaceId)).rejects.toThrow()
  })

  it('a link names one version: other versions of the asset stay 404', async () => {
    await link(copy)
    const other = { assetId: file.assetId, versionId: 'ver_ZZZZZZZZZZZZZZZZZZZZ' }
    expect(await isAssetLinked(api.db, DEV_STUDIO, copy, { ...other, ownerBoardId: source })).toBe(false)
    expect(await fileStatus(bob, other, copy)).toBe(404)
  })

  it('links go away with their board (cascade)', async () => {
    await link(copy)
    await api.db.query('DELETE FROM boards WHERE id = $1', [copy])
    expect((await api.db.query('SELECT 1 FROM board_asset_links WHERE board_id = $1', [copy])).rowCount).toBe(
      0,
    )
  })
})
