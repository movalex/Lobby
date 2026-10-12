// The final backup's digest reaches the conversion (docs/EXCALIDRAW-MIGRATION.md §5.3 step 3 and its
// table, §5.6, §7.5 step 6; the cut-over runbook's gap G4). On 5caee00 `MigrationService.backupOf` was
// wired nowhere: every report's `sourceMatchesBackup` was null and `converted_from.backupKey` null, and a
// board edited after its final backup converted all the same. Now a maintenance run (`convert-all`) reads
// the board's newest held, tldraw-described entry of the local manifest (what R0's run-all wrote after
// maintenance went on), refuses a board whose records differ from it (`backup-digest`, nothing written),
// and records the entry's object key; a lazy conversion on open has no final backup (§5.3 "Lazy").
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@draftroom/tldraw-import/tldraw'
import { describe, expect, it } from 'vitest'
import {
  type BackupEntry,
  backupBoard,
  dropLocalBackups,
  inspectBoardDb,
  readManifest,
} from '../../src/backup/backup.ts'
import { offsiteKeys } from '../../src/backup/offsite-manifest.ts'
import { OFFSITE_PREFIX } from '../../src/backup/store.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { tableNames } from '../../src/room/migrate/digest.ts'
import { finalBackupOf } from '../../src/room/migrate/final-backup.ts'
import { boardFileState, MigrationService } from '../../src/room/migrate/service.ts'
import type { ConvertedFrom } from '../../src/room/schema.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { fixtureRecords, r0Edit, readDb, seedBoardRecords, tempDir } from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const DAY = 86_400_000
/** "now" for the service and the hold checks: 2026-10-03 06:00Z (the earliest cut-over morning). */
const NOW = Date.UTC(2026, 9, 3, 6, 0)
const ONE_STEP = 2_147_483_647

/** R0's run-all backup of a tldraw board (held 90 days, described from its tldraw tables), at `at`. */
async function heldBackup(rooms: string, backups: string, boardId: string, at: number): Promise<BackupEntry> {
  const db = new DatabaseSync(boardDbPath(rooms, boardId), { readOnly: true })
  try {
    return await backupBoard({
      db,
      boardId,
      root: backups,
      rate: ONE_STEP,
      now: () => new Date(at),
      holdUntil: new Date(at + 90 * DAY),
    })
  } finally {
    db.close()
  }
}

const convertedFrom = (path: string) =>
  JSON.parse(
    (
      readDb(path, (db) => db.prepare("SELECT value FROM lb_meta WHERE key = 'converted_from'").get()) as {
        value: string
      }
    ).value,
  ) as ConvertedFrom

const report = (dir: string, boardId: string) =>
  JSON.parse(readFileSync(join(dir, `${boardId}.json`), 'utf8')) as Record<string, unknown>

