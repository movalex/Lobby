// History with database-backed assets (docs/M3-STORAGE-CONTRACTS.md §2, docs/FEATURES-M2-CONTRACTS.md
// "history"): a board made from another one serves the processed file (derivatives included) through
// its board_asset_links row, hears the worker's 'assets.version' event, and exports what the worker
// confirmed; the source rows stay the only copy (nothing is duplicated in storage).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claim, putBlob, reserve, type WorkerEnv, workerEnv } from '../../worker/helpers.ts'
import {
  assertValid,
  baseRecords,
  createFakeSync,
  type FakeSync,
  imageAssetRec,
  imageRec,
  noteRec,
} from './helpers.ts'

let env: WorkerEnv
let sync: FakeSync

beforeEach(async () => {
  sync = createFakeSync()
  env = await workerEnv({ deps: { syncInternal: sync } })
})
afterEach(() => env.close())

async function boardWithPhoto() {
  const photo = await env.upload('hero.png')
  const records = [
    ...baseRecords(),
    noteRec('n1', 'idea'),
    imageAssetRec('hero', photo.assetId, photo.versionId),
    imageRec('img', 'hero'),
  ]
  assertValid(records)
  sync.setBoard(env.board, records)
  return photo
}

async function finishWithThumb(versionId: string, mimeType = 'image/png') {
  await claim(env)
  const r = await reserve(env, versionId, { bytes: 16 })
  await putBlob(env, r, Buffer.alloc(16, 3))
  const res = await env.worker('POST', `/api/worker/jobs/${versionId}/complete`, {
    workerId: 'worker-a',
    status: 'ready',
    mimeType,
    derivatives: [r.derivativeId],
  })
  expect(res.statusCode).toBe(200)
  return r.derivativeId
}

describe('history + database-backed assets', () => {
  it('a duplicate serves the processed file and its derivatives through its link, and hears the worker', async () => {
    const photo = await boardWithPhoto()
    const dup = await env.bob.req('POST', `/api/boards/${env.board}/duplicate`, {})
    expect(dup.statusCode).toBe(201)
    const copy = dup.json().board.id as string
    expect(dup.json()).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
    // still queued: the copy shows the same (DB) state as the source
    expect((await env.meta(photo, copy)).status).toBe('queued')

    const drv = await finishWithThumb(photo.versionId, 'image/jpeg')
    const onCopy = await env.meta(photo, copy)
    expect(onCopy).toMatchObject({ boardId: env.board, status: 'ready', mimeType: 'image/jpeg' })
    expect(onCopy.derivatives.map((d) => d.id)).toEqual([drv])
    const thumb = await env.bob.req(
      'GET',
      `/files/${photo.assetId}/${photo.versionId}/d/${drv}?board=${copy}`,
    )
    expect(thumb.statusCode).toBe(200)
    expect(thumb.headers['content-type']).toBe('image/webp')
    // the worker's result reached both boards that show the file
    const heard = env.events.filter((e) => e.type === 'assets.version').map((e) => e.boardId)
    expect(heard.sort()).toEqual([env.board, copy].sort())
    // and storage holds one original and one derivative: links never copy bytes or rows
    const rows = await env.api.db.one<{ v: number; d: number }>(
      'SELECT (SELECT count(*)::int FROM asset_versions) AS v, (SELECT count(*)::int FROM asset_derivatives) AS d',
    )
    expect(rows).toEqual({ v: 1, d: 1 })
  })

  it('export lists the version as stored (confirmed type, size, hash); import links it for viewers only', async () => {
    const photo = await boardWithPhoto()
    await finishWithThumb(photo.versionId, 'image/jpeg')
    const exported = await env.bob.req('GET', `/api/boards/${env.board}/export`)
    expect(exported.statusCode).toBe(200)
    expect(exported.json().assets).toEqual([
      {
        assetId: photo.assetId,
        versionId: photo.versionId,
        name: 'hero.png',
        mimeType: 'image/jpeg',
        sizeBytes: photo.sizeBytes,
        sha256: photo.sha256,
      },
    ])
    const archive = exported.json()
    const mine = await env.bob.req('POST', '/api/workspaces/wsp_DevStudio00000000000/boards/import', archive)
    expect(mine.statusCode).toBe(201)
    expect(mine.json()).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
    const imported = mine.json().board.id as string
    expect((await env.meta(photo, imported)).status).toBe('ready')
    // someone who cannot view any board showing the file gets the board, but not the file
    const carol = await env.api.login('carol')
    const theirs = await carol.req('POST', '/api/workspaces/wsp_DevStudio00000000000/boards/import', archive)
    expect(theirs.statusCode).toBe(201)
    expect(theirs.json()).toMatchObject({ linkedFiles: 0, droppedFiles: 1 })
    const board = theirs.json().board.id as string
    expect(
      (await carol.req('GET', `/files/${photo.assetId}/${photo.versionId}/original?board=${board}`))
        .statusCode,
    ).toBe(404)
  })
})
