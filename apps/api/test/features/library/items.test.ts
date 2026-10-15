// Wave Q (WS2): the library's items. Saving a selection (the serializer again, the source board's view access and
// export policy, internal-only marking, the caps), listing and search with its cursor, one item's details, a change
// with its revision, soft delete and restore within 30 days, audit rows without names, and the save rate limit.

import {
  LIBRARY_LIMITS,
  LIBRARY_RATE_LIMITS,
  LibraryItem,
  LibraryItemSummary,
  ListLibraryResponse,
  libraryListPath,
  libraryRestorePath,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard } from '../../helpers.ts'
import { newProject, setProject } from '../outside/internal-only-support.ts'
import {
  answer,
  code,
  count,
  type El,
  fillItems,
  itemUrl,
  LIB,
  type LibWorld,
  libraryWorld,
  rect,
  save,
  saved,
  WS,
} from './support.ts'

let w: LibWorld
beforeEach(async () => {
  w = await libraryWorld()
})
afterEach(() => w.api.close())

const DAY = 86_400_000
const list = async (c: LibWorld['carol'], query: Parameters<typeof libraryListPath>[1] = {}) => {
  const res = await c.req('GET', libraryListPath(WS, query))
  expect(res.statusCode, res.body).toBe(200)
  return ListLibraryResponse.parse(res.json())
}
const detail = async (c: LibWorld['carol'], id: string) => {
  const res = await c.req('GET', itemUrl(id))
  expect(res.statusCode, res.body).toBe(200)
  return LibraryItem.parse(res.json())
}

