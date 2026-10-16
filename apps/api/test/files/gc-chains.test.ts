// Wave S foundation (docs/WAVE-S-CONTRACTS.md §3.4, the design's top risk): the file collector keeps a deliverable's
// WHOLE version chain (versions sharing one asset id, asset_versions.supersedes) while any version of it is
// referenced, and every version a comment thread is pinned to, in report and in delete mode, including the re-check
// under the version's row lock. So no build that writes chains (WS2's X-Lobby-Supersedes) can lose old versions
// 30 days after Replace media, or the previews of a comment pinned to v1. A chain no board shows any more goes as a
// whole once every version of it is past the grace period.
//
// Chains are written here as WS2's upload will write them: a version row with the same asset id, `supersedes` = the
// previous version, its original in the blob store.

import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { newId } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { originalKey } from '../../src/files/blobs.ts'
import { type AssetGcDeps, collectWorkspace, type GcPassMode, keptWithChains } from '../../src/files/gc.ts'
import { type VersionRef, versionsInRecords } from '../../src/files/gc-refs.ts'
import { baseRecords, createFakeSync, fileCardRec, upload } from '../features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../helpers.ts'

const DAY = 86_400_000

function gcSync() {
  const base = createFakeSync()
  const sync = Object.assign(base, {
    onAssetRefs: null as null | ((call: number) => Promise<void> | void),
    calls: 0,
    async assetRefs(boardId: string) {
      sync.calls++
      await sync.onAssetRefs?.(sync.calls)
      return {
        boardId,
        exists: base.boards.has(boardId),
        canvas: versionsInRecords(base.records(boardId)),
        deleted: [] as VersionRef[],
        unusedAssetRecords: [],
      }
    },
  })
  return sync
}

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

interface World {
  api: TestApi
  sync: ReturnType<typeof gcSync>
  alice: Client
  board: string
  collect(mode?: GcPassMode): ReturnType<typeof collectWorkspace>
  marks(): Promise<Record<string, Date | null>>
  /** a new version of `prev`'s asset, as WS2's upload writes one (same asset id, supersedes, its original stored) */
  supersede(prev: AssetVersionMeta, board?: string): Promise<AssetVersionMeta>
  exists(m: AssetVersionMeta): Promise<boolean>
  pin(m: AssetVersionMeta): Promise<string>
}

async function world(): Promise<World> {
  const sync = gcSync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  const a = api
  const alice = await a.login('alice')
  const board = await createBoard(alice, DEV_STUDIO, 'Pitch wall')
  const deps: AssetGcDeps = {
    db: a.db,
    blobs: a.blobs,
    sync,
    dataRoot: a.config.dataDir,
    now: a.clock.now,
    log: { info: () => {}, warn: () => {} },
  }
  return {
    api: a,
    sync,
    alice,
    board,
    collect: (mode = 'report') => collectWorkspace(deps, DEV_STUDIO, mode),
    async marks() {
      const rows = await a.db.query<{ id: string; unreferenced_since: Date | null }>(
        'SELECT id, unreferenced_since FROM asset_versions WHERE workspace_id = $1',
        [DEV_STUDIO],
      )
      return Object.fromEntries(rows.rows.map((r) => [r.id, r.unreferenced_since]))
    },
    async supersede(prev, onBoard = board) {
      const versionId = newId('ver')
      await a.db.query(
        `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                     size_bytes, sha256, uploaded_by, status, created_at, supersedes)
         SELECT $1, asset_id, workspace_id, $3, name, declared_mime_type, mime_type, kind, size_bytes, sha256,
                uploaded_by, status, $4, id
           FROM asset_versions WHERE id = $2`,
        [versionId, prev.versionId, onBoard, a.clock.now()],
      )
      const body = Buffer.from('a new cut')
      await a.blobs.put(originalKey(prev.assetId, versionId), body, {
        contentType: 'image/png',
        contentLength: body.length,
      })
      return { ...prev, versionId, boardId: onBoard }
    },
    exists: async (m) => (await a.blobs.head(originalKey(m.assetId, m.versionId))) !== null,
    async pin(m) {
      const id = `thr_${newId('ver').slice(4)}`
      const anchor = {
        kind: 'asset',
        shapeId: 'shape:card-1',
        assetId: m.assetId,
        versionId: m.versionId,
        page: 1,
      }
      await a.db.query(
        `INSERT INTO comment_threads (id, workspace_id, board_id, anchor, created_by)
         SELECT $1, $2, $3, $4::jsonb, id FROM users WHERE handle = 'alice'`,
        [id, DEV_STUDIO, board, JSON.stringify(anchor)],
      )
      return id
    },
  }
}

const card = (m: AssetVersionMeta) => [...baseRecords(), fileCardRec('card-1', m.assetId, m.versionId)]

describe('keptWithChains', () => {
  it('one held version keeps every version of its asset; other assets are untouched', () => {
    const rows = [
      { id: 'v1', asset_id: 'a' },
      { id: 'v2', asset_id: 'a' },
      { id: 'v3', asset_id: 'a' },
      { id: 'x1', asset_id: 'b' },
      { id: 'y1', asset_id: 'c' },
    ]
    expect([...keptWithChains(rows, (r) => r.id === 'v3' || r.id === 'y1')].sort()).toEqual([
      'v1',
      'v2',
      'v3',
      'y1',
    ])
    expect(keptWithChains(rows, () => false).size).toBe(0)
  })
})

