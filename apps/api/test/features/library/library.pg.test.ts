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
// The review fixes (docs/WAVE-Q-CONTRACTS.md §9):
// - #2 the Internal only switch turned on while a place runs, either order: the switch under way holds the workspace
//   row, so the place waits and then refuses (409 INTERNAL_ONLY, nothing linked); a place under way holds it FOR
//   SHARE, so the switch waits and the place lands first.
// - #3 a confirm racing the hourly sweep, either order: both delete the pending row first, so the confirm first keeps
//   the link (the sweep then finds nothing), the sweep first removes it (the confirm then finds nothing: 204).
// - #7 two stars at the favourites cap minus one: the PUT takes the (person, workspace) advisory lock first, so the
//   second waits and then counts the first one's favourite: 409 LIBRARY_FULL.

import { LIBRARY_LIMITS, libraryPlaceConfirmPath } from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { PLACE_PENDING_MS, sweepPlacePending } from '../../../src/features/library/purge.ts'
import { type AssetGcDeps, collectWorkspace } from '../../../src/files/gc.ts'
import { createBoard, createTestApi } from '../../helpers.ts'
import { type PausingDb, pausingDb, waitedOrFinished } from '../../race-support.ts'
import { newProject, setProject } from '../outside/internal-only-support.ts'
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

/** The Internal only switch of a project, stopped once it has turned it (it holds the workspace row and the project). */
const SWITCH_HOLDS = /UPDATE projects SET internal_only = \$2 WHERE id = \$1/
/** A confirm's transaction, stopped once it has deleted the pending rows. */
const CONFIRM_HOLDS = /DELETE FROM library_place_pending p\s+USING library_item_files f/
/** The sweep's transaction for one board, stopped once it has deleted the board's old pending rows. */
const SWEEP_HOLDS = /DELETE FROM library_place_pending WHERE board_id = \$1 AND created_at <= \$2/
/** A mark's PUT, stopped once it holds the (person, workspace) advisory lock. */
const MARKS_HOLD = /pg_advisory_xact_lock/

const showsNothing = async () => new Set<string>()
const confirmOf = (c: LibWorld['carol'], board: string, id: string) =>
  c.req('POST', libraryPlaceConfirmPath(board, id))
const star = (c: LibWorld['carol'], key: string) => c.req('PUT', `${LIB}/marks`, { key, favourite: true })
const pastTheHour = (w: LibWorld) => new Date(w.api.clock.now().getTime() + PLACE_PENDING_MS + 60_000)