describe('saving a selection', () => {
  it('201: re-keyed item-local elements at (0, 0), authorship from the session, revision 1; listed for members', async () => {
    const s = await saved(w.carol, w.source, {
      name: '  Approval flow ',
      tags: ['Flow', 'flow'],
      elements: [rect('board-a', 500, 300), rect('board-b', 650, 340, { locked: true })],
    })
    expect(s).toMatchObject({
      scope: 'workspace',
      name: 'Approval flow',
      tags: ['flow'],
      elementCount: 2,
      imageCount: 0,
      width: 250,
      height: 100,
      internalOnly: false,
      revision: 1,
      sourceKind: 'board',
      createdBy: { id: w.carol.userId, name: 'carol' },
      deletedAt: null,
      canEdit: true,
    })
    const d = await detail(w.pat, s.id)
    const els = d.elements as El[]
    expect(els.map((e) => e.id)).not.toContain('board-a')
    expect(Math.min(...els.map((e) => e.x as number))).toBe(0)
    expect(Math.min(...els.map((e) => e.y as number))).toBe(0)
    // the insert decides locking
    for (const e of els) expect(e.locked).toBe(false)
    expect(d.source).toEqual({ kind: 'board', boardId: w.source })
    expect(d.canEdit).toBe(false)
    for (const who of [w.owner, w.admin, w.dave, w.pat, w.vic])
      expect(
        (await list(who)).items.map((i) => i.id),
        who.userId,
      ).toEqual([s.id])
    // the stored row: the author is the caller; the audit row names no names
    const audit = await w.api.db.query<{ action: string; target: string; detail: El; actor_id: string }>(
      "SELECT action, target, detail, actor_id FROM audit_events WHERE action LIKE 'library.%'",
    )
    expect(audit.rows).toEqual([
      {
        action: 'library.item.create',
        target: s.id,
        actor_id: w.carol.userId,
        detail: { scope: 'workspace', sourceBoardId: w.source, elements: 2, images: 0 },
      },
    ])
  })

  it('refuses what the serializer refuses: 400 LIBRARY_INVALID_ELEMENTS, 413 LIBRARY_TOO_LARGE; nothing stored', async () => {
    const bad: [string, El[]][] = [
      ['embeddable', [rect('e', 0, 0, { type: 'embeddable', link: 'https://example.com', validated: true })]],
      ['data: link', [rect('d', 0, 0, { link: 'data:text/html,hi' })]],
      ['broken element', [rect('x', 0, 0, { width: 'wide' })]],
      ['nothing live', [rect('gone', 0, 0, { isDeleted: true })]],
    ]
    for (const [what, elements] of bad) {
      const res = await save(w.carol, w.source, { elements })
      expect(answer(res), what).toBe('400 LIBRARY_INVALID_ELEMENTS')
    }
    // over 256 KiB of element JSON (each box carries a 1 KiB link)
    const link = `https://example.com/${'a'.repeat(1000)}`
    const big = Array.from({ length: 250 }, (_, i) => rect(`b${i}`, i * 10, 0, { link }))
    expect(answer(await save(w.carol, w.source, { elements: big }))).toBe('413 LIBRARY_TOO_LARGE')
    // over 500 elements: the contract's envelope already
    const many = Array.from({ length: LIBRARY_LIMITS.itemElements + 1 }, (_, i) => rect(`m${i}`, i, 0))
    expect((await save(w.carol, w.source, { elements: many })).statusCode).toBe(400)
    expect(await count(w.api, 'library_items')).toBe(0)
  })

  it('needs view access to the source board in this workspace: else 404', async () => {
    const priv = await createBoard(w.dave, WS, 'Dave only')
    expect(answer(await save(w.carol, priv))).toBe('404 NOT_FOUND')
    const foreign = await createBoard(w.erin, w.erin.personalWorkspaceId, 'Elsewhere')
    expect(answer(await save(w.erin, foreign))).toBe('404 NOT_FOUND')
    // a board of another workspace the caller owns: still 404 here
    const mine = await createBoard(w.carol, w.carol.personalWorkspaceId, 'Mine elsewhere')
    expect(answer(await save(w.carol, mine))).toBe('404 NOT_FOUND')
    expect(answer(await save(w.carol, 'b-nonexistent'))).toBe('404 NOT_FOUND')
    const trashed = await createBoard(w.carol, WS, 'Binned')
    expect((await w.carol.req('POST', `/api/boards/${trashed}/trash`)).statusCode).toBe(200)
    expect(answer(await save(w.carol, trashed))).toBe('404 NOT_FOUND')
    expect(await count(w.api, 'library_items')).toBe(0)
  })

  it('respects the board export policy: copying limited to editors refuses a viewer (403 LIBRARY_EXPORT_REFUSED)', async () => {
    expect(
      (await w.carol.req('PATCH', `/api/boards/${w.source}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    const policy = (exportPolicy: string) =>
      w.carol.req('PUT', `/api/boards/${w.source}/export-policy`, { exportPolicy })
    expect((await policy('editors')).statusCode).toBe(200)
    // dave and pat only view it now; personal or workspace scope alike
    expect(answer(await save(w.dave, w.source))).toBe('403 LIBRARY_EXPORT_REFUSED')
    expect(answer(await save(w.pat, w.source, { scope: 'personal' }))).toBe('403 LIBRARY_EXPORT_REFUSED')
    // the board's owner, and anyone once everyone may copy
    await saved(w.carol, w.source)
    expect((await policy('everyone')).statusCode).toBe(200)
    await saved(w.dave, w.source)
    expect(await count(w.api, 'library_items')).toBe(2)
  })

  it('a save from an internal-only project is internal only: outsiders never see it, then or later', async () => {
    const project = await newProject(w.carol, WS, 'Secret')
    expect((await setProject(w.owner, project, true)).statusCode).toBe(200)
    const inside = await createBoard(w.carol, WS, 'Inside')
    // workspace-wide first (raising it inside the project would reach pat: IO-2b), then moved in
    expect(
      (await w.carol.req('PATCH', `/api/boards/${inside}`, { visibility: 'workspace_edit' })).statusCode,
    ).toBe(200)
    expect((await w.carol.req('PATCH', `/api/boards/${inside}`, { projectId: project })).statusCode).toBe(200)
    const secret = await saved(w.carol, inside, { name: 'Secret' })
    expect(secret.internalOnly).toBe(true)
    const open = await saved(w.carol, w.source, { name: 'Open' })
    expect((await list(w.pat)).items.map((i) => i.id)).toEqual([open.id])
    expect((await list(w.dave)).items.map((i) => i.id).sort()).toEqual([open.id, secret.id].sort())
    expect(answer(await w.pat.req('GET', itemUrl(secret.id)))).toBe('404 NOT_FOUND')
    // a board moved into the project later: its item is internal from then on (read now, not only at save)
    const moved = await w.carol.req('PATCH', `/api/boards/${w.source}`, { projectId: project })
    expect(moved.statusCode).toBe(200)
    expect((await list(w.pat)).items).toEqual([])
    expect(answer(await w.pat.req('GET', itemUrl(open.id)))).toBe('404 NOT_FOUND')
    expect((await detail(w.dave, open.id)).internalOnly).toBe(true)
    // a personal save of one's own is the owner's alone anyway
    const mine = await saved(w.pat, inside, { scope: 'personal' })
    expect(mine.internalOnly).toBe(true)
    expect((await list(w.pat, { scope: 'personal' })).items.map((i) => i.id)).toEqual([mine.id])
  })

  it('the details show the source board only to those who can view it now', async () => {
    const priv = await createBoard(w.carol, WS, 'Private')
    const s = await saved(w.carol, priv)
    expect((await detail(w.carol, s.id)).source).toEqual({ kind: 'board', boardId: priv })
    expect((await detail(w.dave, s.id)).source).toEqual({ kind: 'board', boardId: null })
  })

  it('a folder of the item’s own scope only (400 otherwise); the caps: 409 LIBRARY_FULL', async () => {
    const f = await w.carol.req('POST', `${LIB}/folders`, { scope: 'personal', name: 'Mine' })
    expect(f.statusCode, f.body).toBe(201)
    const folderId = (f.json() as { id: string }).id
    expect(answer(await save(w.carol, w.source, { folderId }))).toBe('400 BAD_REQUEST')
    expect(answer(await save(w.dave, w.source, { scope: 'personal', folderId }))).toBe('400 BAD_REQUEST')
    expect((await saved(w.carol, w.source, { scope: 'personal', folderId })).folderId).toBe(folderId)
    // a personal library holds 500 live items; deleted ones do not count
    await fillItems(w.api, LIBRARY_LIMITS.personalItems - 1, { ownerId: w.dave.userId, by: w.dave.userId })
    const last = await saved(w.dave, w.source, { scope: 'personal' })
    expect(answer(await save(w.dave, w.source, { scope: 'personal' }))).toBe('409 LIBRARY_FULL')
    expect((await w.dave.req('DELETE', itemUrl(last.id))).statusCode).toBe(204)
    await saved(w.dave, w.source, { scope: 'personal' })
    // the workspace library holds 5,000
    await fillItems(w.api, LIBRARY_LIMITS.workspaceItems, { ownerId: null, by: w.dave.userId, tag: 'w' })
    expect(answer(await save(w.carol, w.source))).toBe('409 LIBRARY_FULL')
    // and a restore must find room too
    expect(answer(await w.dave.req('POST', libraryRestorePath(WS, last.id)))).toBe('409 LIBRARY_FULL')
  })

  it('saves are limited per person: the 61st in a minute is 429, counted before anything is read', async () => {
    for (let i = 0; i < LIBRARY_RATE_LIMITS.save.max; i++)
      expect((await save(w.dave, w.source, { elements: [] })).statusCode).toBe(400)
    const over = await save(w.dave, w.source)
    expect(answer(over)).toBe('429 RATE_LIMITED')
    expect(over.headers['retry-after']).toBeDefined()
    // another person is not limited by it; the window passes
    await saved(w.carol, w.source)
    w.api.clock.advance(LIBRARY_RATE_LIMITS.save.windowMs)
    await saved(w.dave, w.source)
  })
})

describe('listing and search', () => {
  it('newest change first, 60 a page with a cursor; search by name and tag; folders; Recently deleted', async () => {
    await fillItems(w.api, 70, { ownerId: null, by: w.carol.userId })
    await w.api.db.query(
      `UPDATE library_items SET updated_at = now() - (substring(id from 10)::int * interval '1 second')`,
    )
    const flow = await saved(w.carol, w.source, { name: 'Approval 100% flow', tags: ['Sign off'] })
    const first = await list(w.dave)
    expect(first.items).toHaveLength(LIBRARY_LIMITS.pageSize)
    expect(first.items[0]?.id).toBe(flow.id)
    expect(first.nextCursor).not.toBeNull()
    const second = await list(w.dave, { cursor: first.nextCursor ?? '' })
    expect(second.items).toHaveLength(71 - LIBRARY_LIMITS.pageSize)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items].map((i) => i.id)
    expect(new Set(ids).size).toBe(71)
    // search: name (case-insensitive, % literal) and tags
    expect((await list(w.dave, { q: 'APPROVAL' })).items.map((i) => i.id)).toEqual([flow.id])
    expect((await list(w.dave, { q: '100%' })).items.map((i) => i.id)).toEqual([flow.id])
    expect((await list(w.dave, { q: '%' })).items.map((i) => i.id)).toEqual([flow.id])
    expect((await list(w.dave, { q: 'sign' })).items.map((i) => i.id)).toEqual([flow.id])
    expect((await list(w.dave, { tag: 'sign off' })).items.map((i) => i.id)).toEqual([flow.id])
    expect((await list(w.dave, { folder: 'none', q: 'flow' })).items).toHaveLength(1)
    // a cursor this api did not make: 400; an unknown query key: 400
    const forged = libraryListPath(WS, { cursor: 'bm90LWEtY3Vyc29y' })
    expect((await w.dave.req('GET', forged)).statusCode).toBe(400)
    expect((await w.dave.req('GET', `${libraryListPath(WS)}?evil=1`)).statusCode).toBe(400)
    // Recently deleted: what the caller could restore
    expect((await w.carol.req('DELETE', itemUrl(flow.id))).statusCode).toBe(204)
    expect((await list(w.carol, { deleted: '1' })).items.map((i) => i.id)).toEqual([flow.id])
    expect((await list(w.admin, { deleted: '1' })).items.map((i) => i.id)).toEqual([flow.id])
    expect((await list(w.dave, { deleted: '1' })).items).toEqual([])
    expect((await list(w.pat, { deleted: '1' })).items).toEqual([])
    expect((await list(w.dave, { q: 'flow' })).items).toEqual([])
  })

  it('personal libraries are their owners’ alone, owners and admins of the workspace included', async () => {
    const mine = await saved(w.dave, w.source, { scope: 'personal' })
    expect(mine.scope).toBe('personal')
    expect((await list(w.dave, { scope: 'personal' })).items.map((i) => i.id)).toEqual([mine.id])
    expect((await list(w.dave)).items).toEqual([])
    for (const who of [w.owner, w.admin, w.carol]) {
      expect((await list(who, { scope: 'personal' })).items, who.userId).toEqual([])
      expect(answer(await who.req('GET', itemUrl(mine.id))), who.userId).toBe('404 NOT_FOUND')
      expect(answer(await who.req('DELETE', itemUrl(mine.id))), who.userId).toBe('404 NOT_FOUND')
    }
  })
})

describe('changing, deleting and restoring', () => {
  it('PATCH checks the revision (409 LIBRARY_STALE_REVISION), bumps it, replaces elements and files', async () => {
    const s = await saved(w.carol, w.source)
    const r1 = await w.carol.req('PATCH', itemUrl(s.id), { revision: 1, name: 'Renamed', tags: ['x'] })
    expect(r1.statusCode, r1.body).toBe(200)
    expect(LibraryItemSummary.parse(r1.json())).toMatchObject({ name: 'Renamed', tags: ['x'], revision: 2 })
    expect(answer(await w.admin.req('PATCH', itemUrl(s.id), { revision: 1, name: 'Late' }))).toBe(
      '409 LIBRARY_STALE_REVISION',
    )
    // new elements need a board to check them against (contract: 400 without)
    const unchecked = await w.carol.req('PATCH', itemUrl(s.id), { revision: 2, elements: [rect('z')] })
    expect(unchecked.statusCode).toBe(400)
    const r2 = await w.admin.req('PATCH', itemUrl(s.id), {
      revision: 2,
      elements: [rect('z'), rect('y', 0, 100), rect('q', 0, 200)],
      sourceBoardId: w.target,
    })
    expect(r2.statusCode, r2.body).toBe(200)
    expect(LibraryItemSummary.parse(r2.json())).toMatchObject({ elementCount: 3, revision: 3, height: 260 })
    expect((await detail(w.carol, s.id)).source).toEqual({ kind: 'board', boardId: w.target })
    // nothing to update: 400
    expect((await w.carol.req('PATCH', itemUrl(s.id), { revision: 3 })).statusCode).toBe(400)
  })

  it('DELETE is soft (204, then 404 everywhere); restore within 30 days brings it back, then 404', async () => {
    const s = await saved(w.carol, w.source)
    expect((await w.carol.req('DELETE', itemUrl(s.id))).statusCode).toBe(204)
    expect(answer(await w.carol.req('DELETE', itemUrl(s.id)))).toBe('404 NOT_FOUND')
    expect(answer(await w.carol.req('GET', itemUrl(s.id)))).toBe('404 NOT_FOUND')
    const renamed = await w.carol.req('PATCH', itemUrl(s.id), { revision: 2, name: 'x' })
    expect(answer(renamed)).toBe('404 NOT_FOUND')
    // only an editor of it restores it
    expect(answer(await w.dave.req('POST', libraryRestorePath(WS, s.id)))).toBe('403 FORBIDDEN')
    expect(answer(await w.pat.req('POST', libraryRestorePath(WS, s.id)))).toBe('403 CREATOR_REQUIRED')
    const back = await w.carol.req('POST', libraryRestorePath(WS, s.id))
    expect(back.statusCode, back.body).toBe(200)
    expect(LibraryItemSummary.parse(back.json())).toMatchObject({ deletedAt: null, revision: 3 })
    expect((await list(w.dave)).items.map((i) => i.id)).toEqual([s.id])
    // past the window: no restore
    expect((await w.carol.req('DELETE', itemUrl(s.id))).statusCode).toBe(204)
    // (moved back in time: a 30-day clock jump would end the sessions too)
    await w.api.db.query('UPDATE library_items SET deleted_at = $2 WHERE id = $1', [
      s.id,
      new Date(w.api.clock.now().getTime() - LIBRARY_LIMITS.restoreDays * DAY - 1000),
    ])
    expect(answer(await w.carol.req('POST', libraryRestorePath(WS, s.id)))).toBe('404 NOT_FOUND')
    expect((await list(w.carol, { deleted: '1' })).items).toEqual([])
    const actions = await w.api.db.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'library.%' ORDER BY id",
    )
    expect(actions.rows.map((r) => r.action)).toEqual([
      'library.item.create',
      'library.item.delete',
      'library.item.restore',
      'library.item.delete',
    ])
  })
})

describe('what is never written', () => {
  it('no name or element content in the audit rows of any library action', async () => {
    const s = await saved(w.carol, w.source, { name: 'Top secret plan', elements: [rect('r', 0, 0)] })
    expect((await w.carol.req('DELETE', itemUrl(s.id))).statusCode).toBe(204)
    const rows = await w.api.db.query<{ detail: unknown }>(
      "SELECT detail FROM audit_events WHERE action LIKE 'library.%'",
    )
    expect(JSON.stringify(rows.rows)).not.toMatch(/secret|rectangle/i)
    expect(code(await w.carol.req('GET', itemUrl(s.id)))).toBe('NOT_FOUND')
  })
})
