import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { draftroomSchema, FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { createShapeId, type TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { fileCardFutureSchema } from '../test/harness/records.ts'
import { BOARD_ID_RE, boardDbPath, RoomRegistry } from './rooms.ts'
import { emptyBoardSnapshot } from './snapshot.ts'

const card = (n: string) =>
  ({
    id: createShapeId(n),
    typeName: 'shape',
    type: FILE_CARD_TYPE,
    x: 1,
    y: 2,
    rotation: 0,
    index: 'a1',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 240,
      h: 160,
      assetId: 'ast_0123456789',
      versionId: 'ver_0123456789',
      kind: 'image',
      name: 'x.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      status: 'ready',
      pageCount: null,
      durationMs: null,
      posterDerivativeId: null,
    },
  }) as unknown as TLRecord

describe('board ids', () => {
  it('rejects uppercase, traversal and short ids; device names are safe via the file prefix', () => {
    for (const bad of ['Board1', '../x', 'a/b', 'ab', '', 'x'.repeat(65), 'a%2Fb'])
      expect(BOARD_ID_RE.test(bad)).toBe(false)
    expect(boardDbPath('/d', 'con')).toMatch(/board-con\.sqlite$/)
  })
})

describe('RoomRegistry on node:sqlite', () => {
  it('persists a validated server-side write + clock across close/reopen, and survives close right after a delete', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-rooms-'))
    const r1 = new RoomRegistry({ dataDir, schema: draftroomSchema, idleEvictMs: 50 })
    const room = r1.getOrCreate('board-one')
    expect(r1.getOrCreate('board-one')).toBe(room) // one room object per board
    const a = card('a')
    const b = card('b')
    draftroomSchema.types.shape.validate(a) // txn.set does NOT validate; do it yourself
    room.storage.transaction((txn) => {
      txn.set(a.id, a)
      txn.set(b.id, b)
    })
    room.storage.transaction((txn) => {
      txn.delete(b.id) // schedules the 1 s trailing tombstone prune
    })
    const clock = room.getCurrentDocumentClock()
    r1.closeAll() // flushes the prune before db.close()
    await new Promise((r) => setTimeout(r, 1300)) // an unflushed prune would throw here (uncaught)

    const r2 = new RoomRegistry({ dataDir, schema: draftroomSchema })
    const again = r2.getOrCreate('board-one')
    expect(again.getCurrentDocumentClock()).toBe(clock)
    expect(again.getRecord(a.id)).toMatchObject({ x: 1, y: 2 })
    expect(again.getRecord(b.id)).toBeUndefined()
    expect(again.getCurrentSnapshot().tombstones).toHaveProperty(b.id)
    r2.closeAll()
  })

  it('rejects an uppercase board id without creating a database file', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-rooms-'))
    const r = new RoomRegistry({ dataDir, schema: draftroomSchema })
    // 'Board-One' and 'board-one' would be ONE file on NTFS/APFS but two TLSocketRooms
    expect(() => r.getOrCreate('Board-One')).toThrow(/invalid board id/)
    expect(() => boardDbPath(dataDir, 'BOARD-ONE')).toThrow(/invalid board id/)
    expect(readdirSync(dataDir)).toEqual([])
    expect(r.has('Board-One')).toBe(false)
    r.getOrCreate('board-one')
    expect(readdirSync(dataDir)).toContain('board-board-one.sqlite')
    r.closeAll()
  })

  it('evicts an idle room after its last session leaves and reopens it with the data intact', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-rooms-'))
    const r = new RoomRegistry({ dataDir, schema: draftroomSchema, idleEvictMs: 50 })
    const room = r.getOrCreate('board-evict')
    const a = card('keep')
    draftroomSchema.types.shape.validate(a)
    room.storage.transaction((txn) => void txn.set(a.id, a))
    const clock = room.getCurrentDocumentClock()
    room.handleSocketConnect({
      sessionId: 'u1:tab',
      meta: { userId: 'u1', role: 'editor', name: 'u1' },
      socket: { send() {}, close() {}, readyState: 1 },
    })
    room.closeSession('u1:tab') // removal is synchronous -> onSessionRemoved(0) -> evict timer
    const until = Date.now() + 5_000
    while (r.has('board-evict') && Date.now() < until) await new Promise((res) => setTimeout(res, 10))
    expect(r.has('board-evict')).toBe(false)
    expect(room.isClosed()).toBe(true)

    const reopened = r.getOrCreate('board-evict')
    expect(reopened).not.toBe(room)
    expect(reopened.getCurrentDocumentClock()).toBe(clock)
    expect(reopened.getRecord(a.id)).toMatchObject({ x: 1, y: 2 })
    r.closeAll()
  })

  it('closing or evicting a room within 1 s of a delete does not crash the process', () => {
    // 5.4.2 schedules a trailing tombstone prune 1 s after any delete; if it runs after db.close()
    // it throws from a timer and kills the process. Only a separate process can observe that.
    const roomsModule = new URL('./rooms.ts', import.meta.url).href
    const script = `
      import { draftroomSchema } from '@draftroom/canvas-schema'
      import { mkdtempSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      const { RoomRegistry } = await import(${JSON.stringify(roomsModule)})
      const rec = JSON.parse(process.env.DR_REC)
      const r = new RoomRegistry({ dataDir: mkdtempSync(join(tmpdir(), 'dr-prune-')), schema: draftroomSchema, idleEvictMs: 0 })
      const a = r.getOrCreate('prune-close')
      a.storage.transaction((t) => { t.set(rec.id, rec) })
      a.storage.transaction((t) => { t.delete(rec.id) })
      r.closeAll()
      const b = r.getOrCreate('prune-evict')
      b.storage.transaction((t) => { t.set(rec.id, rec) })
      b.handleSocketConnect({ sessionId: 's', meta: { userId: 'u', role: 'editor', name: 'u' }, socket: { send() {}, close() {}, readyState: 1 } })
      b.storage.transaction((t) => { t.delete(rec.id) })
      b.closeSession('s')
      setTimeout(() => { if (r.has('prune-evict')) { console.error('not evicted'); process.exit(3) } }, 300)
      setTimeout(() => { console.log('survived'); process.exit(0) }, 1800)
    `
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), // resolve packages the way apps/sync does
      env: { ...process.env, DR_REC: JSON.stringify(card('prune')) },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(res.stderr).not.toMatch(/finalized|ERR_INVALID_STATE/)
    expect(res.stdout).toContain('survived')
    expect(res.status).toBe(0)
  })

  it('schema validation is the gate for server-side writes', () => {
    const bad = {
      ...card('c'),
      props: {
        ...(card('c') as unknown as { props: object }).props,
        posterDerivativeId: 'https://signed.example/x',
      },
    }
    expect(() => draftroomSchema.types.shape.validate(bad)).toThrow()
  })
})

