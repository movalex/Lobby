// "Recently deleted" (REV-07) against a real RoomRegistry/TLSocketRoom: what a committed delete
// captures, what it never captures (vetoed, read-only, rolled-back pushes, ungroups, lone bindings),
// the bound, and restore (same place and parent, content, connectors, missing parents, validation).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLBinding, TLRecord, TLShape } from '@tldraw/tlschema'
import { toRichText } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELETED_TABLES } from '../../src/deleted/store.ts'
import { boardDbPath, type RegistryOpts, type Room, RoomRegistry } from '../../src/rooms.ts'
import { fileCardV0, fileCardV0Schema } from '../harness/records.ts'
import {
  arrow,
  arrowBinding,
  frame,
  geo,
  group,
  indexFor,
  note,
  PAGE,
  RoomClient,
  until,
} from './fixtures.ts'

const BOARD = 'deleted-board'
let dataDir: string
let registries: RoomRegistry[] = []

function registry(over: Partial<RegistryOpts> = {}) {
  const r = new RoomRegistry({
    dataDir,
    schema: draftroomSchema,
    idleEvictMs: 60_000,
    textLeaseMs: 60_000,
    ...over,
  })
  registries.push(r)
  return r
}
async function client(room: Room, user: string, opts: { readonly?: boolean; name?: string } = {}) {
  const c = new RoomClient(room, user, opts)
  await c.connect()
  return c
}
const rec = <T extends TLRecord>(room: Room, id: string) => room.getRecord(id) as T | undefined
/** Rows in our side table, read over a second connection (proves the rows were COMMITTED). */
function committedRows(): { kind: string; record_id: string }[] {
  const db = new DatabaseSync(boardDbPath(dataDir, BOARD), { readOnly: true })
  try {
    return db.prepare('SELECT kind, record_id FROM dr_deleted_records ORDER BY seq').all() as {
      kind: string
      record_id: string
    }[]
  } finally {
    db.close()
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dr-deleted-'))
})
afterEach(() => {
  for (const r of registries) r.closeAll()
  registries = []
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('capture on delete', () => {
  it('lists a committed delete with its type, label, time and who deleted it', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const alice = await client(room, 'usr_alice', { name: 'Alice' })
    expect(await alice.put(note('n1', 'Buy milk'))).toBe('commit')
    const before = Date.now()
    expect(await alice.remove('shape:n1')).toBe('commit')

    const { entries, total } = reg.listDeleted(BOARD)
    expect(total).toBe(1)
    expect(entries).toEqual([
      {
        shapeId: 'shape:n1',
        type: 'note',
        label: 'Buy milk',
        deletedAt: expect.any(String),
        deletedBy: { id: 'usr_alice', name: 'Alice' },
        childCount: 0,
      },
    ])
    expect(Date.parse(entries[0]?.deletedAt ?? '')).toBeGreaterThanOrEqual(before - 1000)
    // committed in the board's own database, in our table only
    expect(committedRows()).toEqual([{ kind: 'shape', record_id: 'shape:n1' }])
  })

  it('never writes into tldraw tables: only our two side tables are added to the board database', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    await a.put(note('n1', 'x'))
    await a.remove('shape:n1')
    const db = new DatabaseSync(boardDbPath(dataDir, BOARD), { readOnly: true })
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((t) => t.name)
    db.close()
    expect(tables.filter((t) => t.startsWith('dr_'))).toEqual([...DELETED_TABLES].sort())
    expect(tables.filter((t) => !t.startsWith('dr_') && t !== 'sqlite_sequence').sort()).toEqual(
      ['documents', 'metadata', 'objects', 'tombstones'].sort(),
    )
  })

  it('does not capture a delete the text lease vetoed', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const alice = await client(room, 'usr_alice')
    const bob = await client(room, 'usr_bob')
    const n = note('n1', 'draft')
    await alice.put(n)
    // alice takes the lease by editing the text
    await alice.push({
      [n.id]: [
        'patch',
        {
          props: [
            'patch',
            { richText: ['put', toRichText('alice typing')], textLastEditedBy: ['put', 'usr_alice'] },
          ],
        },
      ],
    })
    expect(await bob.remove(n.id)).toBe('discard')
    expect(rec(room, n.id)).toBeDefined()
    expect(reg.listDeleted(BOARD).total).toBe(0)
    expect(committedRows()).toEqual([])
  })

  it('does not capture anything for read-only sessions (their deletes never commit)', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const editor = await client(room, 'usr_ed')
    const viewer = await client(room, 'usr_view', { readonly: true })
    await editor.put(note('n1', 'keep me'))
    expect(await viewer.remove('shape:n1')).toBe('discard')
    expect(rec(room, 'shape:n1')).toBeDefined()
    expect(committedRows()).toEqual([])
  })

  it('captures nothing when the push that deleted is rolled back (same transaction semantics)', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    await a.put(note('n1', 'still here'))
    const bad = { ...note('n2', 'bad'), props: { ...note('n2', 'bad').props, color: 'not-a-color' } }
    // one push: an allowed delete plus an invalid record -> the whole push rolls back
    const result = await a.push({ 'shape:n1': ['remove'], 'shape:n2': ['put', bad] })
    expect(result).toBe('closed')
    expect(rec(room, 'shape:n1')).toBeDefined()
    expect(committedRows()).toEqual([])
    // and nothing is left pending for the next push
    const b = await client(room, 'usr_b')
    await b.put(note('n3', 'other'))
    await b.remove('shape:n3')
    expect(committedRows()).toEqual([{ kind: 'shape', record_id: 'shape:n3' }])
  })

  it('keeps connector bindings deleted with a shape, not a connector end dragged off on its own', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    const A = geo('A')
    const B = geo('B', { x: 400, index: 'a2' as TLShape['index'] })
    const ar = arrow('ar', { index: 'a3' as TLShape['index'] })
    await a.put(A, B, ar, arrowBinding('s', ar.id, A.id, 'start'), arrowBinding('e', ar.id, B.id, 'end'))
    await a.remove('binding:s') // dragged the start off A
    expect(committedRows()).toEqual([])
    // deleting B: tldraw deletes the binding to it and moves the arrow end, all in one push
    await a.push({
      [B.id]: ['remove'],
      'binding:e': ['remove'],
      [ar.id]: ['patch', { props: ['patch', { end: ['put', { x: 400, y: 50 }] }] }],
    })
    expect(committedRows()).toEqual([
      { kind: 'shape', record_id: B.id },
      { kind: 'binding', record_id: 'binding:e' },
    ])
  })

  it('does not list a group deleted without its content (ungroup)', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    const g = group('g')
    const n1 = note('n1', 'one', { parentId: g.id })
    await a.put(g, n1)
    await a.push({ [n1.id]: ['patch', { parentId: ['put', PAGE] }], [g.id]: ['remove'] })
    expect(committedRows()).toEqual([])
    expect(reg.listDeleted(BOARD).total).toBe(0)
  })

  it('survives a restart of the sync server (the rows live in the board database)', async () => {
    const reg = registry()
    const a = await client(reg.getOrCreate(BOARD), 'usr_a')
    await a.put(note('n1', 'persisted'))
    await a.remove('shape:n1')
    reg.closeAll()
    const again = registry()
    expect(again.listDeleted(BOARD).entries.map((e) => e.shapeId)).toEqual(['shape:n1'])
  })
})

