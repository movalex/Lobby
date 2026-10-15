// Wave Q (WS2): images in library items and placing an item on a board (docs/WAVE-Q-CONTRACTS.md §2.5). A saved
// item's versions must be ones its source board shows (uploaded to it or linked to it), of the same workspace; their
// facts come from the version rows; `place` links them into the target board (board_asset_links) before the client
// pushes, so the file routes and sync's file-refs check serve them there. Plus the thumb route, the cross-workspace
// 404, a deleted item, the internal-only rule for content leaving its scope, archived boards and the place rate limit.

import {
  INTERNAL_ONLY_CODE,
  LIBRARY_RATE_LIMITS,
  LibraryItem,
  ListLibraryMarksResponse,
  PlaceLibraryItemResponse,
} from '@draftroom/contracts'
import { newId } from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileRefsFor } from '../../../src/routes/engine-internal.ts'
import { createBoard } from '../../helpers.ts'
import { derivativeKey } from '../../../src/files/blobs.ts'
import { fileStatus } from '../history/helpers.ts'
import { newProject, setProject } from '../outside/internal-only-support.ts'
import {
  addThumb,
  answer,
  count,
  type El,
  image,
  itemUrl,
  LIB,
  type LibWorld,
  libraryWorld,
  place,
  rect,
  save,
  saved,
  uploadTo,
  WS,
} from './support.ts'

let w: LibWorld
beforeEach(async () => {
  w = await libraryWorld()
})
afterEach(() => w.api.close())

const placed = async (c: LibWorld['carol'], board: string, id: string) => {
  const res = await place(c, board, id)
  expect(res.statusCode, res.body).toBe(200)
  return PlaceLibraryItemResponse.parse(res.json())
}
const links = async (board: string) =>
  (
    await w.api.db.query<{ version_id: string }>(
      'SELECT version_id FROM board_asset_links WHERE board_id = $1 ORDER BY 1',
      [board],
    )
  ).rows.map((x) => x.version_id)

describe('images in a saved item', () => {
  it('a version the source board shows is kept, its facts rewritten from the version row; listed in the item', async () => {
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [rect('r'), image('i', v)] })
    expect(s.imageCount).toBe(1)
    const d = LibraryItem.parse((await w.dave.req('GET', itemUrl(s.id))).json())
    expect(d.files).toEqual([{ assetId: v.assetId, versionId: v.versionId }])
    const img = (d.elements as El[]).find((e) => e.type === 'image') as El
    expect(img.fileId).toBe(v.versionId)
    expect((img.customData as { lobby: { file: El } }).lobby.file).toEqual({
      assetId: v.assetId,
      versionId: v.versionId,
      kind: 'image',
      name: 'hero.png',
      mimeType: v.mimeType,
      sizeBytes: v.sizeBytes,
    })
    expect(await count(w.api, 'library_item_files WHERE item_id = $1', [s.id])).toBe(1)
  })

  it('a version linked to the source board counts as shown; one of another board, another workspace or made up: 400', async () => {
    const elsewhere = await createBoard(w.carol, WS, 'Elsewhere')
    const other = await uploadTo(w, w.carol, elsewhere, 'other.png')
    expect(answer(await save(w.carol, w.source, { elements: [image('i', other)] }))).toBe(
      '400 LIBRARY_FILE_NOT_SERVABLE',
    )
    // once the source holds a link to it (a copy that showed it), it may be saved from there
    await w.api.db.query(
      'INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)',
      [WS, w.source, other.assetId, other.versionId],
    )
    await saved(w.carol, w.source, { elements: [image('i', other)] })
    // another workspace's version, even the caller's own
    const mine = await createBoard(w.carol, w.carol.personalWorkspaceId, 'Mine')
    const foreign = await uploadTo(w, w.carol, mine, 'foreign.png')
    expect(answer(await save(w.carol, w.source, { elements: [image('i', foreign)] }))).toBe(
      '400 LIBRARY_FILE_NOT_SERVABLE',
    )
    // a version id nobody uploaded, and a real one named with another asset's id
    const real = await uploadTo(w, w.carol, w.source, 'real.png')
    const madeUp = { assetId: real.assetId, versionId: 'ver_madeup0000000000' }
    expect(answer(await save(w.carol, w.source, { elements: [image('i', madeUp)] }))).toBe(
      '400 LIBRARY_FILE_NOT_SERVABLE',
    )
    const swapped = { assetId: other.assetId, versionId: real.versionId }
    expect(answer(await save(w.carol, w.source, { elements: [image('i', swapped)] }))).toBe(
      '400 LIBRARY_FILE_NOT_SERVABLE',
    )
    // file facts on something that is not an image: the room would refuse it
    const card = rect('c', 0, 0, { customData: image('x', real).customData })
    expect(answer(await save(w.carol, w.source, { elements: [card] }))).toBe('400 LIBRARY_INVALID_ELEMENTS')
    // more than 20 images
    const many = Array.from({ length: 21 }, (_, i) => image(`i${i}`, real, { x: i * 10 }))
    expect(answer(await save(w.carol, w.source, { elements: many }))).toBe('413 LIBRARY_TOO_LARGE')
    expect(await count(w.api, 'library_items')).toBe(1)
  })
})

