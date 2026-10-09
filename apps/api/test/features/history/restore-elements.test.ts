// POST /api/boards/:bid/snapshots/:sid/restore-elements (wave L, L7-2; features/history/restore-elements.ts): the
// api in front of the sync's selective restore. Who may (editors with an account, workspace members above guest,
// active boards), what it sends (the checkpoint's copies closed over labels, the restorer as the actor), the
// 'before_restore' checkpoint made FIRST, and what the sync's answers become (404 → 503 RESTORE_UNAVAILABLE, 409
// element-limit → 409 ELEMENT_LIMIT). Two at once: restore-support.ts `twoRestoresAtOnce` (also on real Postgres,
// restore-elements.pg.test.ts).
import { RestoreElementsResult } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeOverLabels } from '../../../src/features/history/restore-elements.ts'
import { createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { errorCode, guestLink, joinAsGuest } from '../guests/support.ts'
import { createFakeSync, noteRec } from './helpers.ts'
import {
  type El,
  noteWith,
  RestoreSync,
  type RestoreWorld,
  restorePath,
  restoreWorld,
  twoRestoresAtOnce,
} from './restore-support.ts'

let api: TestApi
let sync: RestoreSync
let w: RestoreWorld

beforeEach(async () => {
  sync = new RestoreSync()
  api = await createTestApi({ deps: { syncInternal: sync } })
  w = await restoreWorld(api, sync)
})
afterEach(() => api.close())

const restore = (body: unknown, sid = w.checkpointId, bid = w.boardId, c = w.bob) =>
  c.req('POST', restorePath(bid, sid), body)
const beforeRestoreRows = async () =>
  (
    await api.db.query<{ id: string; name: string }>(
      "SELECT id, name FROM board_snapshots WHERE board_id = $1 AND reason = 'before_restore' ORDER BY created_at",
      [w.boardId],
    )
  ).rows

describe('restore elements from a checkpoint into the live board', () => {
  it('makes a before_restore checkpoint first, sends the copies closed over labels, answers the sync’s result', async () => {
    const snapshotsBefore = sync.snapshots
    const res = await restore({ ids: ['n1', 'n2.t', 'box'] })
    expect(res.statusCode, res.body).toBe(200)
    const out = RestoreElementsResult.parse(res.json())
    const rows = await beforeRestoreRows()
    expect(rows).toHaveLength(1)
    expect(out.checkpointId).toBe(rows[0]?.id)
    expect(rows[0]?.name).toBe('Before restoring “After the workshop”')
    // the checkpoint read the board before the write reached the sync
    expect(sync.calls).toHaveLength(1)
    expect(sync.calls[0]?.snapshotsBefore).toBe(snapshotsBefore + 1)
    const body = sync.calls[0]?.body
    expect(body?.actor).toEqual({ uid: w.bob.userId, name: expect.any(String) })
    expect(body?.ids).toEqual(['n1', 'n2.t', 'box'])
    expect(body?.elements.map((e) => e.id).sort()).toEqual(['box', 'n1', 'n1.t', 'n2', 'n2.t'])
    // as the checkpoint holds them (n1 and the box at their old place)
    expect(body?.elements.find((e) => e.id === 'n1')).toMatchObject({ x: 0, version: 3 })
    expect(body?.removeAbsent).toBeUndefined()
    expect(out.restored.sort()).toEqual(['box', 'n1', 'n1.t', 'n2', 'n2.t'])
  })

  it('"Undo restore" (removeAbsent) passes on, even when the checkpoint holds none of the ids', async () => {
    const first = await restore({ ids: ['n2'] })
    const { checkpointId } = RestoreElementsResult.parse(first.json())
    sync.answers.push({ status: 200, body: { restored: ['n2', 'n2.t'], skipped: [], clock: 12 } })
    const undo = await restore({ ids: ['n2'], removeAbsent: true }, checkpointId)
    expect(undo.statusCode, undo.body).toBe(200)
    expect(sync.calls[1]?.body).toMatchObject({ ids: ['n2'], elements: [], removeAbsent: true })
    expect(undo.json()).toMatchObject({ restored: ['n2', 'n2.t'], clock: 12 })
    // without it, ids the checkpoint lacks are refused before anything happens
    const none = await restore({ ids: ['n2'] }, checkpointId)
    expect(none.statusCode).toBe(400)
    expect(errorCode(none)).toBe('NOT_IN_CHECKPOINT')
    expect(sync.calls).toHaveLength(2)
  })

  it('a board equal to its newest checkpoint keeps that one as the restore point', async () => {
    sync.setBoard(w.boardId, sync.boards.get(w.boardId)?.elements as El[], 9)
    const saved = await w.bob.req('POST', `/api/boards/${w.boardId}/snapshots`, { name: 'Now' })
    expect(saved.statusCode).toBe(201)
    const res = await restore({ ids: ['n1'] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().checkpointId).toBe(saved.json().id)
    expect(await beforeRestoreRows()).toHaveLength(0)
  })

  it('viewers and commenters 403, outsiders 404, an archived board 403: no checkpoint, no sync call', async () => {
    const carol = await api.login('carol')
    for (const role of ['viewer', 'commenter']) {
      const g = await w.bob.req('PUT', `/api/boards/${w.boardId}/members/${carol.userId}`, { role })
      expect(g.statusCode).toBe(200)
      const res = await restore({ ids: ['n1'] }, w.checkpointId, w.boardId, carol)
      expect(res.statusCode, role).toBe(403)
    }
    const dave = await api.login('dave')
    expect((await restore({ ids: ['n1'] }, w.checkpointId, w.boardId, dave)).statusCode).toBe(404)
    expect((await api.anon('POST', restorePath(w.boardId, w.checkpointId), { ids: ['n1'] })).statusCode).toBe(
      401,
    )
    expect((await w.bob.req('POST', `/api/boards/${w.boardId}/archive`)).statusCode).toBe(200)
    expect((await restore({ ids: ['n1'] })).statusCode).toBe(403)
    expect(sync.calls).toHaveLength(0)
    expect(await beforeRestoreRows()).toHaveLength(0)
  })

  it('a name-only guest editor gets 403 GUEST_ACCOUNT_REQUIRED (the refusals row); nothing happens', async () => {
    const link = await guestLink(w.bob, w.boardId, { role: 'editor' })
    const sam = await joinAsGuest(api, link.url, 'Sam')
    const res = await sam.req('POST', restorePath(w.boardId, w.checkpointId), { ids: ['n1'] })
    expect(res.statusCode, res.body).toBe(403)
    expect(errorCode(res)).toBe('GUEST_ACCOUNT_REQUIRED')
    expect(sync.calls).toHaveLength(0)
    expect(await beforeRestoreRows()).toHaveLength(0)
  })

  it('an unknown checkpoint, or one of another board, is 404; bad input 400', async () => {
    expect((await restore({ ids: ['n1'] }, 'snp_0123456789abcdefghij')).statusCode).toBe(404)
    expect((await restore({ ids: ['n1'] }, 'nope')).statusCode).toBe(404)
    const otherId = await createBoard(w.bob, DEV_STUDIO, 'Other')
    expect((await restore({ ids: ['n1'] }, w.checkpointId, otherId)).statusCode).toBe(404)
    expect((await restore({ ids: [] })).statusCode).toBe(400)
    expect((await restore({ ids: ['has space'] })).statusCode).toBe(400)
    expect((await restore({ ids: Array.from({ length: 201 }, (_, i) => `e${i}`) })).statusCode).toBe(400)
    expect(sync.calls).toHaveLength(0)
  })

  it('a sync without the route (404) gives 503 RESTORE_UNAVAILABLE; the element cap 409 ELEMENT_LIMIT', async () => {
    sync.answers.push({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found.' } } })
    const old = await restore({ ids: ['n1'] })
    expect(old.statusCode).toBe(503)
    expect(errorCode(old)).toBe('RESTORE_UNAVAILABLE')
    sync.answers.push({
      status: 409,
      body: { error: { code: 'element-limit', message: 'This board is full.' } },
    })
    const full = await restore({ ids: ['n1'] })
    expect(full.statusCode).toBe(409)
    expect(errorCode(full)).toBe('ELEMENT_LIMIT')
    sync.answers.push({ status: 503, body: { error: { code: 'unavailable', message: 'x' } } })
    expect((await restore({ ids: ['n1'] })).statusCode).toBe(503)
    sync.answers.push({ status: 200, body: { restored: 'no' } })
    expect((await restore({ ids: ['n1'] })).statusCode).toBe(503)
  })

  it('two restores at once: both get their own checkpoint first, and their writes never overlap', async () => {
    await twoRestoresAtOnce(w)
  })
})

describe('a v1 (tldraw) checkpoint', () => {
  it('is converted the way its preview is, and its elements are restored', async () => {
    const fake = createFakeSync() as ReturnType<typeof createFakeSync> & {
      engine?: () => Promise<'excalidraw'>
      restoreElements?: RestoreSync['restoreElements']
    }
    fake.engine = async () => 'excalidraw'
    const calls: { ids: string[]; elements: El[] }[] = []
    fake.restoreElements = async (_b, body) => {
      calls.push({ ids: body.ids, elements: body.elements as El[] })
      return { status: 200, body: { restored: body.elements.map((e) => e.id), skipped: [], clock: 3 } }
    }
    const v1 = await createTestApi({ deps: { syncInternal: fake } })
    try {
      await v1.login('owner')
      const bob = await v1.login('bob')
      const board = await createBoard(bob, DEV_STUDIO, 'Old')
      fake.setBoard(board, [
        { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
        { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
        noteRec('n1', 'Launch plan'),
      ])
      const saved = await bob.req('POST', `/api/boards/${board}/snapshots`, { name: 'Before the switch' })
      expect(saved.statusCode, saved.body).toBe(201)
      fake.setBoard(board, [
        { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
        { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
      ])
      const res = await bob.req('POST', restorePath(board, saved.json().id), { ids: ['n1'] })
      expect(res.statusCode, res.body).toBe(200)
      expect(calls[0]?.ids).toEqual(['n1'])
      const n1 = calls[0]?.elements.find((e) => e.id === 'n1')
      expect(n1).toMatchObject({ type: 'stickynote' })
      expect(calls[0]?.elements.find((e) => e.type === 'text')).toMatchObject({ containerId: 'n1' })
    } finally {
      await v1.close()
    }
  })
})

describe('closeOverLabels', () => {
  it('an asked label brings its container, a container its label; what the checkpoint lacks is left out', () => {
    const els = [
      ...noteWith('a', 'x', 'a1'),
      ...noteWith('b', 'y', 'a2'),
      { id: 'gone', type: 'rectangle', isDeleted: true },
    ]
    expect(closeOverLabels(els, ['a.t']).map((e) => e.id)).toEqual(['a', 'a.t'])
    expect(closeOverLabels(els, ['b']).map((e) => e.id)).toEqual(['b', 'b.t'])
    expect(closeOverLabels(els, ['nope', 'gone'])).toEqual([])
  })
})