describe('bound: the last 1,000 deleted shapes plus everything from the current session', () => {
  it('trims older sessions to the most recent 1,000, never the current session', async () => {
    const first = registry()
    const a = await client(first.getOrCreate(BOARD), 'usr_a')
    const ids = Array.from({ length: 1_200 }, (_, i) => `shape:m${i}`)
    for (let chunk = 0; chunk < 12; chunk++) {
      const part = ids.slice(chunk * 100, chunk * 100 + 100)
      await a.put(...part.map((id, i) => note(id, `n ${id}`, { index: indexFor(i) })))
      await a.remove(...part)
    }
    // all 1,200 were deleted in this (still open) room session: nothing is dropped yet
    expect(first.listDeleted(BOARD).total).toBe(1_200)
    first.closeAll()

    // a new session: its first delete trims the older session down to the newest 1,000 shapes
    const second = registry()
    const b = await client(second.getOrCreate(BOARD), 'usr_b')
    await b.put(note('fresh', 'fresh'))
    await b.remove('shape:fresh')
    const list = second.listDeleted(BOARD)
    // the newest 1,000 (fresh + m1199..m201), rounded up to whole deletions: m200..m299 were one push
    expect(list.total).toBe(1_001)
    expect(list.entries[0]?.shapeId).toBe('shape:fresh')
    const kept = new Set(list.entries.map((e) => e.shapeId))
    expect(kept.has('shape:m1199')).toBe(true)
    expect(kept.has('shape:m201')).toBe(true)
    expect(kept.has('shape:m200')).toBe(true)
    expect(kept.has('shape:m199')).toBe(false)
    expect(kept.has('shape:m0')).toBe(false)
  })

  it('caps the current session too (hard cap) and a single mass delete (per push)', async () => {
    const reg = registry({ deleted: { retainRecent: 5, hardCap: 20, perPush: 12, trimEvery: 1 } })
    const a = await client(reg.getOrCreate(BOARD), 'usr_a')
    const ids = Array.from({ length: 40 }, (_, i) => `shape:k${i}`)
    await a.put(...ids.map((id, i) => note(id, id, { index: indexFor(i) })))
    await a.remove(...ids.slice(0, 15)) // one push of 15: only 12 captured
    expect(reg.listDeleted(BOARD).total).toBe(12)
    // 25 single deletes in the same session: the hard cap (whole deletions) drops the mass delete
    for (const id of ids.slice(15)) await a.remove(id)
    const list = reg.listDeleted(BOARD)
    expect(list.total).toBe(20)
    expect(list.entries[0]?.shapeId).toBe('shape:k39')
    expect(list.entries.some((e) => e.shapeId === 'shape:k0')).toBe(false)
  })
})

