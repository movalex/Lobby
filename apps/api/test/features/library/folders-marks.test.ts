// Wave Q (WS2): the library's folders (flat, unique names per scope whatever the case, the caps, items kept
// folderless when a folder goes) and each person's favourites and recents (a mark grants nothing: unreadable items are
// left out, an item key needs a readable item; the favourites cap; the last 12 uses).

import {
  LIBRARY_LIMITS,
  LibraryFolder,
  LibraryMark,
  ListLibraryFoldersResponse,
  ListLibraryMarksResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answer, count, itemUrl, LIB, type LibWorld, libraryWorld, saved, WS } from './support.ts'

let w: LibWorld
beforeEach(async () => {
  w = await libraryWorld()
})
afterEach(() => w.api.close())

const folder = async (c: LibWorld['carol'], body: { scope: string; name: string }) => {
  const res = await c.req('POST', `${LIB}/folders`, body)
  expect(res.statusCode, res.body).toBe(201)
  return LibraryFolder.parse(res.json())
}
const folders = async (c: LibWorld['carol'], scope: string) =>
  ListLibraryFoldersResponse.parse((await c.req('GET', `${LIB}/folders?scope=${scope}`)).json()).folders
const marks = async (c: LibWorld['carol']) => {
  const res = await c.req('GET', `${LIB}/marks`)
  expect(res.statusCode, res.body).toBe(200)
  return ListLibraryMarksResponse.parse(res.json())
}
const mark = (c: LibWorld['carol'], body: object) => c.req('PUT', `${LIB}/marks`, body)

describe('folders', () => {
  it('made at the end of the order; unique per scope whatever the case (409 LIBRARY_FOLDER_EXISTS); counts', async () => {
    const a = await folder(w.carol, { scope: 'workspace', name: 'Flows' })
    const b = await folder(w.dave, { scope: 'workspace', name: 'Icons' })
    expect([a.position, b.position]).toEqual([0, 1])
    expect(a).toMatchObject({ scope: 'workspace', itemCount: 0, canEdit: true })
    expect(answer(await w.dave.req('POST', `${LIB}/folders`, { scope: 'workspace', name: 'FLOWS' }))).toBe(
      '409 LIBRARY_FOLDER_EXISTS',
    )
    // the same name in a personal library is another scope
    const mine = await folder(w.dave, { scope: 'personal', name: 'flows' })
    expect(answer(await w.dave.req('POST', `${LIB}/folders`, { scope: 'personal', name: 'Flows' }))).toBe(
      '409 LIBRARY_FOLDER_EXISTS',
    )
    await saved(w.carol, w.source, { folderId: a.id })
    await saved(w.dave, w.source, { folderId: a.id })
    await saved(w.dave, w.source, { scope: 'personal', folderId: mine.id })
    const ws = await folders(w.pat, 'workspace')
    expect(ws.map((f) => [f.name, f.itemCount, f.canEdit])).toEqual([
      ['Flows', 2, false],
      ['Icons', 0, false],
    ])
    expect((await folders(w.dave, 'personal')).map((f) => [f.name, f.itemCount])).toEqual([['flows', 1]])
    expect(await folders(w.carol, 'personal')).toEqual([])
    // renaming onto another's name: 409; onto its own in another case: fine
    expect(answer(await w.carol.req('PATCH', `${LIB}/folders/${a.id}`, { name: 'icons' }))).toBe(
      '409 LIBRARY_FOLDER_EXISTS',
    )
    const renamed = await w.carol.req('PATCH', `${LIB}/folders/${a.id}`, { name: 'FLOWS', position: 5 })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(LibraryFolder.parse(renamed.json())).toMatchObject({ name: 'FLOWS', position: 5, itemCount: 2 })
    expect((await folders(w.dave, 'workspace')).map((f) => f.name)).toEqual(['Icons', 'FLOWS'])
  })

  it('deleting a folder keeps its items, folderless', async () => {
    const a = await folder(w.carol, { scope: 'workspace', name: 'Flows' })
    const s = await saved(w.carol, w.source, { folderId: a.id })
    expect((await w.carol.req('DELETE', `${LIB}/folders/${a.id}`)).statusCode).toBe(204)
    expect(answer(await w.carol.req('DELETE', `${LIB}/folders/${a.id}`))).toBe('404 NOT_FOUND')
    const item = await w.carol.req('GET', itemUrl(s.id))
    expect(item.statusCode).toBe(200)
    expect((item.json() as { folderId: unknown }).folderId).toBeNull()
    // a folder of the other scope, or gone, cannot take an item
    const res = await w.carol.req('PATCH', itemUrl(s.id), { revision: 1, folderId: a.id })
    expect(answer(res)).toBe('400 BAD_REQUEST')
  })

  it('the caps: 200 per workspace, 50 per person (409 LIBRARY_FULL)', async () => {
    await w.api.db.query(
      `INSERT INTO library_folders (id, workspace_id, owner_id, name, created_by)
       SELECT 'lbf_fill' || lpad(g::text, 10, '0'), $1, $2, 'F' || g, $2 FROM generate_series(1, $3::int) AS g`,
      [WS, w.dave.userId, LIBRARY_LIMITS.personalFolders],
    )
    expect(answer(await w.dave.req('POST', `${LIB}/folders`, { scope: 'personal', name: 'One more' }))).toBe(
      '409 LIBRARY_FULL',
    )
    await w.api.db.query(
      `INSERT INTO library_folders (id, workspace_id, owner_id, name, created_by)
       SELECT 'lbf_wfil' || lpad(g::text, 10, '0'), $1, NULL, 'W' || g, $2 FROM generate_series(1, $3::int) AS g`,
      [WS, w.dave.userId, LIBRARY_LIMITS.workspaceFolders],
    )
    expect(answer(await w.dave.req('POST', `${LIB}/folders`, { scope: 'workspace', name: 'One more' }))).toBe(
      '409 LIBRARY_FULL',
    )
    // carol's own personal library still has room
    await folder(w.carol, { scope: 'personal', name: 'One more' })
  })
})

