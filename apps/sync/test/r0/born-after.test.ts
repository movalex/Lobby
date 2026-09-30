// Bridge release R0 gate (docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §5.10): a board born on the new
// canvas is refused before any room opens, through every entry point (room open, every internal board
// route, the socket), and the file is left byte-identical: same tables (no documents, metadata or
// dr_deleted_* appear), same main-file sha256, no WAL frames, no backup of it. Converted boards and
// tldraw boards are served as before.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { classifyBoardFile } from '../../src/r0/born-after.ts'
import { BoardOpenRefused, registerPreOpenCheck, runPreOpenChecks } from '../../src/r0/pre-open.ts'
import { boardDbPath, RoomRegistry } from '../../src/rooms.ts'
import { useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import { callInternal, errorCode, mintTicket } from '../harness/tickets.ts'
import {
  fileSha256,
  makeBornAfterFile,
  markConverted,
  seedTldrawBoard,
  tablesOf,
  tempDir,
  walBytes,
} from './support.ts'

const TLDRAW_TABLES = (t: string) => t === 'documents' || t === 'metadata' || t.startsWith('dr_deleted')

describe('classifyBoardFile (read-only)', () => {
  it('tells missing, tldraw, converted and born-after files apart without creating or changing any', () => {
    const dir = tempDir()
    const missing = join(dir, 'board-missing.sqlite')
    expect(classifyBoardFile(missing)).toBe('missing')
    expect(existsSync(missing)).toBe(false)

    expect(classifyBoardFile(seedTldrawBoard(dir, 'b-tldraw01'))).toBe('tldraw')

    const conv = seedTldrawBoard(dir, 'b-convert01')
    markConverted(conv)
    const convSha = fileSha256(conv)
    expect(classifyBoardFile(conv)).toBe('converted')
    expect(fileSha256(conv)).toBe(convSha)

    const born = boardDbPath(dir, 'b-bornaft01')
    makeBornAfterFile(born)
    const bornSha = fileSha256(born)
    expect(classifyBoardFile(born)).toBe('born-after')
    expect(fileSha256(born)).toBe(bornSha)
    expect(walBytes(born)).toBe(0)

    // lb_* tables without lb_meta at all: not a tldraw board either
    const noMeta = boardDbPath(dir, 'b-nometa01')
    makeBornAfterFile(noMeta, { withMeta: false })
    expect(classifyBoardFile(noMeta)).toBe('born-after')

    // converted_from but no tldraw tables (after drop-legacy)
    const dropped = boardDbPath(dir, 'b-dropped01')
    makeBornAfterFile(dropped)
    const db = new DatabaseSync(dropped)
    db.prepare("INSERT INTO lb_meta (key, value) VALUES ('converted_from', '{}')").run()
    db.close()
    expect(classifyBoardFile(dropped)).toBe('converted-without-tldraw')
  })

  it('reads a tldraw board whose WAL still holds frames (a crash) without losing them', () => {
    const dir = tempDir()
    const path = seedTldrawBoard(dir, 'b-crashwal1')
    // A second connection writes and is left open, so its frames stay in the WAL (like a SIGKILL).
    const writer = new DatabaseSync(path)
    try {
      writer.exec('PRAGMA journal_mode = WAL')
      writer.exec("CREATE TABLE IF NOT EXISTS probe (x TEXT); INSERT INTO probe VALUES ('kept')")
      expect(walBytes(path)).toBeGreaterThan(0)
      const copy = join(dir, 'copy')
      mkdirSync(copy)
      for (const suffix of ['', '-wal'])
        copyFileSync(path + suffix, join(copy, `board-b-crashwal1.sqlite${suffix}`))
      const copied = boardDbPath(copy, 'b-crashwal1')
      expect(classifyBoardFile(copied)).toBe('tldraw')
      const reg = new RoomRegistry({ dataDir: copy, schema: draftroomSchema, backup: false })
      try {
        expect(reg.snapshot('b-crashwal1')?.documents.length).toBe(2)
      } finally {
        reg.closeAll()
      }
      const check = new DatabaseSync(copied, { readOnly: true })
      expect(check.prepare('SELECT x FROM probe').get()).toEqual({ x: 'kept' })
      check.close()
    } finally {
      writer.close()
    }
  })
})

describe('pre-open checks', () => {
  it('run in registration order; a refusal throws BoardOpenRefused and unregistering removes a check', () => {
    const seen: string[] = []
    const off = registerPreOpenCheck((ctx) => {
      seen.push(ctx.boardId)
      return ctx.boardId === 'b-refuse001' ? { ok: false, reason: 'new-canvas' } : { ok: true }
    })
    try {
      expect(() => runPreOpenChecks({ boardId: 'b-fine00001', path: 'x', exists: false })).not.toThrow()
      expect(() => runPreOpenChecks({ boardId: 'b-refuse001', path: 'x', exists: false })).toThrow(
        BoardOpenRefused,
      )
    } finally {
      off()
    }
    expect(() => runPreOpenChecks({ boardId: 'b-refuse001', path: 'x', exists: false })).not.toThrow()
    expect(seen).toEqual(['b-fine00001', 'b-refuse001'])
  })
})

describe('RoomRegistry refuses a born-after board', () => {
  it('through every entry point, and leaves the file byte-identical with no tldraw table', async () => {
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
      // the periodic backup visits open rooms only; a refused file never became one
      await reg.runBackupPass()
      expect(await reg.backupNow(boardId)).toBeNull()
    } finally {
      reg.closeAll()
    }
    expect(existsSync(join(backups, boardId))).toBe(false)
    expect(tablesOf(path)).toEqual(tables)
    expect(tablesOf(path).some(TLDRAW_TABLES)).toBe(false)
    expect(fileSha256(path)).toBe(sha)
    expect(walBytes(path)).toBe(0)
  })

  it('serves a converted board and a tldraw board as before', () => {
    const dataDir = tempDir()
    seedTldrawBoard(dataDir, 'b-tldraw02', [geoShape('s1') as unknown as TLRecord])
    const conv = seedTldrawBoard(dataDir, 'b-convert02', [geoShape('s1') as unknown as TLRecord])
    markConverted(conv)
    const reg = new RoomRegistry({ dataDir, schema: draftroomSchema, backup: false })
    try {
      for (const id of ['b-tldraw02', 'b-convert02'])
        expect(
          reg
            .snapshot(id)
            ?.documents.map((d) => d.state.id)
            .sort(),
        ).toEqual(['document:document', 'page:page', 'shape:s1'])
      // a brand-new board still gets its file on first open
      reg.getOrCreate('b-brandnew1')
      expect(existsSync(boardDbPath(dataDir, 'b-brandnew1'))).toBe(true)
    } finally {
      reg.closeAll()
    }
  })
})

