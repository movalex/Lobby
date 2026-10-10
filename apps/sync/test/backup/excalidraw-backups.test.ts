// Backups on the Excalidraw build (2B; the bridge release R0's contracts 3 and 4, docs/EXCALIDRAW-
// MIGRATION.md "Contracts R0 fixed", §5.6, §5.9). Until now this build backed up nothing but run-all's
// read-only copies, described a converted board by its stale tldraw tables, and could neither drill nor
// restore an lb backup (R0's refusals). Each case below failed on f336ae4:
//  - a converted board is described from its lb_* tables (`lobby-elements-converted`), a board born on
//    the new canvas as `lobby-elements`, with the files its elements reference; the tldraw build (R0)
//    still describes and refuses as before;
//  - the periodic pass backs up exactly the boards whose lb_* state moved, through a read-only connection;
//  - local and offsite retention keep every backup whose signed holdUntil is ahead, outside their count,
//    and the entries go offsite with format and holdUntil signed;
//  - the restore drill opens lb backups through the element room's store (local and offsite sources);
//  - a staged restore puts an lb backup back with a new epoch, and a tldraw backup (from before the
//    cut-over) as it is, to be converted when its room opens;
//  - run-all on this build goes through the same pass, and a run-all and a pass on one board never lose
//    a manifest entry.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFsBlobStore } from '@draftroom/blob-store'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupBoard, inspectBoardDb, readManifest } from '../../src/backup/backup.ts'
import { localBackupSource, runRestoreDrill, storeBackupSource } from '../../src/backup/drill.ts'
import { ElementBackups } from '../../src/backup/element-backups.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { MAX_MANIFEST_BYTES, offsiteKeys, parseManifest } from '../../src/backup/offsite-manifest.ts'
import { createRunAll } from '../../src/backup/run-all.ts'
import { backupSigningKey, checkEntry } from '../../src/backup/signing.ts'
import { applyStagedRestores, stageRestore } from '../../src/backup/staged-restore.ts'
import { getJson } from '../../src/backup/store.ts'
import { diskProbe } from '../../src/disk.ts'
import { lbFileFacts } from '../../src/r0/lb-files.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { boardFileState } from '../../src/room/migrate/service.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import {
  excalidrawEdit,
  fixtureRecords,
  lbRows,
  makeBornAfterFile,
  readDb,
  seedBoardRecords,
} from '../migrate/board-files.ts'
import { type TempData, tempData } from './offsite-fixtures.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const CONVERTED = 'b-xbk-conv01'
const BORN = 'b-xbk-born01'
const TLDRAW = 'b-xbk-tl0001'
const AST = 'ast_XBKXBKXBKXBKXBKXBKXB'
const VER = 'ver_XBKXBKXBKXBKXBKXBKXB'
const DAY = 86_400_000
const t0 = Date.UTC(2026, 9, 10, 9, 0)
const key = backupSigningKey(TEST_INTERNAL_SECRET)
/** M7-4: a disk with room to spare, whatever the test machine's (the pass prunes and pauses below 20 % free) */
const disk = diskProbe({ fixed: 0.9 })

let data: TempData
beforeEach(() => {
  data = tempData('dr-xbk-')
  mkdirSync(data.rooms, { recursive: true })
})
afterEach(() => {
  data.cleanup()
})

/** A converted board, a board born on the new canvas (one element references a file) and a tldraw board. */
function boards() {
  const conv = seedBoardRecords(data.rooms, CONVERTED, fixtureRecords('retrospective'))
  expect(
    convertBoardFile(
      {
        kind: 'convert',
        boardId: CONVERTED,
        path: conv,
        reportDir: join(data.root, 'migration'),
        backupKey: null,
        at: 1,
      },
      metrics,
    ).ok,
  ).toBe(true)
  const born = boardDbPath(data.rooms, BORN)
  makeBornAfterFile(born)
  const db = new DatabaseSync(born)
  db.prepare(
    "INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES ('img1', 1, 'a1', 0, 'image', 1, '{}', ?)",
  ).run(
    JSON.stringify({
      id: 'img1',
      type: 'image',
      customData: { lobby: { file: { assetId: AST, versionId: VER } } },
    }),
  )
  db.close()
  const tl = seedBoardRecords(data.rooms, TLDRAW, fixtureRecords('brainstorm'))
  return { conv, born, tl }
}

/** One Excalidraw-side write: the board's lb clock moves. */
const touch = (path: string, id: string) =>
  excalidrawEdit(path, id, ['pos'], (e) => {
    e.x = Number(e.x) + 1
  })
const firstElement = (path: string) => [...lbRows(path).values()].find((r) => r.deleted === 0)?.id as string