describe('finalBackupOf: the newest held, tldraw-described entry of the local manifest', () => {
  it('picks it among ordinary, lb-format and older held entries; none → null', () => {
    const backups = tempDir()
    const boardId = 'b-final00001'
    const entry = (file: string, over: Partial<BackupEntry>): BackupEntry => ({
      file,
      boardId,
      createdAt: '2026-10-01T00:00:00.000Z',
      documentClock: 1,
      schema: {},
      recordCount: 1,
      recordsSha256: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
      sizeBytes: 1,
      ...over,
    })
    const write = (entries: BackupEntry[]) => {
      mkdirSync(join(backups, boardId), { recursive: true })
      writeFileSync(
        join(backups, boardId, 'manifest.json'),
        JSON.stringify({ format: 'draftroom-board-backups', version: 1, boardId, backups: entries }),
      )
    }
    expect(finalBackupOf(backups, boardId, NOW)).toBeNull()
    const hold = new Date(NOW + 90 * DAY).toISOString()
    write([
      // an ordinary backup (not held): never the final one, however new
      entry('2026-10-03T05-50-00-000Z-c9.sqlite', {
        createdAt: '2026-10-03T05:50:00.000Z',
        documentClock: 9,
      }),
      // a held one from an earlier run-all (DEPLOY.md's optional quiet-time run)
      entry('2026-10-01T10-00-00-000Z-c5.sqlite', {
        createdAt: '2026-10-01T10:00:00.000Z',
        documentClock: 5,
        recordsSha256: 'c'.repeat(64),
        holdUntil: hold,
      }),
      // the final set, written after maintenance went on
      entry('2026-10-03T05-20-00-000Z-c8.sqlite', {
        createdAt: '2026-10-03T05:20:00.000Z',
        documentClock: 8,
        recordsSha256: 'd'.repeat(64),
        holdUntil: hold,
      }),
      // an lb-format entry describes lb_* tables, not the records a conversion reads
      entry('2026-10-03T05-30-00-000Z-c2.sqlite', {
        createdAt: '2026-10-03T05:30:00.000Z',
        documentClock: 2,
        recordsSha256: 'e'.repeat(64),
        holdUntil: hold,
        format: 'lobby-elements',
      }),
    ])
    // the key is the one the offsite store gives the file (final-backup.ts spells the layout on its own)
    expect(finalBackupOf(backups, boardId, NOW)?.key).toBe(
      offsiteKeys.file(OFFSITE_PREFIX, boardId, '2026-10-03T05-20-00-000Z-c8.sqlite'),
    )
    expect(finalBackupOf(backups, boardId, NOW)).toEqual({
      key: `backups/sync/${boardId}/2026-10-03T05-20-00-000Z-c8.sqlite`,
      recordsSha256: 'd'.repeat(64),
      file: '2026-10-03T05-20-00-000Z-c8.sqlite',
      documentClock: 8,
      holdUntil: hold,
    })
    // a hold that has passed is an ordinary backup again
    expect(finalBackupOf(backups, boardId, NOW + 91 * DAY)).toBeNull()
    // an unreadable manifest throws (the service converts without the check and logs it)
    writeFileSync(join(backups, boardId, 'manifest.json'), '{"format":"something-else"}')
    expect(() => finalBackupOf(backups, boardId, NOW)).toThrow(/not readable/)
  })

  // Wave N.1 (wave M follow-up 7, W7): M7-4 removes a held copy locally once the offsite store holds it and moves its
  // entry to the manifest's `offsiteOnly` until the hold ends. The final backup is then offsite only, and still the
  // one the conversion must check against: before this, convert-all found no final backup (no digest check, a null
  // `backupKey`) for every board whose held copy had gone offsite.
  it('reads the held entries that went offsite only (M7-4 offsiteOnly), and never one whose hold ended', async () => {
    const dataDir = tempDir()
    const rooms = join(dataDir, 'rooms')
    const backups = join(dataDir, 'backups')
    const boardId = 'b-final-offs'
    seedBoardRecords(rooms, boardId, fixtureRecords('brainstorm'))
    // an earlier held set (a quiet-time run-all), then the final set after maintenance went on
    const earlier = await heldBackup(rooms, backups, boardId, NOW - 2 * DAY)
    const final = await heldBackup(rooms, backups, boardId, NOW - 40 * 60_000)
    expect(finalBackupOf(backups, boardId, NOW)?.file).toBe(final.file)
    // the offsite store holds the final copy: its local file goes, its entry moves to offsiteOnly
    const at = () => new Date(NOW)
    const dropped = await dropLocalBackups(backups, boardId, (e) => e.file === final.file, at)
    expect(dropped).toEqual([final.file])
    const m = readManifest(backups, boardId)
    expect(m?.backups.map((e) => e.file)).toEqual([earlier.file])
    expect(m?.offsiteOnly?.map((e) => e.file)).toEqual([final.file])
    // still the final backup: the newest held, tldraw-described entry, wherever its copy is
    expect(finalBackupOf(backups, boardId, NOW)).toEqual({
      key: offsiteKeys.file(OFFSITE_PREFIX, boardId, final.file),
      recordsSha256: final.recordsSha256,
      file: final.file,
      documentClock: final.documentClock,
      holdUntil: final.holdUntil,
    })
    // and once every copy is offsite only, too
    await dropLocalBackups(backups, boardId, () => true, at)
    expect(readManifest(backups, boardId)?.backups).toEqual([])
    expect(finalBackupOf(backups, boardId, NOW)?.file).toBe(final.file)
    // a hold that has passed counts for nothing, local or offsite only
    expect(finalBackupOf(backups, boardId, NOW + 91 * DAY)).toBeNull()
  })
})