/** A current-schema RoomSnapshot for a new board holding `records` (what prepareSeedSnapshot produces). */
function seedOf(...records: TLRecord[]) {
  const base = emptyBoardSnapshot(draftroomSchema)
  return {
    ...base,
    documents: [...base.documents, ...records.map((state) => ({ state, lastChangedClock: 0 }))],
  }
}

const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('RoomRegistry.seed / snapshot', () => {
  it('seeds a new board once; a second seed is refused and changes nothing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-seed-'))
    const r = new RoomRegistry({ dataDir, schema: draftroomSchema })
    expect(r.seed('board-new', seedOf(card('a')))).toBe('created')
    expect(r.getOrCreate('board-new').getRecord(card('a').id)).toMatchObject({ x: 1 })
    expect(r.seed('board-new', seedOf(card('b')))).toBe('exists') // room open
    const room = r.getOrCreate('board-new')
    expect(room.getRecord(card('a').id)).toBeDefined()
    expect(room.getRecord(card('b').id)).toBeUndefined()
    r.closeAll()
  })

  it('refuses to seed a board that a connect already initialized, open or not, and never wipes it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-seed-'))
    const r1 = new RoomRegistry({ dataDir, schema: draftroomSchema })
    const room = r1.getOrCreate('board-used') // what a first connect does: default document + page
    const a = card('kept')
    room.storage.transaction((txn) => void txn.set(a.id, a))
    expect(r1.seed('board-used', seedOf(card('seeded')))).toBe('exists') // while open
    r1.closeAll()

    // closed, in a fresh registry (a restarted process): the initialized DB file alone refuses it
    const r2 = new RoomRegistry({ dataDir, schema: draftroomSchema })
    expect(r2.seed('board-used', seedOf(card('seeded')))).toBe('exists')
    expect(r2.has('board-used')).toBe(false) // the refusal did not leave a room open
    const reopened = r2.getOrCreate('board-used')
    expect(reopened.getRecord(a.id)).toMatchObject({ x: 1, y: 2 })
    expect(reopened.getRecord(card('seeded').id)).toBeUndefined()
    r2.closeAll()
  })

  it('a seed that the room cannot open is rolled back completely (the board can be seeded again)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-seed-'))
    const r = new RoomRegistry({ dataDir, schema: draftroomSchema })
    // bypassing prepareSeedSnapshot on purpose: a schema newer than the server makes the room throw
    const future = { ...seedOf(card('a')), schema: fileCardFutureSchema.serialize() }
    expect(() => r.seed('board-bad', future)).toThrow()
    expect(existsSync(boardDbPath(dataDir, 'board-bad'))).toBe(false)
    expect(r.has('board-bad')).toBe(false)
    expect(r.seed('board-bad', seedOf(card('a')))).toBe('created')
    r.closeAll()
  })

  it('snapshot() creates nothing for an unknown board, and a room it (or a seed) opens is evicted again', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-seed-'))
    const r = new RoomRegistry({ dataDir, schema: draftroomSchema, idleEvictMs: 50 })
    expect(r.snapshot('board-none')).toBeNull()
    expect(readdirSync(dataDir)).toEqual([])

    expect(r.seed('board-s', seedOf(card('a')))).toBe('created')
    await until(() => !r.has('board-s')) // nobody joined: evicted
    const snap = r.snapshot('board-s') // opens it again to read
    expect(snap?.documents.map((d) => d.state.id)).toContain(card('a').id)
    expect(r.has('board-s')).toBe(true)
    await until(() => !r.has('board-s'))
    r.closeAll()
  })
})
