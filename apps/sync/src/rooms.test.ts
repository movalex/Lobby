import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { draftroomSchema, FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { createShapeId, type TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { BOARD_ID_RE, boardDbPath, RoomRegistry } from './rooms.ts'

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

  it('schema validation is the gate for server-side writes', () => {
    const bad = {
      ...card('c'),
      props: { ...(card('c') as any).props, posterDerivativeId: 'https://signed.example/x' },
    }
    expect(() => draftroomSchema.types.shape.validate(bad)).toThrow()
  })
})
