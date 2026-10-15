// Wave Q review fixes (docs/WAVE-Q-CONTRACTS.md §9), on PGlite. The races themselves run on a real Postgres
// (library.pg.test.ts); here, what each route locks and reads inside its transaction, and the behaviour:
// - #2 /place decides the internal-only rule under the workspace row (FOR SHARE, before the item row);
// - #3 the links a place makes are pending until the client confirms; the sweep removes unconfirmed ones after an
//   hour, never a link that was there before and never one the board shows;
// - #4 a member removal sends their personal items here to "Recently deleted"; a re-add brings none back by itself;
// - #6 /place honours the source board's export policy, or the one captured at save once that board is gone;
// - #7 a favourite's cap is counted under a lock of the caller's marks.

import {
  EXPORT_DISABLED_CODE,
  LIBRARY_LIMITS,
  libraryListPath,
  libraryPlaceConfirmPath,
  ListLibraryResponse,
} from '@draftroom/contracts'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLACE_PENDING_MS,
  purgeDeletedLibraryItems,
  sweepPlacePending,
} from '../../../src/features/library/purge.ts'
import { createBoard, createTestApi } from '../../helpers.ts'
import { fileStatus } from '../history/helpers.ts'
import { newProject, setProject } from '../outside/internal-only-support.ts'
import {
  answer,
  count,
  image,
  LIB,
  type LibWorld,
  libraryWorld,
  place,
  recordingDb,
  rect,
  saved,
  sql,
  uploadTo,
  WS,
} from './support.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

async function world() {
  const base = await openTestDb()
  const rec = recordingDb(base)
  const api = await createTestApi({ db: rec.db })
  cleanup.push(async () => {
    await api.close()
    await base.close()
  })
  return { ...(await libraryWorld({ api })), transactions: rec.transactions }
}

/** The statements of the last transaction whose statements match `marker`. */
const txWith = (transactions: string[][], marker: RegExp) => {
  const found = transactions.filter((t) => t.some((s) => marker.test(s))).at(-1)
  if (!found) throw new Error(`no transaction ran ${marker}`)
  return found
}
const at = (tx: string[], re: RegExp) => tx.findIndex((s) => re.test(s))

const placedOk = async (c: LibWorld['carol'], board: string, id: string) => {
  const res = await place(c, board, id)
  expect(res.statusCode, res.body).toBe(200)
}
const confirm = (c: Parameters<typeof place>[0], board: string, id: string) =>
  c.req('POST', libraryPlaceConfirmPath(board, id))
const linksOn = async (w: LibWorld, board: string) =>
  (
    await w.api.db.query<{ version_id: string }>(
      'SELECT version_id FROM board_asset_links WHERE board_id = $1 ORDER BY 1',
      [board],
    )
  ).rows.map((r) => r.version_id)
const pendingOn = (w: LibWorld, board: string) =>
  count(w.api, 'library_place_pending WHERE board_id = $1', [board])
const later = (w: LibWorld, ms = PLACE_PENDING_MS + 60_000) => new Date(w.api.clock.now().getTime() + ms)
const showsNothing = async () => new Set<string>()

describe('#2 /place decides the internal-only rule under the workspace row lock', () => {
  it('the workspace row FOR SHARE, then the membership, then the item FOR SHARE, then the internal-only read', async () => {
    const w = await world()
    const s = await saved(w.carol, w.source)
    await placedOk(w.dave, w.target, s.id)
    const tx = txWith(w.transactions, /INSERT INTO library_marks/)
    const ws = at(tx, /FROM workspaces WHERE id = \$1 FOR SHARE/)
    const member = at(tx, /FROM workspace_members/)
    const item = at(tx, /FOR SHARE OF i/)
    const inside = at(tx, /AS inside FROM boards b JOIN workspaces w/)
    expect(ws).toBe(0)
    expect(member).toBeGreaterThan(ws)
    expect(item).toBeGreaterThan(member)
    // the item is not internal only: the board's scope need not be read; an internal-only one reads it in here
    expect(inside).toBe(-1)
    const project = await newProject(w.carol, WS, 'Secret')
    expect((await setProject(w.owner, project, true)).statusCode).toBe(200)
    expect((await w.carol.req('PATCH', `/api/boards/${w.source}`, { projectId: project })).statusCode).toBe(200)
    expect(answer(await place(w.dave, w.target, s.id))).toBe('409 INTERNAL_ONLY')
    const refused = txWith(w.transactions, /AS inside FROM boards b JOIN workspaces w/)
    expect(at(refused, /AS inside FROM boards b JOIN workspaces w/)).toBeGreaterThan(at(refused, /FOR SHARE OF i/))
    expect(at(refused, /FROM workspaces WHERE id = \$1 FOR SHARE/)).toBe(0)
  })
})

