// Bridge release R0, open item 9 gate (docs/EXCALIDRAW-MIGRATION.md "Open items" 9, §5.9 step 4, §5.10):
// the backup, the restore drill and readBoardDb handle a board file that has ONLY the new engine's lb_*
// tables (a board born on the new canvas). R0 copies it whole (never opening it for writing), lists it
// with format `lobby-elements`, uploads it offsite signed, and the drill checks what it can (size and
// sha256 of the file, integrity, every lb_* table's digest and the clock) without opening a room. A
// staged restore never puts such a backup in place, and never replaces a live board made on the new
// canvas. The source file stays byte-identical throughout.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFsBlobStore } from '@draftroom/blob-store'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupBoard, describeBoardDb, inspectBoardDb, readManifest } from '../../src/backup/backup.ts'
import {
  DrillProblem,
  fileBackupSource,
  localBackupSource,
  runRestoreDrill,
  storeBackupSource,
  verifyRestorable,
} from '../../src/backup/drill.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { type OffsiteManifest, offsiteKeys, parseManifest } from '../../src/backup/offsite-manifest.ts'
import { restoreBackupFile } from '../../src/backup/restore.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'
import { applyStagedRestores, listStagedRestores, stageRestore } from '../../src/backup/staged-restore.ts'
import { LB_BACKUP_FORMAT, lbFileFacts } from '../../src/r0/lb-files.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { readJsonObject, type TempData, tempData } from '../backup/offsite-fixtures.ts'
import { note } from '../deleted/fixtures.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { fileSha256, lbState, makeBornAfterFile, seedTldrawBoard, tablesOf, walBytes } from './support.ts'

const BOARD = 'b-lbonly001'
const KEY = backupSigningKey(TEST_INTERNAL_SECRET)
let data: TempData

beforeEach(() => {
  data = tempData('dr-r0-lbonly-')
  mkdirSync(data.rooms, { recursive: true })
})
afterEach(() => data.cleanup())

/** The live born-after board, its sha256, and a read-only backup of it (as run-all takes one). */
async function bornAfterBackedUp() {
  const live = boardDbPath(data.rooms, BOARD)
  makeBornAfterFile(live)
  const sha = fileSha256(live)
  const db = new DatabaseSync(live, { readOnly: true })
  try {
    const entry = await backupBoard({ db, boardId: BOARD, root: data.backups })
    return { live, sha, entry }
  } finally {
    db.close()
  }
}

describe('readBoardDb (describeBoardDb, inspectBoardDb) on a file with only lb_* tables', () => {
  it('describes it from its lb_* tables, read-only, instead of throwing', () => {
    const live = boardDbPath(data.rooms, BOARD)
    makeBornAfterFile(live)
    const sha = fileSha256(live)
    const facts = describeBoardDb(live)
    const db = new DatabaseSync(live, { readOnly: true })
    const lb = lbFileFacts(db)
    db.close()
    expect(facts).toEqual({
      documentClock: 7, // lb_meta.clock
      schema: { format: LB_BACKUP_FORMAT, schemaVersion: 1 },
      recordCount: 2, // lb_elements rows, the tombstone included
      recordsSha256: lb.recordsSha256,
      assets: [],
      records: new Map(),
      format: 'lobby-elements',
    })
    expect(inspectBoardDb(live).recordsSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fileSha256(live)).toBe(sha)
    expect(walBytes(live)).toBe(0)
  })

  it('still describes tldraw boards exactly as before, and still refuses a file that is not a board', () => {
    const tl = seedTldrawBoard(data.rooms, 'b-tldraw003', [note('n1', 'x') as TLRecord])
    const facts = inspectBoardDb(tl)
    expect(facts.format).toBeUndefined()
    expect(facts.recordCount).toBe(3)
    const empty = join(data.root, 'empty.sqlite')
    new DatabaseSync(empty).close()
    expect(() => inspectBoardDb(empty)).toThrow()
  })

  it('the lb digest changes with any row or schema change of any lb_* table', () => {
    const live = boardDbPath(data.rooms, BOARD)
    makeBornAfterFile(live)
    const digest = () => inspectBoardDb(live).recordsSha256
    const first = digest()
    const db = new DatabaseSync(live)
    db.prepare("UPDATE lb_doc SET value = '{}' WHERE key = 'workshop'").run()
    db.close()
    const second = digest()
    expect(second).not.toBe(first)
    const db2 = new DatabaseSync(live)
    db2.exec('CREATE TABLE lb_prev_1_doc (key TEXT)')
    db2.close()
    expect(digest()).not.toBe(second)
  })
})