/** An item saved from a board of a project that is not internal only (yet), and the project. */
async function itemInProject(w: LibWorld) {
  const project = await newProject(w.carol, WS, 'Soon secret')
  const inside = await createBoard(w.carol, WS, 'Inside')
  const moved = await w.carol.req('PATCH', `/api/boards/${inside}`, {
    projectId: project,
    visibility: 'workspace_edit',
  })
  expect(moved.statusCode, moved.body).toBe(200)
  const s = await saved(w.carol, inside)
  expect(s.internalOnly).toBe(false)
  return { project, item: s.id }
}

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

  it('#2 the Internal only switch under way, then a place: the place waits, then 409 INTERNAL_ONLY, nothing linked', async () => {
    const w = await world()
    const { project, item } = await itemInProject(w)
    const pause = w.paused.arm(SWITCH_HOLDS, 'after')
    const switching = setProject(w.owner, project, true)
    const pid = await pause.reached
    const placing = place(w.dave, w.target, item)
    try {
      expect(await waitedOrFinished(w.api.db, pid, placing)).toBe('waited')
    } finally {
      pause.release()
    }
    const [sw, p] = await Promise.all([switching, placing])
    expect(sw.statusCode, sw.body).toBe(200)
    expect(answer(p)).toBe('409 INTERNAL_ONLY')
    expect(await count(w.api, 'board_asset_links WHERE board_id = $1', [w.target])).toBe(0)
    expect(await count(w.api, 'library_marks WHERE user_id = $1', [w.dave.userId])).toBe(0)
  })

  it('#2 a place under way, then the switch: the switch waits; the place lands first, the next one is refused', async () => {
    const w = await world()
    const { project, item } = await itemInProject(w)
    const pause = w.paused.arm(PLACE_HOLDS, 'after')
    const placing = place(w.dave, w.target, item)
    const pid = await pause.reached
    const switching = setProject(w.owner, project, true)
    try {
      expect(await waitedOrFinished(w.api.db, pid, switching)).toBe('waited')
    } finally {
      pause.release()
    }
    const [p, sw] = await Promise.all([placing, switching])
    expect(answer(p)).toBe('200')
    expect(sw.statusCode, sw.body).toBe(200)
    expect(answer(await place(w.dave, w.target, item))).toBe('409 INTERNAL_ONLY')
  })

  it('#3 a confirm under way, then the sweep: the sweep waits, finds nothing to remove; the link stays', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [image('i', v)] })
    expect(answer(await place(w.dave, w.target, s.id))).toBe('200')
    const pause = w.paused.arm(CONFIRM_HOLDS, 'after')
    const confirming = confirmOf(w.dave, w.target, s.id)
    const pid = await pause.reached
    const sweeping = sweepPlacePending(w.api.db, pastTheHour(w), showsNothing)
    try {
      expect(await waitedOrFinished(w.api.db, pid, sweeping)).toBe('waited')
    } finally {
      pause.release()
    }
    const [c, r] = await Promise.all([confirming, sweeping])
    expect(answer(c)).toBe('204')
    expect(r).toEqual({ removed: 0, kept: 0, unread: 0 })
    expect(await count(w.api, 'board_asset_links WHERE board_id = $1', [w.target])).toBe(1)
    expect(await count(w.api, 'library_place_pending')).toBe(0)
  })

  it('#3 the sweep under way, then a confirm: the confirm waits, then finds nothing (204); the link is gone', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [image('i', v)] })
    expect(answer(await place(w.dave, w.target, s.id))).toBe('200')
    const pause = w.paused.arm(SWEEP_HOLDS, 'after')
    const sweeping = sweepPlacePending(w.api.db, pastTheHour(w), showsNothing)
    const pid = await pause.reached
    const confirming = confirmOf(w.dave, w.target, s.id)
    try {
      expect(await waitedOrFinished(w.api.db, pid, confirming)).toBe('waited')
    } finally {
      pause.release()
    }
    const [r, c] = await Promise.all([sweeping, confirming])
    expect(r).toEqual({ removed: 1, kept: 0, unread: 0 })
    expect(answer(c)).toBe('204')
    expect(await count(w.api, 'board_asset_links WHERE board_id = $1', [w.target])).toBe(0)
    expect(await count(w.api, 'library_place_pending')).toBe(0)
  })

  it('#7 two stars with one favourite of room: the second waits for the first, then 409 LIBRARY_FULL', async () => {
    const w = await world()
    await w.api.db.query(
      `INSERT INTO library_marks (user_id, workspace_id, key, favourite)
       SELECT $1, $2, 'piece:p' || g, true FROM generate_series(1, $3::int) AS g`,
      [w.dave.userId, WS, LIBRARY_LIMITS.favourites - 1],
    )
    const pause = w.paused.arm(MARKS_HOLD, 'after')
    const first = star(w.dave, 'piece:decision')
    const pid = await pause.reached
    const second = star(w.dave, 'piece:process')
    try {
      expect(await waitedOrFinished(w.api.db, pid, second)).toBe('waited')
    } finally {
      pause.release()
    }
    const [a, b] = await Promise.all([first, second])
    expect(answer(a)).toBe('200')
    expect(answer(b)).toBe('409 LIBRARY_FULL')
    expect(
      await count(w.api, 'library_marks WHERE user_id = $1 AND workspace_id = $2 AND favourite', [
        w.dave.userId,
        WS,
      ]),
    ).toBe(LIBRARY_LIMITS.favourites)
  })
})
