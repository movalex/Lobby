// The R0 stand-in's born-after check (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §5.10, §8.3 B8): a board
// born on the new canvas is refused by the tldraw sync before any writable handle exists, through every
// entry point (room open, every internal board route, the socket), and the file is left byte-identical:
// same tables, same main-file sha256, no WAL frames; no backup of it ever appears. Converted boards are
// served, and serving them never changes a lb_* table.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLRecord } from '@tldraw/tlschema'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { BoardOpenRefused } from '../../src/engine-switch.ts'
import { classifyBoardFile, unregisterBornAfterCheck } from '../../src/r0/index.ts'
import { lbDigests, tableDigest } from '../../src/room/migrate/digest.ts'
import { ensureLbSchema } from '../../src/room/schema.ts'
import { boardDbPath, RoomRegistry } from '../../src/rooms.ts'
import { useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import { callInternal, errorCode, mintTicket } from '../harness/tickets.ts'
import { fileSha256, makeBornAfterFile, seedTldrawBoard, tablesOf, tempDir, walBytes } from './support.ts'

afterAll(() => unregisterBornAfterCheck())

/** Adds the lb_* tables and `converted_from` to a tldraw board file (the shape of a converted board). */
function markConverted(path: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec('BEGIN IMMEDIATE')
    ensureLbSchema(db)
    const meta = db.prepare('INSERT INTO lb_meta (key, value) VALUES (?, ?)')
    meta.run('clock', '1')
    meta.run('epoch', 'e-conv')
    meta.run(
      'converted_from',
      JSON.stringify({
        documentClock: 1,
        schemaHash: 'x',
        sourceSha256: 'y',
        converterVersion: '1',
        backupKey: null,
        deletedSeq: 0,
        lbClock: 1,
        cycle: 0,
      }),
    )
    db.prepare(
      "INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES ('s1', 1, 'a0', 0, 'rectangle', 1, '{}', '{}')",
    ).run()
    db.prepare("INSERT INTO lb_source (id, state) VALUES ('shape:s1', '{}')").run()
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

function lbState(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return { lb: lbDigests(db), deletedSchemas: tableDigest(db, 'dr_deleted_schemas') }
  } finally {
    db.close()
  }
}

describe('classifyBoardFile (read-only)', () => {
  it('tells missing, tldraw, converted and born-after files apart without creating or changing any', () => {
    const dir = tempDir()
    const missing = join(dir, 'board-missing.sqlite')
    expect(classifyBoardFile(missing)).toBe('missing')
    expect(existsSync(missing)).toBe(false)

    const tl = seedTldrawBoard(dir, 'b-tldraw01')
    expect(classifyBoardFile(tl)).toBe('tldraw')

    const conv = seedTldrawBoard(dir, 'b-convert01')
    markConverted(conv)
    expect(classifyBoardFile(conv)).toBe('converted')

    const born = boardDbPath(dir, 'b-bornaft01')
    makeBornAfterFile(born)
    const before = fileSha256(born)
    expect(classifyBoardFile(born)).toBe('born-after')
    expect(fileSha256(born)).toBe(before)
    expect(walBytes(born)).toBe(0)

    // lb_meta with converted_from but no tldraw tables (after drop-legacy): not a tldraw board either
    const dropped = boardDbPath(dir, 'b-dropped01')
    makeBornAfterFile(dropped)
    const db = new DatabaseSync(dropped)
    db.prepare("INSERT INTO lb_meta (key, value) VALUES ('converted_from', '{}')").run()
    db.close()
    expect(classifyBoardFile(dropped)).toBe('converted-without-tldraw')
  })
})

describe('RoomRegistry with the stand-in check', () => {
  it('refuses a born-after board through every entry point and leaves the file byte-identical', () => {
    const dataDir = tempDir()
    const boardId = 'b-bornaft02'
    const path = boardDbPath(dataDir, boardId)
    makeBornAfterFile(path)
    const sha = fileSha256(path)
    const tables = tablesOf(path)
    const backups = join(dataDir, 'backups')
    const reg = new RoomRegistry({
      dataDir,
      schema: draftroomSchema,
      backup: { dir: backups, intervalMs: 60_000 },
    })
    try {
      const attempts: Array<() => unknown> = [
        () => reg.getOrCreate(boardId),
        () => reg.snapshot(boardId),
        () => reg.listDeleted(boardId),
        () =>
          reg.scanRecords(
            boardId,
            () => {},
            () => {},
          ),
        () => reg.restoreDeleted(boardId, ['shape:x']),
        () =>
          reg.seed(boardId, {
            documentClock: 0,
            tombstoneHistoryStartsAtClock: 0,
            tombstones: {},
            schema: draftroomSchema.serialize(),
            documents: [],
          }),
      ]
      for (const attempt of attempts) expect(attempt).toThrow(BoardOpenRefused)
      expect(reg.openBoards()).toEqual([])
      expect(reg.has(boardId)).toBe(false)
    } finally {
      reg.closeAll()
    }
    // the periodic backup visits open rooms only; a refused file never became one
    return reg.runBackupPass().then(() => {
      expect(existsSync(join(backups, boardId))).toBe(false)
      expect(tablesOf(path)).toEqual(tables)
      expect(
        tablesOf(path).some((t) => t === 'documents' || t === 'metadata' || t.startsWith('dr_deleted')),
      ).toBe(false)
      expect(fileSha256(path)).toBe(sha)
      expect(walBytes(path)).toBe(0)
    })
  })

  it('serves a converted board and never writes any lb_* table while serving, backing up and closing it', async () => {
    const dataDir = tempDir()
    const boardId = 'b-convert02'
    const path = seedTldrawBoard(dataDir, boardId, [geoShape('s1') as unknown as TLRecord])
    markConverted(path)
    const before = lbState(path)
    const backups = join(dataDir, 'backups')
    const reg = new RoomRegistry({
      dataDir,
      schema: draftroomSchema,
      backup: { dir: backups, intervalMs: 60_000 },
    })
    try {
      const room = reg.getOrCreate(boardId)
      const s2 = geoShape('s2') as unknown as TLRecord
      room.storage.transaction((txn) => {
        txn.set(s2.id, s2)
        txn.delete('shape:s1' as TLRecord['id'])
      })
      await reg.backupNow(boardId)
    } finally {
      reg.closeAll()
    }
    expect(readdirSync(join(backups, boardId)).some((f) => f.endsWith('.sqlite'))).toBe(true)
    const after = lbState(path)
    expect(after.lb).toEqual(before.lb)
    expect(Object.keys(after.lb).sort()).toEqual([
      'lb_deleted',
      'lb_doc',
      'lb_elements',
      'lb_meta',
      'lb_source',
    ])
  })
})

describe('the stand-in as a real process (DRAFTROOM_ENGINE unset)', () => {
  const h = useProtocolHarness()

  it('closes a socket to a born-after board with 4099 NEW_CANVAS_BOARD and answers every internal route 409 new-canvas', async () => {
    const dataDir = h.dataDir()
    const boardId = 'b-bornaft03'
    const rooms = join(dataDir, 'rooms')
    const path = boardDbPath(rooms, boardId)
    // the server creates rooms/ itself; the file must exist before it starts
    mkdirSync(rooms, { recursive: true })
    makeBornAfterFile(path)
    const sha = fileSha256(path)
    const tables = tablesOf(path)
    const server = await h.server({ dataDir })

    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(
        `${server.wsUrl}/connect/${boardId}?sessionId=s1&ticket=${encodeURIComponent(mintTicket(boardId, 'usr_alice'))}`,
      )
      ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
      ws.on('error', reject)
    })
    expect(closed).toEqual({ code: 4099, reason: 'NEW_CANVAS_BOARD' })

    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/internal/boards/${boardId}/snapshot`],
      ['GET', `/internal/boards/${boardId}/text`],
      ['GET', `/internal/boards/${boardId}/asset-refs`],
      ['GET', `/internal/boards/${boardId}/deleted`],
      ['POST', `/internal/boards/${boardId}/deleted/restore`, { ids: ['shape:x'] }],
      [
        'POST',
        `/internal/boards/${boardId}/seed`,
        { snapshot: { schema: draftroomSchema.serialize(), documents: [] } },
      ],
      [
        'POST',
        `/internal/boards/${boardId}/place-notes`,
        {
          sessionId: 'pbs_0000000000',
          anonymous: true,
          frame: { id: 'shape:f', pageId: 'page:page', x: 0, y: 0, w: 400, h: 300, name: 'Ideas' },
          notes: [{ id: 'pnt_0000000000', text: 'n', color: 'yellow', authorId: null }],
          authors: [],
        },
      ],
    ]
    for (const [method, route, body] of routes) {
      const res = await callInternal(server.url, method, route, body === undefined ? {} : { body })
      expect({ route, status: res.status }).toEqual({ route, status: 409 })
      expect(await errorCode(res)).toBe('new-canvas')
    }
    await server.kill('SIGINT')
    expect(tablesOf(path)).toEqual(tables)
    expect(fileSha256(path)).toBe(sha)
    expect(walBytes(path)).toBe(0)
    expect(existsSync(join(dataDir, 'backups', boardId))).toBe(false)
  })
})
