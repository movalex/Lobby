// Wave S, WS2: the foundation's collector rules (files/gc.ts: whole chains, comment pins) hold for chains the REAL
// upload writes with X-Lobby-Supersedes. A SUPERSEDED version that only a comment thread or only an old checkpoint
// still names survives delete-mode passes long past the grace period, and keeps its whole chain; a chain nothing names
// goes only as a whole (the foundation's gc-chains.test.ts covers the lock re-check with hand-written chains).

import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { SUPERSEDES_HEADER } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { originalKey } from '../../src/files/blobs.ts'
import { type AssetGcDeps, collectWorkspace, type GcPassMode } from '../../src/files/gc.ts'
import { type VersionRef, versionsInRecords } from '../../src/files/gc-refs.ts'
import { createThread } from '../features/comments/fixture.ts'
import { baseRecords, createFakeSync, fileCardRec, upload } from '../features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../helpers.ts'

const DAY = 86_400_000
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function gcSync() {
  const base = createFakeSync()
  return Object.assign(base, {
    async assetRefs(boardId: string) {
      return {
        boardId,
        exists: base.boards.has(boardId),
        canvas: versionsInRecords(base.records(boardId)),
        deleted: [] as VersionRef[],
        unusedAssetRecords: [],
      }
    },
  })
}

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

async function world() {
  const sync = gcSync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  const t = api
  const alice = await t.login('alice', 'Alice')
  const board = await createBoard(alice, DEV_STUDIO, 'Pitch wall')
  const deps: AssetGcDeps = {
    db: t.db,
    blobs: t.blobs,
    sync,
    dataRoot: t.config.dataDir,
    now: t.clock.now,
    log: { info: () => {}, warn: () => {} },
  }
  const supersede = async (c: Client, prev: AssetVersionMeta, name: string): Promise<AssetVersionMeta> => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/boards/${board}/assets`,
      payload: PNG,
      headers: {
        origin: ORIGIN,
        'content-type': 'image/png',
        'x-file-name': name,
        cookie: c.cookie,
        [SUPERSEDES_HEADER]: prev.versionId,
      },
    })
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as AssetVersionMeta
  }
  /** v1 to v3 of one deliverable through the real upload, v3 on the canvas */
  const chain = async () => {
    const v1 = await upload(t, alice, board, 'cut.png')
    const v2 = await supersede(alice, v1, 'cut-2.png')
    const v3 = await supersede(alice, v2, 'cut-3.png')
    sync.setBoard(board, card(v3))
    return [v1, v2, v3] as const
  }
  return {
    t,
    sync,
    alice,
    board,
    chain,
    supersede,
    collect: (mode: GcPassMode = 'delete') => collectWorkspace(deps, DEV_STUDIO, mode),
    exists: async (m: AssetVersionMeta) => (await t.blobs.head(originalKey(m.assetId, m.versionId))) !== null,
    rows: async (vs: readonly AssetVersionMeta[]) =>
      (
        await t.db.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM asset_versions WHERE id = ANY($1::text[])',
          [vs.map((v) => v.versionId)],
        )
      ).n,
  }
}

const card = (m: AssetVersionMeta) => [...baseRecords(), fileCardRec('card-1', m.assetId, m.versionId)]

describe('the collector and chains the upload writes', () => {
  it('a superseded version only a comment thread names survives, with its chain, after the card is gone', async () => {
    const w = await world()
    const [v1, v2, v3] = await w.chain()
    // the client's note is pinned to v1 (an asset anchor), then the card is deleted for good
    await createThread(w.alice, w.board, 'Logo bigger on v1', {
      kind: 'asset',
      shapeId: 'shape:card-1',
      assetId: v1.assetId,
      versionId: v1.versionId,
    })
    w.sync.setBoard(w.board, baseRecords())
    w.t.clock.advance(8 * DAY)
    for (let i = 0; i < 3; i++) {
      expect(await w.collect()).toMatchObject({ complete: true, marked: 0, deleted: { versions: 0 } })
      w.t.clock.advance(31 * DAY)
    }
    for (const v of [v1, v2, v3]) expect(await w.exists(v), v.name).toBe(true)
    expect(await w.rows([v1, v2, v3])).toBe(3)
  })

  it('a superseded version only an old checkpoint names survives, with its chain', async () => {
    const w = await world()
    const v1 = await upload(w.t, w.alice, w.board, 'cut.png')
    w.sync.setBoard(w.board, card(v1))
    // "Before the client's notes": a checkpoint while the card showed v1
    expect(
      (await w.alice.req('POST', `/api/boards/${w.board}/snapshots`, { name: 'Before' })).statusCode,
    ).toBe(201)
    const v2 = await w.supersede(w.alice, v1, 'cut-2.png')
    const v3 = await w.supersede(w.alice, v2, 'cut-3.png')
    // nothing on the canvas shows the deliverable any more; the checkpoint still shows v1
    w.sync.setBoard(w.board, baseRecords())
    w.t.clock.advance(8 * DAY)
    for (let i = 0; i < 3; i++) {
      expect(await w.collect()).toMatchObject({ complete: true, marked: 0, deleted: { versions: 0 } })
      w.t.clock.advance(31 * DAY)
    }
    for (const v of [v1, v2, v3]) expect(await w.exists(v), v.name).toBe(true)
  })

  it('a chain nothing names any more is collected as a whole after the grace period', async () => {
    const w = await world()
    const [v1, v2, v3] = await w.chain()
    w.sync.setBoard(w.board, baseRecords())
    w.t.clock.advance(8 * DAY)
    expect(await w.collect()).toMatchObject({ complete: true, marked: 3, deleted: { versions: 0 } })
    w.t.clock.advance(31 * DAY)
    expect((await w.collect())?.deleted.versions).toBe(3)
    for (const v of [v1, v2, v3]) expect(await w.exists(v), v.name).toBe(false)
  })
})