describe('the Excalidraw build describes its board files from their lb_* tables', () => {
  it('a converted board is lobby-elements-converted; born on the new canvas is lobby-elements with its files', () => {
    const { conv, born } = boards()
    const c = inspectBoardDb(conv)
    const lb = readDb(conv, (db) => lbFileFacts(db))
    expect(c).toMatchObject({
      format: 'lobby-elements-converted',
      documentClock: lb.documentClock,
      recordCount: lb.recordCount,
      recordsSha256: lb.recordsSha256,
      schema: { format: 'lobby-elements-converted' },
    })
    expect(inspectBoardDb(born)).toMatchObject({
      format: 'lobby-elements',
      assets: [{ assetId: AST, versionId: VER }],
    })
  })
})

describe('the periodic pass of the Excalidraw build', () => {
  it('backs up the boards whose lb_* state moved, never a tldraw-only one, and never writes a board file', async () => {
    const { conv, born, tl } = boards()
    const sha = (p: string) => readDb(p, (db) => lbFileFacts(db).recordsSha256)
    const before = [sha(conv), sha(born)]
    let now = t0
    const eb = new ElementBackups({
      roomsDir: data.rooms,
      backupsDir: data.backups,
      now: () => new Date(now),
      disk,
    })
    expect(await eb.runPass()).toEqual({
      backedUp: [CONVERTED, BORN].sort(),
      failed: [],
      pruned: [],
      lowDisk: false,
    })
    expect(readManifest(data.backups, CONVERTED)?.backups.map((b) => b.format)).toEqual([
      'lobby-elements-converted',
    ])
    expect(readManifest(data.backups, BORN)?.backups.map((b) => b.format)).toEqual(['lobby-elements'])
    expect(readManifest(data.backups, TLDRAW)).toBeNull()
    expect([sha(conv), sha(born)]).toEqual(before)
    expect(existsSync(tl)).toBe(true)
    now += 60_000
    expect((await eb.runPass()).backedUp).toEqual([])
    touch(conv, firstElement(conv))
    now += 60_000
    expect((await eb.runPass()).backedUp).toEqual([CONVERTED])
    const entries = readManifest(data.backups, CONVERTED)?.backups ?? []
    expect(entries).toHaveLength(2)
    expect(entries[1]?.documentClock).toBe(readDb(conv, (db) => lbFileFacts(db).documentClock))
  })
})

describe('retention keeps a held backup outside its count, locally and offsite', () => {
  it('a run-all backup survives 14 newer ones for 90 days, with format and holdUntil signed offsite', async () => {
    const { conv } = boards()
    let now = t0
    const clock = () => new Date(now)
    const eb = new ElementBackups({ roomsDir: data.rooms, backupsDir: data.backups, now: clock, disk })
    const store = createFsBlobStore(data.blobs)
    const offsite = new OffsiteBackups({ store, localRoot: data.backups, signingKey: key, now: clock })
    const held = await eb.backupFresh(CONVERTED, { holdUntil: new Date(t0 + 90 * DAY) })
    await offsite.syncBoard(CONVERTED)
    for (let i = 1; i <= 14; i++) {
      now = t0 + i * 60_000
      touch(conv, firstElement(conv))
      expect((await eb.runPass()).backedUp).toContain(CONVERTED)
      await offsite.syncBoard(CONVERTED)
    }
    const local = readManifest(data.backups, CONVERTED)?.backups ?? []
    expect(local.map((b) => b.file)).toContain(held.file)
    expect(local.filter((b) => !b.holdUntil)).toHaveLength(12)
    const raw = await getJson(store, offsiteKeys.manifest('backups/sync', CONVERTED), MAX_MANIFEST_BYTES)
    const parsed = parseManifest(raw, 'backups/sync', CONVERTED, key)
    const entry = parsed.manifest.backups.find((b) => b.file === held.file)
    expect(entry).toMatchObject({ format: 'lobby-elements-converted', holdUntil: held.holdUntil })
    expect(parsed.entrySignatures.get(held.file)?.status).toBe('valid')
    expect(parsed.manifest.backups.filter((b) => !b.holdUntil)).toHaveLength(12)
    // format and holdUntil are signed: changing either breaks the entry's signature
    const listed = (raw as { backups: Record<string, unknown>[] }).backups.find((b) => b.file === held.file)
    expect(
      checkEntry(key, CONVERTED, { ...listed, holdUntil: new Date(t0 + 900 * DAY).toISOString() }).status,
    ).toBe('invalid')
    expect(checkEntry(key, CONVERTED, { ...listed, format: 'lobby-elements' }).status).toBe('invalid')
    // once the hold has passed, it is an ordinary (the oldest) backup again, locally and offsite
    now = t0 + 91 * DAY
    touch(conv, firstElement(conv))
    await eb.runPass()
    await offsite.syncBoard(CONVERTED)
    expect(readManifest(data.backups, CONVERTED)?.backups.map((b) => b.file)).not.toContain(held.file)
  })
})