describe('placing an item', () => {
  it('links its versions into the target board first, answers the elements and the file facts, stamps Recents', async () => {
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const s = await saved(w.carol, w.source, { elements: [rect('r'), image('i', v)] })
    const other = await createBoard(w.dave, WS, 'Dave’s board')
    expect(await fileStatus(w.dave, v, other)).toBe(404)
    const p = await placed(w.dave, other, s.id)
    expect(p.item).toEqual({ id: s.id, name: 'Approval flow', revision: 1 })
    expect(p.elements).toHaveLength(2)
    expect(p.files).toEqual([
      {
        assetId: v.assetId,
        versionId: v.versionId,
        kind: 'image',
        name: 'hero.png',
        mimeType: v.mimeType,
        sizeBytes: v.sizeBytes,
      },
    ])
    expect(await links(other)).toEqual([v.versionId])
    // the file route and sync's A1 file-refs serve it on the target board now
    expect(await fileStatus(w.dave, v, other)).toBe(200)
    const board = { id: other, workspace_id: WS, status: 'active' as const }
    const refs = await fileRefsFor(w.api.db, board, [v.versionId])
    expect(refs.ok.map((r) => r.versionId)).toEqual([v.versionId])
    // again: no second link; on its own source board: no link at all
    await placed(w.dave, other, s.id)
    expect(await links(other)).toEqual([v.versionId])
    await placed(w.carol, w.source, s.id)
    expect(await links(w.source)).toEqual([])
    const marks = ListLibraryMarksResponse.parse((await w.dave.req('GET', `${LIB}/marks`)).json())
    expect(marks.recents.map((m) => m.key)).toEqual([`item:${s.id}`])
  })

  it('an item of another workspace is the 404 of a missing one; so is a deleted item', async () => {
    const s = await saved(w.carol, w.source)
    const mine = await createBoard(w.carol, w.carol.personalWorkspaceId, 'Mine')
    expect(answer(await place(w.carol, mine, s.id))).toBe('404 NOT_FOUND')
    expect(answer(await place(w.carol, w.target, 'lbi_nothing00000000000'))).toBe('404 NOT_FOUND')
    expect((await w.carol.req('DELETE', itemUrl(s.id))).statusCode).toBe(204)
    expect(answer(await place(w.carol, w.target, s.id))).toBe('404 NOT_FOUND')
  })

  it('needs edit on an active board: archived 403, trashed 404, a viewer 403', async () => {
    const s = await saved(w.carol, w.source)
    const archived = await createBoard(w.carol, WS, 'Old')
    expect((await w.carol.req('POST', `/api/boards/${archived}/archive`)).statusCode).toBe(200)
    expect(answer(await place(w.carol, archived, s.id))).toBe('403 FORBIDDEN')
    const binned = await createBoard(w.carol, WS, 'Binned')
    expect((await w.carol.req('POST', `/api/boards/${binned}/trash`)).statusCode).toBe(200)
    expect(answer(await place(w.carol, binned, s.id))).toBe('404 NOT_FOUND')
    expect(answer(await place(w.vic, w.viewOnly, s.id))).toBe('403 FORBIDDEN')
    expect(await count(w.api, 'board_asset_links')).toBe(0)
  })

  it('an internal-only item leaves its scope only for an owner or admin who is a creator (409 INTERNAL_ONLY)', async () => {
    const project = await newProject(w.carol, WS, 'Secret')
    expect((await setProject(w.owner, project, true)).statusCode).toBe(200)
    const inside = await createBoard(w.carol, WS, 'Inside')
    expect((await w.carol.req('PATCH', `/api/boards/${inside}`, { projectId: project })).statusCode).toBe(200)
    const s = await saved(w.carol, inside)
    expect(s.internalOnly).toBe(true)
    const res = await place(w.carol, w.target, s.id)
    expect(answer(res)).toBe(`409 ${INTERNAL_ONLY_CODE}`)
    // into the project (or another internal-only one) it goes
    await placed(w.carol, inside, s.id)
    // an owner or admin who is a creator may take it out
    await placed(w.admin, w.target, s.id)
    await placed(w.owner, w.target, s.id)
    // an outsider never sees it at all
    expect(answer(await place(w.pat, w.target, s.id))).toBe('404 NOT_FOUND')
  })

  it('places are limited per person: the 121st in a minute is 429', async () => {
    for (let i = 0; i < LIBRARY_RATE_LIMITS.place.max; i++)
      expect((await place(w.dave, w.target, 'lbi_nothing00000000000')).statusCode).toBe(404)
    expect(answer(await place(w.dave, w.target, 'lbi_nothing00000000000'))).toBe('429 RATE_LIMITED')
    const s = await saved(w.carol, w.source)
    await placed(w.carol, w.target, s.id)
  })
})