describe('marks: favourites and recents', () => {
  it('star, unstar and stamp uses of every source; the last 12 uses; a mark with nothing left goes', async () => {
    const s = await saved(w.carol, w.source)
    const star = await mark(w.dave, { key: 'icon:lucide:arrow-right@1.49.0', favourite: true })
    expect(star.statusCode, star.body).toBe(200)
    expect(LibraryMark.parse(star.json())).toEqual({
      key: 'icon:lucide:arrow-right@1.49.0',
      favourite: true,
      usedAt: null,
    })
    expect((await mark(w.dave, { key: `item:${s.id}`, favourite: true, used: true })).statusCode).toBe(200)
    for (let i = 0; i < 14; i++) {
      w.api.clock.advance(1000)
      expect((await mark(w.dave, { key: `piece:p${i}`, used: true })).statusCode).toBe(200)
    }
    const m = await marks(w.dave)
    expect(m.favourites.map((x) => x.key)).toEqual(['icon:lucide:arrow-right@1.49.0', `item:${s.id}`])
    expect(m.recents).toHaveLength(LIBRARY_LIMITS.recents)
    expect(m.recents[0]?.key).toBe('piece:p13')
    // marks are per person
    expect(await marks(w.carol)).toEqual({ favourites: [], recents: [] })
    // unstarring a mark never used removes it
    const off = await mark(w.dave, { key: 'icon:lucide:arrow-right@1.49.0', favourite: false })
    expect(LibraryMark.parse(off.json())).toMatchObject({ favourite: false, usedAt: null })
    expect(await count(w.api, 'library_marks WHERE key = $1', ['icon:lucide:arrow-right@1.49.0'])).toBe(0)
    // a key that is no mark key, and nothing to update: 400
    expect((await mark(w.dave, { key: 'icon:evil:x@1.0.0', favourite: true })).statusCode).toBe(400)
    expect((await mark(w.dave, { key: 'piece:decision' })).statusCode).toBe(400)
  })

  it('a mark grants nothing: an unreadable item’s key is refused (404) and left out of the answer', async () => {
    const s = await saved(w.carol, w.source)
    const mine = await saved(w.carol, w.source, { scope: 'personal' })
    expect(answer(await mark(w.dave, { key: `item:${mine.id}`, favourite: true }))).toBe('404 NOT_FOUND')
    const gone = await mark(w.dave, { key: 'item:lbi_nothing00000000000', used: true })
    expect(answer(gone)).toBe('404 NOT_FOUND')
    expect((await mark(w.dave, { key: `item:${s.id}`, favourite: true, used: true })).statusCode).toBe(200)
    expect((await marks(w.dave)).favourites).toHaveLength(1)
    expect((await w.carol.req('DELETE', itemUrl(s.id))).statusCode).toBe(204)
    expect(await marks(w.dave)).toEqual({ favourites: [], recents: [] })
    // the row stays (a restore brings it back)
    expect((await w.carol.req('POST', `${itemUrl(s.id)}/restore`)).statusCode).toBe(200)
    expect((await marks(w.dave)).favourites.map((x) => x.key)).toEqual([`item:${s.id}`])
  })

  it('at most 500 favourites per person and workspace (409 LIBRARY_FULL)', async () => {
    await w.api.db.query(
      `INSERT INTO library_marks (user_id, workspace_id, key, favourite)
       SELECT $1, $2, 'piece:f' || g, true FROM generate_series(1, $3::int) AS g`,
      [w.dave.userId, WS, LIBRARY_LIMITS.favourites],
    )
    expect(answer(await mark(w.dave, { key: 'piece:one-more', favourite: true }))).toBe('409 LIBRARY_FULL')
    // starring one already starred is no new one; a use is never limited
    expect((await mark(w.dave, { key: 'piece:f1', favourite: true })).statusCode).toBe(200)
    expect((await mark(w.dave, { key: 'piece:one-more', used: true })).statusCode).toBe(200)
    expect((await marks(w.dave)).favourites).toHaveLength(LIBRARY_LIMITS.favourites)
  })
})
