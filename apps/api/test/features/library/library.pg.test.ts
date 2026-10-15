// Wave Q (WS2): the element library against the races that matter, on a real Postgres (PGlite has one connection, so
// two transactions never wait for each other there): set DRAFTROOM_TEST_DATABASE_URL to a database these tests may
// create and drop schemas in. Skipped otherwise. Each test stops the REAL route midway (race-support.ts pausingDb)
// and runs the REAL other request against it.
//
// - Two saves into one folder: every library write takes the workspace row first, so the second waits; the cap and
//   the folder are read again under the lock (one item left in the library: the second answers 409 LIBRARY_FULL).
// - A folder deleted while a save into it runs, either order: the save lands and the folder goes (the item stays,
//   folderless), or the folder goes and the save answers 400 (no item in a folder that is gone).
// - A delete during a place, either order: a place holds the item FOR SHARE, so a delete waits for it (the board's
//   links are written and the item then deleted); a delete under way makes the place wait and answer 404 (no links).
// - The file collector during a save, either order: GC holds the version's row (FOR UPDATE) while it deletes it, so
//   the save's library_item_files row waits on its foreign key, then fails: 400 LIBRARY_FILE_NOT_SERVABLE, no item;
//   a save under way holds the version (its foreign key) and GC, once it gets the row, sees the file row and keeps it.

import { LIBRARY_LIMITS } from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { type AssetGcDeps, collectWorkspace } from '../../../src/files/gc.ts'
import { createTestApi } from '../../helpers.ts'
import { type PausingDb, pausingDb, waitedOrFinished } from '../../race-support.ts'
import {
  answer,
  count,
  fillItems,
  image,
  itemUrl,
  LIB,
  type LibWorld,
  libraryWorld,
  place,
  save,
  saved,
  uploadTo,
  WS,
} from './support.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL
const DAY = 86_400_000

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

async function world(): Promise<LibWorld & { paused: PausingDb }> {
  const base = await openTestDb()
  const paused = pausingDb(base)
  const api = await createTestApi({ db: paused.db })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  return { ...(await libraryWorld({ api })), paused }
}

const folderOf = async (c: LibWorld['carol'], scope: 'workspace' | 'personal', name: string) => {
  const res = await c.req('POST', `${LIB}/folders`, { scope, name })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}

/** A save's transaction, stopped once it has written its item row (it holds the workspace row and the item). */
const SAVE_HOLDS = /INSERT INTO library_items/
/** A place's transaction, stopped once it holds the item row FOR SHARE. */
const PLACE_HOLDS = /FOR SHARE OF i/
/** A delete's transaction, stopped once it has marked the item deleted (it holds the workspace row and the item). */
const DELETE_HOLDS = /UPDATE library_items SET deleted_at = \$2/
/** A folder delete's transaction, stopped once the folder row is gone. */
const FOLDER_DELETE_HOLDS = /DELETE FROM library_folders/
/** The collector's delete of one version, stopped once it holds the version row FOR UPDATE. */
const GC_HOLDS = /FROM asset_versions WHERE id = \$1 AND workspace_id = \$2 FOR UPDATE/
/** A save's transaction, stopped once its library_item_files rows are written (their foreign key holds the version). */
const FILES_HOLD = /INSERT INTO library_item_files/

/** The collector, with every board read as showing nothing. */
const gc = (w: LibWorld): AssetGcDeps => ({
  db: w.api.db,
  blobs: w.api.blobs,
  sync: { assetRefs: async (boardId: string) => ({ boardId, exists: true, canvas: [], deleted: [] }) },
  dataRoot: w.api.config.dataDir,
  now: w.api.clock.now,
  log: { info: () => {}, warn: () => {} },
})

/** A version the collector deletes in its next delete-mode pass: uploaded long ago, unreferenced past the grace. */
async function eligible(w: LibWorld, v: { versionId: string }) {
  const now = w.api.clock.now().getTime()
  await w.api.db.query('UPDATE asset_versions SET created_at = $2, unreferenced_since = $3 WHERE id = $1', [
    v.versionId,
    new Date(now - 60 * DAY),
    new Date(now - 40 * DAY),
  ])
}