describe('#3 the links a place makes stay only once its push is confirmed', () => {
  it('a new link is pending; the confirm keeps it; the sweep removes an unconfirmed one after an hour', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [rect('r'), image('i', v)] })
    const kept = await createBoard(w.dave, WS, 'Pushed')
    const dropped = await createBoard(w.dave, WS, 'Never pushed')
    await placedOk(w.dave, kept, s.id)
    await placedOk(w.dave, dropped, s.id)
    expect(await pendingOn(w, kept)).toBe(1)
    expect(await pendingOn(w, dropped)).toBe(1)
    // the push to `kept` succeeded: its client confirms
    expect(answer(await confirm(w.dave, kept, s.id))).toBe('204')
    expect(await pendingOn(w, kept)).toBe(0)
    // within the hour the sweep leaves everything
    expect(await sweepPlacePending(w.api.db, w.api.clock.now(), showsNothing)).toEqual({
      removed: 0,
      kept: 0,
      unread: 0,
    })
    expect(await linksOn(w, dropped)).toEqual([v.versionId])
    // past the hour: the unconfirmed link goes, the confirmed one stays
    expect(await sweepPlacePending(w.api.db, later(w), showsNothing)).toEqual({ removed: 1, kept: 0, unread: 0 })
    expect(await linksOn(w, dropped)).toEqual([])
    expect(await linksOn(w, kept)).toEqual([v.versionId])
    expect(await fileStatus(w.dave, v, kept)).toBe(200)
    expect(await fileStatus(w.dave, v, dropped)).toBe(404)
    expect(await count(w.api, 'library_place_pending')).toBe(0)
  })

  it('never removes a link that was there before the place, nor one the board shows, nor an unread board’s', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [image('i', v)] })
    const before = await createBoard(w.dave, WS, 'Linked before')
    await w.api.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [WS, before, v.assetId, v.versionId],
    )
    await placedOk(w.dave, before, s.id)
    expect(await pendingOn(w, before)).toBe(0)
    // pushed, the confirm lost, the elements then undone: the board's "Recently deleted" still shows the version
    const shown = await createBoard(w.dave, WS, 'Shown')
    const unread = await createBoard(w.dave, WS, 'Unread')
    await placedOk(w.dave, shown, s.id)
    await placedOk(w.dave, unread, s.id)
    const shows = async (board: string) =>
      board === shown ? new Set([v.versionId]) : board === unread ? null : new Set<string>()
    expect(await sweepPlacePending(w.api.db, later(w), shows)).toEqual({ removed: 0, kept: 1, unread: 1 })
    expect(await linksOn(w, before)).toEqual([v.versionId])
    expect(await linksOn(w, shown)).toEqual([v.versionId])
    expect(await pendingOn(w, shown)).toBe(0)
    // the unread board keeps its row for the next pass, which removes the link once it can read the board
    expect(await pendingOn(w, unread)).toBe(1)
    expect(await sweepPlacePending(w.api.db, later(w), showsNothing)).toEqual({ removed: 1, kept: 0, unread: 0 })
    expect(await linksOn(w, unread)).toEqual([])
  })

  it('a second place before the confirm gives the pending link a fresh hour; a link on its own board is none', async () => {
    const w = await world()
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [image('i', v)] })
    const b = await createBoard(w.dave, WS, 'Twice')
    await placedOk(w.dave, b, s.id)
    w.api.clock.advance(PLACE_PENDING_MS - 60_000)
    await placedOk(w.dave, b, s.id)
    expect(await sweepPlacePending(w.api.db, later(w, 30 * 60_000), showsNothing)).toMatchObject({ removed: 0 })
    expect(await linksOn(w, b)).toEqual([v.versionId])
    await placedOk(w.carol, w.source, s.id)
    expect(await pendingOn(w, w.source)).toBe(0)
  })

  it('the confirm: 204 for whoever may edit the board and use the library; a viewer 403, a guest 403', async () => {
    const w = await world()
    const s = await saved(w.carol, w.source)
    expect(answer(await confirm(w.dave, w.target, s.id))).toBe('204')
    expect(answer(await confirm(w.dave, w.target, 'lbi_nothing00000000000'))).toBe('204')
    expect(answer(await confirm(w.vic, w.viewOnly, s.id))).toBe('403 FORBIDDEN')
    expect(answer(await confirm(w.gina, w.target, s.id))).toBe('403 FORBIDDEN')
    expect(answer(await confirm(w.sam, w.guestBoard, s.id))).toBe('403 GUEST_ACCOUNT_REQUIRED')
    expect(answer(await confirm(w.erin, w.target, s.id))).toBe('404 NOT_FOUND')
  })
})