describe('the collector and version chains (wave S)', () => {
  it('report mode: v3 on the canvas keeps v1 and v2; no board shows the chain: all three are marked', async () => {
    const w = await world()
    const v1 = await upload(w.api, w.alice, w.board, 'cut.png')
    const v2 = await w.supersede(v1)
    const v3 = await w.supersede(v2)
    w.sync.setBoard(w.board, card(v3))
    w.api.clock.advance(8 * DAY)
    expect(await w.collect()).toMatchObject({ complete: true, marked: 0 })
    expect(Object.values(await w.marks())).toEqual([null, null, null])
    // "Make current" v1 (an ordinary fileId write): still the whole chain
    w.sync.setBoard(w.board, card(v1))
    expect(await w.collect()).toMatchObject({ marked: 0 })
    // the card is deleted for good: the chain is marked as a whole
    w.sync.setBoard(w.board, baseRecords())
    expect(await w.collect()).toMatchObject({ marked: 3 })
    // and the first reference again clears all three
    w.sync.setBoard(w.board, card(v2))
    expect(await w.collect()).toMatchObject({ cleared: 3, marked: 0 })
  })

  it('delete mode never removes an older version while its deliverable is on a board, even marked by an older api', async () => {
    const w = await world()
    const v1 = await upload(w.api, w.alice, w.board, 'cut.png')
    const v2 = await w.supersede(v1)
    const v3 = await w.supersede(v2)
    w.sync.setBoard(w.board, card(v3))
    // an api before wave S (no chain rule) ran report passes: v1 and v2 marked 40 days ago
    w.api.clock.advance(41 * DAY)
    await w.api.db.query('UPDATE asset_versions SET unreferenced_since = $2 WHERE id = ANY($1::text[])', [
      [v1.versionId, v2.versionId],
      new Date(w.api.clock.now().getTime() - 40 * DAY),
    ])
    const r = await w.collect('delete')
    expect(r).toMatchObject({ complete: true, cleared: 2, deleted: { versions: 0 } })
    for (const v of [v1, v2, v3]) expect(await w.exists(v), v.versionId).toBe(true)
    expect(Object.values(await w.marks())).toEqual([null, null, null])
  })

  it('a version a comment thread is pinned to is kept on its own, and keeps its chain', async () => {
    const w = await world()
    const solo = await upload(w.api, w.alice, w.board, 'storyboard.png')
    const v1 = await upload(w.api, w.alice, w.board, 'trailer.png')
    const v2 = await w.supersede(v1)
    const thread = await w.pin(solo)
    await w.pin(v1)
    w.api.clock.advance(41 * DAY)
    // no board shows any of them; the threads still do
    expect(await w.collect('delete')).toMatchObject({ complete: true, marked: 0, deleted: { versions: 0 } })
    for (const v of [solo, v1, v2]) expect(await w.exists(v), v.name).toBe(true)
    // the solo thread goes: its version is collected after the grace period like any other
    await w.api.db.query('DELETE FROM comment_threads WHERE id = $1', [thread])
    expect(await w.collect('delete')).toMatchObject({ marked: 1 })
    w.api.clock.advance(31 * DAY)
    expect((await w.collect('delete'))?.deleted.versions).toBe(1)
    expect(await w.exists(solo)).toBe(false)
    expect(await w.exists(v1)).toBe(true)
    expect(await w.exists(v2)).toBe(true)
  })

  it('a chain nothing shows goes only as a whole, once every version of it is past the grace period', async () => {
    const w = await world()
    const v1 = await upload(w.api, w.alice, w.board, 'cut.png')
    const v2 = await w.supersede(v1)
    w.api.clock.advance(8 * DAY)
    // v1 marked long ago (an older api), v2 only now: v1 is eligible on its own, but waits for its chain
    const old = new Date(w.api.clock.now().getTime() - 40 * DAY)
    await w.api.db.query('UPDATE asset_versions SET unreferenced_since = $2 WHERE id = $1', [
      v1.versionId,
      old,
    ])
    expect(await w.collect('delete')).toMatchObject({ complete: true, marked: 1, deleted: { versions: 0 } })
    expect(await w.exists(v1)).toBe(true)
    w.api.clock.advance(31 * DAY)
    expect((await w.collect('delete'))?.deleted.versions).toBe(2)
    expect(await w.exists(v1)).toBe(false)
    expect(await w.exists(v2)).toBe(false)
  })

  it('under the row lock: a new version or a pinned thread that appears during the pass keeps the chain', async () => {
    const w = await world()
    const v1 = await upload(w.api, w.alice, w.board, 'cut.png')
    const p1 = await upload(w.api, w.alice, w.board, 'poster.png')
    w.api.clock.advance(8 * DAY)
    await w.collect('delete')
    w.api.clock.advance(31 * DAY)
    // the pass reads the board twice (decide, then right before deleting); after the second read, someone uploads v2
    // of the cut and pins a thread to the poster: neither source is read again, the lock check sees both
    const { n: boards } = await w.api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM boards WHERE workspace_id = $1 AND status IN ('active', 'archived', 'trashed')",
      [DEV_STUDIO],
    )
    const start = w.sync.calls
    let v2: AssetVersionMeta | null = null
    w.sync.onAssetRefs = async (call) => {
      if (call !== start + boards + 1) return
      v2 = await w.supersede(v1)
      await w.pin(p1)
    }
    const r = await w.collect('delete')
    expect(r?.deleted.versions).toBe(0)
    expect(v2).not.toBeNull()
    for (const v of [v1, p1]) expect(await w.exists(v), v.name).toBe(true)
    // the next pass clears both marks (the chain is in flight, the poster pinned)
    w.sync.onAssetRefs = null
    expect(await w.collect('delete')).toMatchObject({ cleared: 2, deleted: { versions: 0 } })
  })
})