describe('the restore drill of the Excalidraw build', () => {
  it('opens lb backups through the element room’s store, from the local folder and from the offsite store', async () => {
    boards()
    const eb = new ElementBackups({ roomsDir: data.rooms, backupsDir: data.backups, disk })
    await eb.runPass()
    const local = await runRestoreDrill({ dataDir: data.root, boardIds: [CONVERTED, BORN] })
    expect(local.boards.map((b) => [b.boardId, b.ok, b.live, b.problems])).toEqual([
      [CONVERTED, true, 'identical', []],
      [BORN, true, 'identical', []],
    ])
    for (const b of local.boards)
      expect(b.checks.some((c) => c.startsWith("opened through the element room's store"))).toBe(true)
    const store = createFsBlobStore(data.blobs)
    const offsite = new OffsiteBackups({ store, localRoot: data.backups, signingKey: key })
    await offsite.runPass()
    const remote = await runRestoreDrill({
      dataDir: data.root,
      source: storeBackupSource(store, { signingKey: key }),
    })
    expect(remote.ok).toBe(true)
    expect(remote.boards.map((b) => b.boardId).sort()).toEqual([BORN, CONVERTED].sort())
  })
})

describe('a staged restore on the Excalidraw build', () => {
  it('puts an lb backup back with a new epoch and a clock past the live one', async () => {
    const { conv } = boards()
    const eb = new ElementBackups({ roomsDir: data.rooms, backupsDir: data.backups, now: () => new Date(t0) })
    const old = await eb.backupFresh(CONVERTED)
    const oldRows = lbRows(conv)
    const epochOf = (p: string) =>
      readDb(
        p,
        (db) =>
          (db.prepare("SELECT value FROM lb_meta WHERE key = 'epoch'").get() as { value: string }).value,
      )
    const oldEpoch = epochOf(conv)
    for (let i = 0; i < 3; i++) touch(conv, firstElement(conv))
    const liveClock = readDb(conv, (db) => lbFileFacts(db).documentClock)
    const staged = await stageRestore({
      dataDir: data.root,
      source: localBackupSource(data.backups),
      boardId: CONVERTED,
      file: old.file,
    })
    expect(staged.checks.join(' ')).toMatch(/new epoch/)
    const [applied] = await applyStagedRestores({ dataDir: data.root })
    expect(applied?.ok).toBe(true)
    const rows = lbRows(conv)
    expect([...rows.keys()].sort()).toEqual([...oldRows.keys()].sort())
    for (const [id, r] of rows) expect(r.data).toBe(oldRows.get(id)?.data)
    expect(epochOf(conv)).not.toBe(oldEpoch)
    expect(readDb(conv, (db) => lbFileFacts(db).documentClock)).toBeGreaterThan(liveClock)
    expect(boardFileState(conv)).toBe('converted')
  })

  it('puts a tldraw backup from before the cut-over back as it is: converted when its room opens', async () => {
    // R0's final backup of the board, before the conversion
    const live = seedBoardRecords(data.rooms, CONVERTED, fixtureRecords('retrospective'))
    const db = new DatabaseSync(live)
    const pre = await backupBoard({ db, boardId: CONVERTED, root: data.backups, now: () => new Date(t0) })
    db.close()
    expect(pre.format).toBeUndefined()
    expect(
      convertBoardFile(
        {
          kind: 'convert',
          boardId: CONVERTED,
          path: live,
          reportDir: join(data.root, 'migration'),
          backupKey: null,
          at: 1,
        },
        metrics,
      ).ok,
    ).toBe(true)
    expect(boardFileState(live)).toBe('converted')
    await stageRestore({
      dataDir: data.root,
      source: localBackupSource(data.backups),
      boardId: CONVERTED,
      file: pre.file,
    })
    const [applied] = await applyStagedRestores({ dataDir: data.root })
    expect(applied?.ok).toBe(true)
    expect(applied?.message).not.toMatch(/carried over/)
    // no lb_* table came back with it: the lazy conversion runs when its room opens (§5.6)
    expect(boardFileState(live)).toBe('tldraw')
  })
})

describe('run-all on the Excalidraw build', () => {
  it('backs up every board file with a hold, and a pass meeting it on one board loses no manifest entry', async () => {
    boards()
    let n = 0
    const eb = new ElementBackups({
      roomsDir: data.rooms,
      backupsDir: data.backups,
      // a distinct stamp per backup, so concurrent copies never share a file name
      now: () => new Date(t0 + n++ * 1_000),
      disk,
    })
    const runAll = createRunAll({
      registry: eb,
      backups: { status: () => ({ store: 'off' }) as never, copyOffsite: async () => null },
      now: () => new Date(t0),
    })
    const [report] = await Promise.all([runAll.run(), eb.runPass()])
    expect(report.ok).toBe(true)
    expect(report.boards.map((b) => [b.boardId, b.format ?? null])).toEqual([
      [BORN, 'lobby-elements'],
      [CONVERTED, 'lobby-elements-converted'],
      [TLDRAW, null],
    ])
    for (const b of report.boards) expect(b.holdUntil).toBe(new Date(t0 + 90 * DAY).toISOString())
    for (const id of [CONVERTED, BORN]) {
      const files = readManifest(data.backups, id)?.backups.map((b) => b.file) ?? []
      // the run-all backup and the pass's backup are both listed
      expect(files).toHaveLength(2)
      expect(files).toContain(report.boards.find((b) => b.boardId === id)?.file)
    }
  })
})