describe('#4 a removed member’s personal library', () => {
  it('goes to Recently deleted with the membership (the purge then removes it); a re-add brings none of it back', async () => {
    const w = await world()
    const mine = await saved(w.dave, w.source, { scope: 'personal' })
    const shared = await saved(w.dave, w.source)
    const folder = await w.dave.req('POST', `${LIB}/folders`, { scope: 'personal', name: 'Mine' })
    expect(folder.statusCode).toBe(201)
    expect((await w.dave.req('PUT', `${LIB}/marks`, { key: 'piece:decision', favourite: true })).statusCode).toBe(
      200,
    )
    const removed = await w.owner.req('DELETE', `/api/workspaces/${WS}/members/${w.dave.userId}`)
    expect(removed.statusCode, removed.body).toBe(200)
    const row = await w.api.db.one<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM library_items WHERE id = $1',
      [mine.id],
    )
    expect(row.deleted_at).toBeInstanceOf(Date)
    // the workspace's item stays: it belongs to the workspace
    expect(await count(w.api, 'library_items WHERE id = $1 AND deleted_at IS NULL', [shared.id])).toBe(1)
    expect(await count(w.api, 'library_folders WHERE owner_id = $1', [w.dave.userId])).toBe(0)
    expect(await count(w.api, 'library_marks WHERE user_id = $1 AND workspace_id = $2', [w.dave.userId, WS])).toBe(0)
    const audit = await w.api.db.one<{ detail: { personalLibraryItemsDeleted?: number } }>(
      "SELECT detail FROM audit_events WHERE action = 'workspace.member.remove' ORDER BY id DESC LIMIT 1",
    )
    expect(audit.detail.personalLibraryItemsDeleted).toBe(1)
    // back within 30 days: the library is empty, the item is not silently restored
    await sql.role(w.api, w.dave.userId, 'member')
    const list = ListLibraryResponse.parse(
      (await w.dave.req('GET', libraryListPath(WS, { scope: 'personal' }))).json(),
    )
    expect(list.items).toEqual([])
    expect(answer(await place(w.dave, w.target, mine.id))).toBe('404 NOT_FOUND')
    // after the restore window the purge removes it
    expect(
      await purgeDeletedLibraryItems(
        w.api.db,
        new Date(w.api.clock.now().getTime() + (LIBRARY_LIMITS.restoreDays + 1) * 86_400_000),
      ),
    ).toBe(1)
    expect(await count(w.api, 'library_items WHERE id = $1', [mine.id])).toBe(0)
  })
})