describe('restore', () => {
  it('puts a frame and its content back in place and parent, reaching connected clients', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    const watcher = await client(room, 'usr_w')
    const f = frame('f', 'Ideas', { x: 100, y: 50 })
    const n1 = note('n1', 'inside', { parentId: f.id, x: 20, y: 30 })
    const n2 = note('n2', 'also inside', { parentId: f.id, x: 220, y: 30, index: 'a2' as TLShape['index'] })
    await a.put(f, n1, n2)
    await a.remove(f.id, n1.id, n2.id)
    const { entries } = reg.listDeleted(BOARD)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ shapeId: f.id, type: 'frame', label: 'Ideas', childCount: 2 })

    const seen = watcher.events.length
    const result = reg.restoreDeleted(BOARD, [f.id])
    expect(result).toEqual({ restored: [f.id, n1.id, n2.id], skipped: [], bindings: 0, reparented: 0 })
    expect(rec(room, f.id)).toEqual(f)
    expect(rec(room, n1.id)).toEqual(n1)
    expect(rec(room, n2.id)).toEqual(n2)
    await until(() =>
      watcher.events.slice(seen).some((e) => e.type === 'patch' && JSON.stringify(e).includes('"shape:n2"')),
    )
    expect(reg.listDeleted(BOARD).total).toBe(0) // gone from the list
  })

  it('reconnects connectors whose two ends both exist, and only those', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    const A = geo('A')
    const B = geo('B', { x: 400, index: 'a2' as TLShape['index'] })
    const ar = arrow('ar', { index: 'a3' as TLShape['index'] })
    const bs = arrowBinding('s', ar.id, A.id, 'start')
    const be = arrowBinding('e', ar.id, B.id, 'end')
    await a.put(A, B, ar, bs, be)
    await a.push({ [B.id]: ['remove'], [be.id]: ['remove'] })
    expect(reg.restoreDeleted(BOARD, [B.id])).toMatchObject({ restored: [B.id], bindings: 1 })
    expect(rec<TLBinding>(room, be.id)).toEqual(be)

    // the arrow deleted with both its bindings comes back connected at both ends
    await a.push({ [ar.id]: ['remove'], [bs.id]: ['remove'], [be.id]: ['remove'] })
    expect(reg.restoreDeleted(BOARD, [ar.id])).toMatchObject({ restored: [ar.id], bindings: 2 })
    expect(rec(room, bs.id)).toEqual(bs)
    expect(rec(room, be.id)).toEqual(be)

    // B deleted, then the arrow: restoring B alone cannot reconnect (the arrow is gone)
    await a.push({ [B.id]: ['remove'], [be.id]: ['remove'] })
    await a.push({ [ar.id]: ['remove'], [bs.id]: ['remove'] })
    expect(reg.restoreDeleted(BOARD, [B.id])).toMatchObject({ restored: [B.id], bindings: 0 })
    expect(rec(room, be.id)).toBeUndefined()
    // now the arrow: both ends exist again, both bindings come back
    expect(reg.restoreDeleted(BOARD, [ar.id])).toMatchObject({ restored: [ar.id], bindings: 2 })
  })

  it('does not reconnect an end that was connected to something else meanwhile', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    const A = geo('A')
    const B = geo('B', { x: 400, index: 'a2' as TLShape['index'] })
    const C = geo('C', { x: 800, index: 'a4' as TLShape['index'] })
    const ar = arrow('ar', { index: 'a3' as TLShape['index'] })
    const be = arrowBinding('e', ar.id, B.id, 'end')
    await a.put(A, B, C, ar, be)
    await a.push({ [B.id]: ['remove'], [be.id]: ['remove'] })
    await a.put(arrowBinding('e2', ar.id, C.id, 'end'))
    expect(reg.restoreDeleted(BOARD, [B.id])).toMatchObject({ restored: [B.id], bindings: 0 })
    expect(rec(room, be.id)).toBeUndefined()
  })

  it('re-parents to the page at the same page position when the parent is gone', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    const f = frame('f', 'Turned', { x: 100, y: 200, rotation: Math.PI / 2 })
    const n1 = note('n1', 'child', { parentId: f.id, x: 10, y: 0 })
    await a.put(f, n1)
    await a.remove(n1.id, f.id)
    // restore only the child: its frame stays deleted
    const result = reg.restoreDeleted(BOARD, [n1.id])
    expect(result).toMatchObject({ restored: [n1.id], reparented: 1, skipped: [] })
    const back = rec<TLShape>(room, n1.id)
    expect(back?.parentId).toBe(PAGE)
    expect(back?.x).toBeCloseTo(100)
    expect(back?.y).toBeCloseTo(210)
    expect(back?.rotation).toBeCloseTo(Math.PI / 2)
    // the frame is still listed and restores on its own
    expect(reg.listDeleted(BOARD).entries.map((e) => e.shapeId)).toEqual([f.id])
  })

  it('gives a restored shape a free index when a newer sibling took its place', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    await a.put(
      note('n1', 'one', { index: 'a1' as TLShape['index'] }),
      note('n2', 'two', { index: 'a2' as TLShape['index'] }),
    )
    await a.remove('shape:n2')
    await a.put(note('n3', 'three', { index: 'a2' as TLShape['index'] })) // tldraw reuses the top index
    reg.restoreDeleted(BOARD, ['shape:n2'])
    const n2 = rec<TLShape>(room, 'shape:n2')
    expect(n2?.index).not.toBe('a2')
    expect((n2?.index ?? '') > 'a2').toBe(true)
    expect(() => draftroomSchema.types.shape.validate(n2)).not.toThrow()
  })

  it('never overwrites a shape that is back already (undo) and does not list it', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    const n = note('n1', 'original')
    await a.put(n)
    await a.remove(n.id)
    await a.put({ ...n, x: 999 } as TLShape) // undo re-creates it (and it was moved since)
    expect(reg.listDeleted(BOARD).total).toBe(0)
    expect(reg.restoreDeleted(BOARD, [n.id])).toEqual({
      restored: [],
      skipped: [{ id: n.id, reason: 'exists' }],
      bindings: 0,
      reparented: 0,
    })
    expect(rec<TLShape>(room, n.id)?.x).toBe(999)
  })

  it('answers not-found for ids it never captured', () => {
    const reg = registry()
    reg.getOrCreate(BOARD)
    expect(reg.restoreDeleted(BOARD, ['shape:nope']).skipped).toEqual([
      { id: 'shape:nope', reason: 'not-found' },
    ])
    expect(reg.restoreDeleted('no-such-board', ['shape:nope']).skipped).toEqual([
      { id: 'shape:nope', reason: 'not-found' },
    ])
  })

  it('validates with the board schema before writing: a bad captured record is skipped, the board untouched', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    await a.put(note('n1', 'fine'))
    await a.remove('shape:n1')
    // tamper with the stored record over a second connection (a bug, a bad migration, disk rot)
    const db = new DatabaseSync(boardDbPath(dataDir, BOARD))
    const row = db.prepare("SELECT state FROM dr_deleted_records WHERE record_id = 'shape:n1'").get() as {
      state: string
    }
    const bad = JSON.parse(row.state)
    bad.props.color = 'ultraviolet'
    db.prepare("UPDATE dr_deleted_records SET state = ? WHERE record_id = 'shape:n1'").run(
      JSON.stringify(bad),
    )
    db.close()
    const clockBefore = room.getCurrentDocumentClock()
    expect(reg.restoreDeleted(BOARD, ['shape:n1'])).toEqual({
      restored: [],
      skipped: [{ id: 'shape:n1', reason: 'invalid' }],
      bindings: 0,
      reparented: 0,
    })
    expect(rec(room, 'shape:n1')).toBeUndefined()
    expect(room.getCurrentDocumentClock()).toBe(clockBefore)
    // the room still opens after a restart (nothing invalid was written)
    reg.closeAll()
    expect(() => registry().snapshot(BOARD)).not.toThrow()
  })

  it('migrates records captured under an older schema before validating them', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    await client(room, 'usr_a')
    // a row captured by an older server: a v0 file card (no posterDerivativeId) in the v0 schema
    const db = new DatabaseSync(boardDbPath(dataDir, BOARD))
    db.prepare('INSERT INTO dr_deleted_schemas (schema) VALUES (?)').run(
      JSON.stringify(fileCardV0Schema.serialize()),
    )
    const schemaId = (db.prepare('SELECT max(id) AS id FROM dr_deleted_schemas').get() as { id: number }).id
    const old = fileCardV0('fc')
    db.prepare(
      `INSERT INTO dr_deleted_records (batch, kind, record_id, shape_type, parent_id, state, schema_id, deleted_by, deleted_by_name, deleted_at, epoch)
       VALUES (1, 'shape', ?, 'dr-file-card', ?, ?, ?, 'usr_old', 'Old', ?, 'old-session')`,
    ).run(old.id, PAGE, JSON.stringify(old), schemaId, Date.now())
    db.close()
    expect(reg.restoreDeleted(BOARD, [old.id])).toMatchObject({ restored: [old.id], skipped: [] })
    const back = rec<TLShape>(room, old.id)
    expect(back).toBeDefined()
    expect((back?.props as { posterDerivativeId?: unknown } | undefined)?.posterDerivativeId).toBeNull()
  })

  it('a restore is one transaction with the list: restored rows leave, the rest stay', async () => {
    const reg = registry()
    const room = reg.getOrCreate(BOARD)
    const a = await client(room, 'usr_a')
    await a.put(note('n1', 'one'), note('n2', 'two', { index: 'a2' as TLShape['index'] }))
    await a.remove('shape:n1')
    await a.remove('shape:n2')
    expect(reg.listDeleted(BOARD).entries.map((e) => e.shapeId)).toEqual(['shape:n2', 'shape:n1'])
    reg.restoreDeleted(BOARD, ['shape:n1'])
    expect(reg.listDeleted(BOARD).entries.map((e) => e.shapeId)).toEqual(['shape:n2'])
    expect(committedRows()).toEqual([{ kind: 'shape', record_id: 'shape:n2' }])
  })
})