describe('backups of a board born on the new canvas', () => {
  it('copy the file whole through a read-only connection and list it with format lobby-elements', async () => {
    const { live, sha, entry } = await bornAfterBackedUp()
    expect(entry.format).toBe('lobby-elements')
    expect(entry.assets).toEqual([])
    expect(entry.recordsSha256).toBe(inspectBoardDb(live).recordsSha256)
    expect(entry.documentClock).toBe(7)
    const copy = join(data.backups, BOARD, entry.file)
    expect(lbState(copy)).toEqual(lbState(live))
    expect(tablesOf(copy)).toEqual(tablesOf(live))
    expect(await readManifest(data.backups, BOARD)?.backups.at(-1)).toEqual(entry)
    expect(fileSha256(live)).toBe(sha)
    expect(walBytes(live)).toBe(0)
  })

  it('go offsite signed, with the format, and the drill verifies them from the store', async () => {
    const { live, sha, entry } = await bornAfterBackedUp()
    const store = createFsBlobStore(data.blobs)
    const offsite = new OffsiteBackups({ store, localRoot: data.backups, signingKey: KEY })
    try {
      await offsite.syncBoard(BOARD)
    } finally {
      await offsite.stop()
    }
    expect(offsite.storedKey(BOARD, entry.file)).toBe(offsiteKeys.file('backups/sync', BOARD, entry.file))
    const raw = await readJsonObject<OffsiteManifest>(store, offsiteKeys.manifest('backups/sync', BOARD))
    const parsed = parseManifest(raw, 'backups/sync', BOARD, KEY)
    expect(parsed.signature.status).toBe('valid')
    expect(parsed.entrySignatures.get(entry.file)?.status).toBe('valid')
    expect(parsed.manifest.backups[0]?.format).toBe('lobby-elements')
    expect(parsed.manifest.backups[0]?.recordsSha256).toBe(entry.recordsSha256)

    const report = await runRestoreDrill({
      dataDir: data.root,
      source: storeBackupSource(store, { signingKey: KEY }),
      boardIds: [BOARD],
    })
    expect(report.ok).toBe(true)
    const board = report.boards[0]
    expect(board?.live).toBe('identical')
    expect(board?.checks).toEqual(
      expect.arrayContaining([
        'manifest entry signature verified',
        'file sha256 matches the manifest',
        '2 records, clock 7, digest matches',
        expect.stringMatching(/^made on the new canvas: integrity and every lb_\* table checked; not opened/),
      ]),
    )
    expect(fileSha256(live)).toBe(sha)
  })

  it('the local drill checks what it can and never creates tldraw tables in the restored copy', async () => {
    const { live, entry } = await bornAfterBackedUp()
    const workDir = join(data.root, 'drill-work')
    const report = await runRestoreDrill({ dataDir: data.root, workDir, keepWorkDir: true })
    expect(report.ok).toBe(true)
    expect(report.boards.map((b) => [b.boardId, b.ok, b.backupFile, b.live])).toEqual([
      [BOARD, true, entry.file, 'identical'],
    ])
    const restored = boardDbPath(join(workDir, 'rooms'), BOARD)
    expect(tablesOf(restored)).toEqual(tablesOf(live))
    expect(lbState(restored)).toEqual(lbState(live))
    // the copy is the backup file byte for byte (never opened for writing)
    expect(fileSha256(restored)).toBe(fileSha256(join(data.backups, BOARD, entry.file)))
  })

  it('the drill catches a changed lb_* row and a manifest that lies about the format', async () => {
    const { entry } = await bornAfterBackedUp()
    const copy = join(data.backups, BOARD, entry.file)
    const tampered = { ...entry, recordsSha256: '0'.repeat(64) }
    await expect(
      verifyRestorable({ boardId: BOARD, entry: tampered, path: copy, workRooms: join(data.root, 'w1') }),
    ).rejects.toThrow('restored records differ from the manifest digest')
    const { format: _f, ...unmarked } = entry
    await expect(
      verifyRestorable({ boardId: BOARD, entry: unmarked, path: copy, workRooms: join(data.root, 'w2') }),
    ).rejects.toThrow(DrillProblem)
    // a file source describes the born-after file itself
    const fromFile = await fileBackupSource(copy).entry(BOARD)
    expect(fromFile.format).toBe('lobby-elements')
    expect(fromFile.recordsSha256).toBe(entry.recordsSha256)
  })

  it('restoreBackupFile copies it whole with bump 0 and refuses to raise its clock', async () => {
    const { entry } = await bornAfterBackedUp()
    const file = join(data.backups, BOARD, entry.file)
    const target = join(data.root, 'target-rooms')
    expect(() => restoreBackupFile({ file, roomsDir: target, boardId: BOARD, bumpClockBy: 1000 })).toThrow(
      'made on the new canvas',
    )
    expect(existsSync(boardDbPath(target, BOARD))).toBe(false)
    const result = restoreBackupFile({ file, roomsDir: target, boardId: BOARD })
    expect(result.documentClock).toBe(7)
    expect(fileSha256(result.path)).toBe(fileSha256(file))
    expect(readdirSync(target).sort()).toEqual([`board-${BOARD}.sqlite`])
  })

  it('a staged restore refuses the backup, and never replaces a live board made on the new canvas', async () => {
    const { live, sha } = await bornAfterBackedUp()
    await expect(
      stageRestore({ dataDir: data.root, source: localBackupSource(data.backups), boardId: BOARD }),
    ).rejects.toThrow('made on the new canvas')
    expect(listStagedRestores(data.root)).toEqual([])

    // a tldraw backup of another board, staged under the born-after board's id by hand: not applied
    const other = seedTldrawBoard(join(data.root, 'elsewhere'), 'b-tldraw004', [note('n1', 'x') as TLRecord])
    const db = new DatabaseSync(other)
    const tl = await backupBoard({ db, boardId: 'b-tldraw004', root: join(data.root, 'other-backups') })
    db.close()
    const restoreDir = join(data.root, 'restore')
    mkdirSync(restoreDir, { recursive: true })
    const staged = join(restoreDir, `board-${BOARD}.sqlite`)
    copyFileSync(join(data.root, 'other-backups', 'b-tldraw004', tl.file), staged)
    writeFileSync(
      join(restoreDir, `board-${BOARD}.json`),
      JSON.stringify({
        format: 'draftroom-staged-restore',
        version: 1,
        id: 'r0-test-request',
        boardId: BOARD,
        file: tl.file,
        source: 'local',
        sha256: fileSha256(staged),
        sizeBytes: tl.sizeBytes,
        documentClock: tl.documentClock,
        recordCount: tl.recordCount,
        stagedAt: new Date().toISOString(),
      }),
    )
    const results = await applyStagedRestores({ dataDir: data.root })
    expect(results).toEqual([
      {
        boardId: BOARD,
        ok: false,
        message: expect.stringContaining('the live board was made on the new canvas'),
      },
    ])
    expect(fileSha256(live)).toBe(sha)
    expect(readdirSync(data.rooms).filter((f) => f.includes('pre-restore'))).toEqual([])
  })
})
