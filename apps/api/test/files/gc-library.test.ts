// Wave Q (WS2): the file collector (src/files/gc.ts) counts the element library's file rows (library_item_files) as
// references: a version only a library item shows is kept, a deleted item's too until the library's purge
// (features/library/purge.ts) removes the item 30 days after its delete; then the version is collected like any other.
// A row that appears while a delete-mode pass runs keeps the version (the pass reads every source again).

import { afterEach, describe, expect, it } from 'vitest'
import { purgeDeletedLibraryItems } from '../../src/features/library/purge.ts'
import { originalKey } from '../../src/files/blobs.ts'
import { type AssetGcDeps, collectWorkspace } from '../../src/files/gc.ts'
import { image, itemUrl, type LibWorld, libraryWorld, saved, uploadTo, WS } from '../features/library/support.ts'

const DAY = 86_400_000
let w: LibWorld | undefined
afterEach(async () => {
  await w?.api.close()
  w = undefined
})

/** Every board reads as showing nothing; `onRead` runs before each board's answer. */
function deps(world: LibWorld, onRead?: (call: number) => Promise<void>): AssetGcDeps {
  let calls = 0
  return {
    db: world.api.db,
    blobs: world.api.blobs,
    sync: {
      async assetRefs(boardId: string) {
        await onRead?.(++calls)
        return { boardId, exists: true, canvas: [], deleted: [] }
      },
    },
    dataRoot: world.api.config.dataDir,
    now: world.api.clock.now,
    log: { info: () => {}, warn: () => {} },
  }
}

const fileRows = async (world: LibWorld) =>
  (await world.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM library_item_files')).n

const marks = async (world: LibWorld) =>
  Object.fromEntries(
    (
      await world.api.db.query<{ id: string; unreferenced_since: Date | null }>(
        'SELECT id, unreferenced_since FROM asset_versions WHERE workspace_id = $1',
        [WS],
      )
    ).rows.map((r) => [r.id, r.unreferenced_since]),
  )

describe('the collector and the element library', () => {
  it('keeps a version only a library item shows, deleted or not, until the purge; then collects it', async () => {
    const lw = await libraryWorld()
    w = lw
    const shown = await uploadTo(lw, lw.carol, lw.source, 'kept.png')
    const nothing = await uploadTo(lw, lw.carol, lw.source, 'left.png')
    const live = await saved(lw.carol, lw.source, { elements: [image('i', shown)] })
    const binned = await saved(lw.carol, lw.source, { elements: [image('i', shown)] })
    expect((await lw.carol.req('DELETE', itemUrl(binned.id))).statusCode).toBe(204)
    const d = deps(lw)
    lw.api.clock.advance(8 * DAY)
    expect(await collectWorkspace(d, WS, 'report')).toMatchObject({ complete: true, marked: 1 })
    const m = await marks(lw)
    expect(m[shown.versionId]).toBeNull()
    expect(m[nothing.versionId]).not.toBeNull()
    // the live item goes for good (as an account's removal would take a personal one); the deleted one still holds
    await lw.api.db.query('DELETE FROM library_items WHERE id = $1', [live.id])
    lw.api.clock.advance(31 * DAY)
    expect((await collectWorkspace(d, WS, 'delete'))?.deleted.versions).toBe(1)
    expect(await lw.api.blobs.head(originalKey(shown.assetId, shown.versionId))).not.toBeNull()
    expect(await lw.api.blobs.head(originalKey(nothing.assetId, nothing.versionId))).toBeNull()
    // the purge: the deleted item is past its 30 days now
    expect(await purgeDeletedLibraryItems(lw.api.db, lw.api.clock.now())).toBe(1)
    expect(await fileRows(lw)).toBe(0)
    expect(await collectWorkspace(d, WS, 'report')).toMatchObject({ marked: 1 })
    lw.api.clock.advance(31 * DAY)
    expect((await collectWorkspace(d, WS, 'delete'))?.deleted.versions).toBe(1)
    expect(await lw.api.blobs.head(originalKey(shown.assetId, shown.versionId))).toBeNull()
  })

  it('a library row that appears while a delete pass runs keeps the version', async () => {
    const lw = await libraryWorld()
    w = lw
    const v = await uploadTo(lw, lw.carol, lw.source, 'late.png')
    lw.api.clock.advance(8 * DAY)
    await collectWorkspace(deps(lw), WS, 'report')
    lw.api.clock.advance(31 * DAY)
    // during the pass's second read of every source: an item that shows it (written as a save writes it)
    const { n: boards } = await lw.api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM boards WHERE workspace_id = $1',
      [WS],
    )
    const late = deps(lw, async (call) => {
      if (call !== boards + 1) return
      await lw.api.db.query(
        `INSERT INTO library_items (id, workspace_id, name, elements, element_count, image_count, bytes, width, height,
           source, created_by)
         VALUES ('lbi_late0000000000', $1, 'Late', '[{}]', 1, 1, 2, 1, 1, '{"kind":"board","boardId":"b-x00"}', $2)`,
        [WS, lw.carol.userId],
      )
      await lw.api.db.query(
        `INSERT INTO library_item_files (item_id, workspace_id, asset_id, version_id)
         VALUES ('lbi_late0000000000', $1, $2, $3)`,
        [WS, v.assetId, v.versionId],
      )
    })
    // the second read of the library rows came before the insert: the check under the version's row lock kept it
    expect((await collectWorkspace(late, WS, 'delete'))?.deleted.versions).toBe(0)
    expect(await lw.api.blobs.head(originalKey(v.assetId, v.versionId))).not.toBeNull()
    // and the next pass sees the reference: the mark is cleared
    expect(await collectWorkspace(deps(lw), WS, 'report')).toMatchObject({ cleared: 1 })
    expect((await marks(lw))[v.versionId]).toBeNull()
  })
})

describe('the library purge', () => {
  it('removes only items deleted more than 30 days ago, with their file rows', async () => {
    const lw = await libraryWorld()
    w = lw
    const v = await uploadTo(lw, lw.carol, lw.source)
    const old = await saved(lw.carol, lw.source, { elements: [image('i', v)] })
    const recent = await saved(lw.carol, lw.source)
    const live = await saved(lw.carol, lw.source)
    const now = lw.api.clock.now().getTime()
    const deletedAt = (id: string, days: number) =>
      lw.api.db.query('UPDATE library_items SET deleted_at = $2 WHERE id = $1', [id, new Date(now - days * DAY)])
    await deletedAt(old.id, 31)
    await deletedAt(recent.id, 29)
    expect(await purgeDeletedLibraryItems(lw.api.db, lw.api.clock.now())).toBe(1)
    const left = (await lw.api.db.query<{ id: string }>('SELECT id FROM library_items ORDER BY id')).rows.map(
      (r) => r.id,
    )
    expect(left.sort()).toEqual([recent.id, live.id].sort())
    expect(await fileRows(lw)).toBe(0)
    expect(await purgeDeletedLibraryItems(lw.api.db, lw.api.clock.now())).toBe(0)
  })
})