describe('the real sync process', () => {
  const h = useProtocolHarness()

  it('closes a socket to a born-after board with 4099 NEW_CANVAS_BOARD and answers every internal board route 409 new-canvas', async () => {
    const dataDir = h.dataDir()
    const boardId = 'b-bornaft03'
    const rooms = join(dataDir, 'rooms')
    mkdirSync(rooms, { recursive: true })
    const path = boardDbPath(rooms, boardId)
    makeBornAfterFile(path)
    const sha = fileSha256(path)
    const tables = tablesOf(path)
    const server = await h.server({ dataDir, env: { DRAFTROOM_BACKUP_INTERVAL_MS: '1000' } })

    for (const role of ['editor', 'viewer'] as const) {
      const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const ws = new WebSocket(
          `${server.wsUrl}/connect/${boardId}?sessionId=s-${role}&ticket=${encodeURIComponent(mintTicket(boardId, 'usr_alice', role))}`,
        )
        ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
        ws.on('error', reject)
      })
      expect(closed).toEqual({ code: 4099, reason: 'NEW_CANVAS_BOARD' })
    }

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
    // two periodic backup passes go by: none of this board
    await new Promise((r) => setTimeout(r, 2_500))
    await server.kill('SIGINT')
    expect(tablesOf(path)).toEqual(tables)
    expect(tablesOf(path).some(TLDRAW_TABLES)).toBe(false)
    expect(fileSha256(path)).toBe(sha)
    expect(walBytes(path)).toBe(0)
    expect(existsSync(join(dataDir, 'backups', boardId))).toBe(false)
  })
})