describe.skipIf(!PG)('the element library against concurrent writes (real Postgres)', () => {
  it('two saves into one folder with one item of room: the second waits, then 409 LIBRARY_FULL', async () => {
    const w = await world()
    const folderId = await folderOf(w.dave, 'personal', 'Kits')
    await fillItems(w.api, LIBRARY_LIMITS.personalItems - 1, { ownerId: w.dave.userId, by: w.dave.userId })
    const pause = w.paused.arm(SAVE_HOLDS, 'after')
    const first = save(w.dave, w.source, { scope: 'personal', folderId })
    const pid = await pause.reached
    const second = save(w.dave, w.source, { scope: 'personal', folderId })
    try {
      expect(await waitedOrFinished(w.api.db, pid, second)).toBe('waited')
    } finally {
      pause.release()
    }
    const [a, b] = await Promise.all([first, second])
    expect(answer(a)).toBe('201')
    expect(answer(b)).toBe('409 LIBRARY_FULL')
    expect(await count(w.api, 'library_items WHERE folder_id = $1', [folderId])).toBe(1)
  })

  it('two saves into one folder with room: one after the other, both kept, the folder counts two', async () => {
    const w = await world()
    const folderId = await folderOf(w.carol, 'workspace', 'Flows')
    const pause = w.paused.arm(SAVE_HOLDS, 'after')
    const first = save(w.carol, w.source, { folderId })
    const pid = await pause.reached
    const second = save(w.dave, w.source, { folderId })
    try {
      expect(await waitedOrFinished(w.api.db, pid, second)).toBe('waited')
    } finally {
      pause.release()
    }
    expect((await Promise.all([first, second])).map(answer)).toEqual(['201', '201'])
    const folders = await w.pat.req('GET', `${LIB}/folders?scope=workspace`)
    expect((folders.json() as { folders: { itemCount: number }[] }).folders[0]?.itemCount).toBe(2)
  })

  it('a save into a folder under way, then the folder is deleted: it waits; the item stays, folderless', async () => {
    const w = await world()
    const folderId = await folderOf(w.carol, 'workspace', 'Flows')
    const pause = w.paused.arm(SAVE_HOLDS, 'after')
    const saving = save(w.carol, w.source, { folderId })
    const pid = await pause.reached
    const deleting = w.carol.req('DELETE', `${LIB}/folders/${folderId}`)
    try {
      expect(await waitedOrFinished(w.api.db, pid, deleting)).toBe('waited')
    } finally {
      pause.release()
    }
    const [s, d] = await Promise.all([saving, deleting])
    expect(answer(s)).toBe('201')
    expect(answer(d)).toBe('204')
    const item = await w.carol.req('GET', itemUrl((s.json() as { id: string }).id))
    expect((item.json() as { folderId: unknown }).folderId).toBeNull()
  })

  it('a folder delete under way, then a save into it: the save waits, then 400 (no item in a folder that is gone)', async () => {
    const w = await world()
    const folderId = await folderOf(w.carol, 'workspace', 'Flows')
    const pause = w.paused.arm(FOLDER_DELETE_HOLDS, 'after')
    const deleting = w.carol.req('DELETE', `${LIB}/folders/${folderId}`)
    const pid = await pause.reached
    const saving = save(w.carol, w.source, { folderId })
    try {
      expect(await waitedOrFinished(w.api.db, pid, saving)).toBe('waited')
    } finally {
      pause.release()
    }
    const [d, s] = await Promise.all([deleting, saving])
    expect(answer(d)).toBe('204')
    expect(answer(s)).toBe('400 BAD_REQUEST')
    expect(await count(w.api, 'library_items')).toBe(0)
  })

  it('a place under way, then a delete: the delete waits; the links are written, then the item is deleted', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [image('i', v)] })
    const pause = w.paused.arm(PLACE_HOLDS, 'after')
    const placing = place(w.dave, w.target, s.id)
    const pid = await pause.reached
    const deleting = w.carol.req('DELETE', itemUrl(s.id))
    try {
      expect(await waitedOrFinished(w.api.db, pid, deleting)).toBe('waited')
    } finally {
      pause.release()
    }
    const [p, d] = await Promise.all([placing, deleting])
    expect(answer(p)).toBe('200')
    expect(answer(d)).toBe('204')
    expect(await count(w.api, 'board_asset_links WHERE board_id = $1', [w.target])).toBe(1)
    expect(answer(await place(w.dave, w.target, s.id))).toBe('404 NOT_FOUND')
  })

  it('a delete under way, then a place: the place waits, then answers 404 and links nothing', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [image('i', v)] })
    const pause = w.paused.arm(DELETE_HOLDS, 'after')
    const deleting = w.carol.req('DELETE', itemUrl(s.id))
    const pid = await pause.reached
    const placing = place(w.dave, w.target, s.id)
    try {
      expect(await waitedOrFinished(w.api.db, pid, placing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [d, p] = await Promise.all([deleting, placing])
    expect(answer(d)).toBe('204')
    expect(answer(p)).toBe('404 NOT_FOUND')
    expect(await count(w.api, 'board_asset_links WHERE board_id = $1', [w.target])).toBe(0)
  })

  it('GC deleting a version, then a save that shows it: the save waits, then 400 LIBRARY_FILE_NOT_SERVABLE', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'old.png')
    await eligible(w, v)
    const pause = w.paused.arm(GC_HOLDS, 'after')
    const collecting = collectWorkspace(gc(w), WS, 'delete')
    const pid = await pause.reached
    const saving = save(w.carol, w.source, { elements: [image('i', v)] })
    try {
      expect(await waitedOrFinished(w.api.db, pid, saving)).toBe('waited')
    } finally {
      pause.release()
    }
    const [r, s] = await Promise.all([collecting, saving])
    expect(r?.deleted.versions).toBe(1)
    expect(answer(s)).toBe('400 LIBRARY_FILE_NOT_SERVABLE')
    expect(await count(w.api, 'library_items')).toBe(0)
  })

  it('a save that shows a version under way, then GC: GC waits for the version, sees the item and keeps it', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'old.png')
    await eligible(w, v)
    const pause = w.paused.arm(FILES_HOLD, 'after')
    const saving = save(w.carol, w.source, { elements: [image('i', v)] })
    const pid = await pause.reached
    const collecting = collectWorkspace(gc(w), WS, 'delete')
    try {
      expect(await waitedOrFinished(w.api.db, pid, collecting)).toBe('waited')
    } finally {
      pause.release()
    }
    const [s, r] = await Promise.all([saving, collecting])
    expect(answer(s)).toBe('201')
    expect(r?.deleted.versions).toBe(0)
    expect(await count(w.api, 'asset_versions WHERE id = $1', [v.versionId])).toBe(1)
  })
})