describe('convertBoardFile with the final backup', () => {
  it('refuses a board whose records differ from the backup, before anything is written', () => {
    const dataDir = tempDir()
    const boardId = 'b-finalconv1'
    const path = seedBoardRecords(dataDir, boardId, fixtureRecords('brainstorm'))
    const before = readDb(path, tableNames)
    const facts = inspectBoardDb(path)
    const rep = convertBoardFile(
      {
        kind: 'convert',
        boardId,
        path,
        reportDir: join(dataDir, 'migration'),
        backupKey: `backups/sync/${boardId}/2026-10-03T05-20-00-000Z-c8.sqlite`,
        expectedSourceSha256: 'f'.repeat(64),
      },
      metrics,
    )
    expect(rep).toMatchObject({
      ok: false,
      reason: 'backup-digest',
      sourceMatchesBackup: false,
      sourceSha256: facts.recordsSha256,
      expectedSourceSha256: 'f'.repeat(64),
      backupKey: `backups/sync/${boardId}/2026-10-03T05-20-00-000Z-c8.sqlite`,
      elementsOut: 0,
    })
    expect(readDb(path, tableNames)).toEqual(before) // no lb_* table, nothing written
    expect(boardFileState(path)).toBe('tldraw')
    expect(report(join(dataDir, 'migration'), boardId)).toMatchObject({ ok: false, reason: 'backup-digest' })
  })
})

describe('MigrationService.convertAll reads each board’s final backup', () => {
  it('records its key, refuses a board edited after it, and a lazy conversion ignores the manifest', async () => {
    const dataDir = tempDir()
    const rooms = join(dataDir, 'rooms')
    const backups = join(dataDir, 'backups')
    const reportDir = join(dataDir, 'migration')
    const untouched = 'b-final-same'
    const edited = 'b-final-edit'
    const noBackup = 'b-final-none'
    seedBoardRecords(rooms, untouched, fixtureRecords('brainstorm'))
    seedBoardRecords(rooms, edited, fixtureRecords('brainstorm'))
    seedBoardRecords(rooms, noBackup, fixtureRecords('brainstorm'))
    // the final set (R0's run-all after maintenance went on), 40 minutes before "now"
    const sameEntry = await heldBackup(rooms, backups, untouched, NOW - 40 * 60_000)
    const editedEntry = await heldBackup(rooms, backups, edited, NOW - 40 * 60_000)
    // ... and then one board was edited anyway (a sync restart turned maintenance off, say)
    r0Edit(rooms, edited, (txn) => {
      const page = txn.get('page:page') as TLRecord & { name: string }
      txn.set('page:page', { ...page, name: 'Renamed after the backup' } as TLRecord)
    })
    expect(inspectBoardDb(boardDbPath(rooms, edited)).recordsSha256).not.toBe(editedEntry.recordsSha256)

    const svc = new MigrationService({ roomsDir: rooms, now: () => NOW, rssLimitMb: 1_000_000 })
    const out = await svc.convertAll()
    expect(out).toEqual({
      [untouched]: { ready: true, did: 'converted' },
      [edited]: { ready: false, reason: 'backup-digest' },
      [noBackup]: { ready: true, did: 'converted' },
    })
    // the untouched board: converted from the records the final backup holds, with its key
    expect(convertedFrom(boardDbPath(rooms, untouched))).toMatchObject({
      backupKey: `backups/sync/${untouched}/${sameEntry.file}`,
      sourceSha256: sameEntry.recordsSha256,
    })
    expect(report(reportDir, untouched)).toMatchObject({
      ok: true,
      sourceMatchesBackup: true,
      backupKey: `backups/sync/${untouched}/${sameEntry.file}`,
      expectedSourceSha256: sameEntry.recordsSha256,
    })
    // the edited board: left on its tldraw tables, the report says why (the runbook's C10 stops here)
    expect(boardFileState(boardDbPath(rooms, edited))).toBe('tldraw')
    expect(report(reportDir, edited)).toMatchObject({
      ok: false,
      reason: 'backup-digest',
      sourceMatchesBackup: false,
      expectedSourceSha256: editedEntry.recordsSha256,
    })
    expect(svc.status().boards.find((b) => b.boardId === edited)).toMatchObject({
      state: 'failed',
      reason: 'backup-digest',
    })
    // a board with no held backup converts with no check (the rehearsal on generated boards)
    expect(convertedFrom(boardDbPath(rooms, noBackup)).backupKey).toBeNull()
    expect(report(reportDir, noBackup)).toMatchObject({ sourceMatchesBackup: null, backupKey: null })
    // a lazy conversion on open (§5.3 "Lazy": restored old backups, boards made on R0) has no final backup
    expect(await svc.prepare(edited)).toEqual({ ready: true, did: 'converted' })
    expect(convertedFrom(boardDbPath(rooms, edited)).backupKey).toBeNull()
    expect(report(reportDir, edited)).toMatchObject({ ok: true, sourceMatchesBackup: null })
    await svc.close()
  }, 120_000)
})