describe('#6 /place honours the source board’s export policy', () => {
  const limit = (w: LibWorld, board: string, exportPolicy: string) =>
    w.carol.req('PUT', `/api/boards/${board}/export-policy`, { exportPolicy })

  it('while the board exists: a caller it does not let copy gets 403 EXPORT_DISABLED, read at every place', async () => {
    const w = await world()
    const s = await saved(w.dave, w.source)
    // dave saved it while he could; then the board is limited to its editors and he only views it
    expect((await w.carol.req('PATCH', `/api/boards/${w.source}`, { visibility: 'workspace_view' })).statusCode).toBe(
      200,
    )
    expect((await limit(w, w.source, 'editors')).statusCode).toBe(200)
    expect(answer(await place(w.dave, w.target, s.id))).toBe(`403 ${EXPORT_DISABLED_CODE}`)
    // pat only views it too; carol, its owner, and the workspace's admin edit it
    expect(answer(await place(w.pat, w.target, s.id))).toBe(`403 ${EXPORT_DISABLED_CODE}`)
    await placedOk(w.carol, w.target, s.id)
    await placedOk(w.admin, w.target, s.id)
    // a board-level editor grant lets dave copy again; and anyone once everyone may
    await sql.grant(w.api, w.source, w.dave.userId, 'editor', w.carol.userId)
    await placedOk(w.dave, w.target, s.id)
    expect((await limit(w, w.source, 'everyone')).statusCode).toBe(200)
    await placedOk(w.pat, w.target, s.id)
    expect(await count(w.api, 'board_asset_links')).toBe(0)
  })

  it('once the board is gone: the policy captured at save; a limited item only for the person who saved it', async () => {
    const w = await world()
    const open = await saved(w.carol, w.source)
    expect((await limit(w, w.source, 'editors')).statusCode).toBe(200)
    const limited = await saved(w.carol, w.source)
    const flags = await w.api.db.query<{ id: string; source_export_limited: boolean }>(
      'SELECT id, source_export_limited FROM library_items ORDER BY created_at, id',
    )
    expect(Object.fromEntries(flags.rows.map((r) => [r.id, r.source_export_limited]))).toEqual({
      [open.id]: false,
      [limited.id]: true,
    })
    // the board is deleted for good
    await w.api.db.query('DELETE FROM boards WHERE id = $1', [w.source])
    expect(answer(await place(w.dave, w.target, limited.id))).toBe(`403 ${EXPORT_DISABLED_CODE}`)
    expect(answer(await place(w.owner, w.target, limited.id))).toBe(`403 ${EXPORT_DISABLED_CODE}`)
    await placedOk(w.carol, w.target, limited.id)
    await placedOk(w.dave, w.target, open.id)
  })

  it('a save still needs view access to its source board and its export policy (the shapes come from there)', async () => {
    const w = await world()
    expect((await w.carol.req('PATCH', `/api/boards/${w.source}`, { visibility: 'workspace_view' })).statusCode).toBe(
      200,
    )
    expect((await limit(w, w.source, 'editors')).statusCode).toBe(200)
    expect(answer(await w.dave.req('POST', `${LIB}/items`, { scope: 'personal', name: 'X', sourceBoardId: w.source, elements: [rect('a')] }))).toBe('403 LIBRARY_EXPORT_REFUSED')
    const priv = await createBoard(w.carol, WS, 'Carol only')
    expect(answer(await w.dave.req('POST', `${LIB}/items`, { scope: 'personal', name: 'X', sourceBoardId: priv, elements: [rect('a')] }))).toBe('404 NOT_FOUND')
  })
})

describe('#7 the favourites cap is counted under a lock of the caller’s marks', () => {
  it('the PUT takes the advisory lock of (person, workspace) first, before it reads or counts anything', async () => {
    const w = await world()
    expect((await w.dave.req('PUT', `${LIB}/marks`, { key: 'piece:decision', favourite: true })).statusCode).toBe(
      200,
    )
    const tx = txWith(w.transactions, /INSERT INTO library_marks/)
    const lock = at(tx, /pg_advisory_xact_lock/)
    expect(lock).toBe(0)
    expect(at(tx, /SELECT count\(\*\)::int AS n FROM library_marks/)).toBeGreaterThan(lock)
  })

  it('still refuses the one past the cap (409 LIBRARY_FULL)', async () => {
    const w = await world()
    await w.api.db.query(
      `INSERT INTO library_marks (user_id, workspace_id, key, favourite)
       SELECT $1, $2, 'piece:p' || g, true FROM generate_series(1, $3::int) AS g`,
      [w.dave.userId, WS, LIBRARY_LIMITS.favourites],
    )
    expect(answer(await w.dave.req('PUT', `${LIB}/marks`, { key: 'piece:decision', favourite: true }))).toBe(
      '409 LIBRARY_FULL',
    )
  })
})