const thumb = (id: string, ver: string) => `${itemUrl(id)}/files/${ver}/thumb`

describe('the thumb of a version an item shows', () => {
  it('serves the published thumb, only for versions listed for that item', async () => {
    const v = await uploadTo(w, w.carol, w.source, 'hero.png')
    const bytes = await addThumb(w.api, v)
    const s = await saved(w.carol, w.source, { elements: [image('i', v)] })
    const other = await saved(w.carol, w.source)
    const res = await w.pat.req('GET', `${itemUrl(s.id)}/files/${v.versionId}/thumb`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toBe('image/webp')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.rawPayload.equals(bytes)).toBe(true)
    // another item does not show it; a made-up version; a version without a thumb
    expect(answer(await w.pat.req('GET', thumb(other.id, v.versionId)))).toBe('404 NOT_FOUND')
    expect(answer(await w.pat.req('GET', `${itemUrl(s.id)}/files/ver_madeup0000000000/thumb`))).toBe(
      '404 NOT_FOUND',
    )
    const bare = await uploadTo(w, w.carol, w.source, 'bare.png')
    const s2 = await saved(w.carol, w.source, { elements: [image('i', bare)] })
    expect(answer(await w.pat.req('GET', thumb(s2.id, bare.versionId)))).toBe('404 NOT_FOUND')
    // a deleted item's thumb: for whoever may restore it
    expect((await w.carol.req('DELETE', itemUrl(s.id))).statusCode).toBe(204)
    expect((await w.carol.req('GET', `${itemUrl(s.id)}/files/${v.versionId}/thumb`)).statusCode).toBe(200)
    expect(answer(await w.pat.req('GET', thumb(s.id, v.versionId)))).toBe('404 NOT_FOUND')
  })
})

describe('the thumb of a placed PDF page (review fix)', () => {
  it('?page=n serves that page’s rendering (the cover thumb for page 1); a page it lacks or a bad page: 404', async () => {
    const v = await uploadTo(w, w.carol, w.source, 'deck.png')
    const page = async (n: number, role: 'page' | 'thumb', bytes: number) => {
      const id = newId('drv')
      const key = derivativeKey(v.assetId, v.versionId, id, 'webp')
      const body = Buffer.alloc(bytes, n)
      await w.api.blobs.put(key, body, { contentType: 'image/webp', contentLength: bytes })
      await w.api.db.query(
        `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key)
         VALUES ($1, $2, $3, $4, $5, 10, 10, 'image/webp', $6, $7)`,
        [id, v.versionId, n, role, n, bytes, key],
      )
      return body
    }
    const cover = await page(1, 'thumb', 30)
    const third = await page(3, 'page', 33)
    const s = await saved(w.carol, w.source, { elements: [image('i', v, { fileId: `${v.versionId}.p3` })] })
    const get = (q: string) => w.pat.req('GET', `${thumb(s.id, v.versionId)}${q}`)
    const res = await get('?page=3')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.rawPayload.equals(third)).toBe(true)
    expect((await get('?page=1')).rawPayload.equals(cover)).toBe(true)
    expect((await get('')).rawPayload.equals(cover)).toBe(true)
    for (const q of ['?page=2', '?page=0', '?page=x', '?page=10000', '?page=3.5'])
      expect(answer(await get(q)), q).toBe('404 NOT_FOUND')
  })
})
