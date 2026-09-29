// One board's conversion (docs/EXCALIDRAW-MIGRATION.md §5.3 "Per board", §5.4): in one transaction, with
// the tldraw tables and dr_deleted_* left byte-identical, lb_source's digest equal to the backup
// manifest's recordsSha256, "Recently deleted" copied as origin `converted`, the disk check first, and a
// report with ids, counts and codes only.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImportDocValue } from '@draftroom/canvas-schema/doc'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { describe, expect, it } from 'vitest'
import { inspectBoardDb } from '../../src/backup/backup.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { drDeletedDigests, recordsSha256, tableDigest, tableNames } from '../../src/room/migrate/digest.ts'
import type { ConvertedFrom } from '../../src/room/schema.ts'
import { addDeletedRows, fixtureRecords, lbRows, readDb, seedBoardRecords, tempDir } from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())

function kitchenBoard() {
  const dataDir = tempDir()
  const boardId = 'b-kitchen01'
  const records = fixtureRecords('kitchen-sink')
  const path = seedBoardRecords(dataDir, boardId, records)
  // two captured deletes: a note (shape) and an arrow with its binding
  const deletedNote = { ...(records.find((r) => r.id === 'shape:note3') as object), id: 'shape:gone1' }
  addDeletedRows(path, [deletedNote as never])
  const arrow = records.find((r) => r.id === 'shape:arr1') as never
  const binding = records.find((r) => r.id === 'binding:b1s') as never
  addDeletedRows(path, [
    { ...(arrow as object), id: 'shape:gone2' } as never,
    { ...(binding as object), id: 'binding:gone2', fromId: 'shape:gone2' } as never,
  ])
  return { dataDir, boardId, path, records, reportDir: join(dataDir, 'migration') }
}

describe('convertBoardFile', () => {
  it('writes lb_* in one transaction and leaves the tldraw tables and dr_deleted_* byte-identical', () => {
    const b = kitchenBoard()
    const before = readDb(b.path, (db) => ({
      documents: tableDigest(db, 'documents'),
      metadata: tableDigest(db, 'metadata'),
      dr: drDeletedDigests(db),
      tables: tableNames(db),
    }))
    const backup = inspectBoardDb(b.path)
    const report = convertBoardFile(
      {
        kind: 'convert',
        boardId: b.boardId,
        path: b.path,
        reportDir: b.reportDir,
        backupKey: 'backups/sync/b-kitchen01/final.sqlite',
        expectedSourceSha256: backup.recordsSha256,
        at: 1_759_017_600_000,
        verifyLocalMode: true,
      },
      metrics,
    )
    expect(report.ok).toBe(true)
    expect(report.diff?.ok).toBe(true)
    expect(report.sourceMatchesBackup).toBe(true)
    expect(report.elementsOut).toBe(45)
    expect(report.deleted).toEqual({ rowsIn: 3, rowsOut: 3, unmapped: 0, lastSeq: 3 })
    const after = readDb(b.path, (db) => ({
      documents: tableDigest(db, 'documents'),
      metadata: tableDigest(db, 'metadata'),
      dr: drDeletedDigests(db),
      tables: tableNames(db),
      meta: Object.fromEntries(
        (db.prepare('SELECT key, value FROM lb_meta').all() as Array<{ key: string; value: string }>).map(
          (r) => [r.key, r.value],
        ),
      ),
      doc: db.prepare("SELECT value FROM lb_doc WHERE key = 'import'").get() as { value: string },
      lbSource: recordsSha256(db, 'lb_source'),
      deleted: db.prepare('SELECT batch, element_id, origin, deleted_by FROM lb_deleted ORDER BY seq').all(),
    }))
    expect(after.documents).toEqual(before.documents)
    expect(after.metadata).toEqual(before.metadata)
    expect(after.dr).toEqual(before.dr)
    expect(after.tables).toEqual(
      [...before.tables, 'lb_deleted', 'lb_doc', 'lb_elements', 'lb_meta', 'lb_source', 'sqlite_sequence']
        .sort()
        .filter((t, i, a) => a.indexOf(t) === i),
    )
    const cf = JSON.parse(after.meta.converted_from as string) as ConvertedFrom
    expect(cf).toMatchObject({
      documentClock: backup.documentClock,
      sourceSha256: backup.recordsSha256,
      backupKey: 'backups/sync/b-kitchen01/final.sqlite',
      deletedSeq: 3,
      lbClock: 1,
      cycle: 0,
      converterVersion: '1',
    })
    expect(after.lbSource).toBe(backup.recordsSha256)
    expect(after.meta.clock).toBe('1')
    expect(ImportDocValue.safeParse(JSON.parse(after.doc.value)).success).toBe(true)
    expect(after.deleted).toEqual([
      { batch: 1, element_id: 'gone1', origin: 'converted', deleted_by: 'usr_deleter0001' },
      { batch: 1, element_id: 'gone1.t', origin: 'converted', deleted_by: 'usr_deleter0001' },
      { batch: 2, element_id: 'gone2', origin: 'converted', deleted_by: 'usr_deleter0001' },
    ])
    const rows = lbRows(b.path)
    expect(rows.size).toBe(45)
    for (const r of rows.values()) {
      expect(r.clock).toBe(1)
      expect(r.gclock).toBe('{}')
      expect(JSON.parse(r.data).index).toBe(r.idx)
    }
    // the report: ids, counts, codes, timings, bytes (and the diff's check names)
    const onDisk = JSON.parse(readFileSync(join(b.reportDir, `${b.boardId}.json`), 'utf8'))
    expect(onDisk.ok).toBe(true)
    expect(typeof onDisk.peakHeapUsedMb).toBe('number')
    expect(onDisk.bytesAfter).toBeGreaterThan(onDisk.bytesBefore)
  })

  it('refuses when the disk check fails, and leaves the file as it was', () => {
    const b = kitchenBoard()
    const tables = readDb(b.path, tableNames)
    const report = convertBoardFile(
      {
        kind: 'convert',
        boardId: b.boardId,
        path: b.path,
        reportDir: b.reportDir,
        backupKey: null,
        freeBytesOverride: 1024,
      },
      metrics,
    )
    expect(report).toMatchObject({ ok: false, reason: 'disk' })
    expect(report.disk.ok).toBe(false)
    expect(readDb(b.path, tableNames)).toEqual(tables)
  })

  it('refuses a board that is already converted (a second conversion never overwrites lb_*)', () => {
    const b = kitchenBoard()
    const job = {
      kind: 'convert' as const,
      boardId: b.boardId,
      path: b.path,
      reportDir: b.reportDir,
      backupKey: null,
    }
    expect(convertBoardFile(job, metrics).ok).toBe(true)
    const rows = lbRows(b.path)
    expect(convertBoardFile(job, metrics)).toMatchObject({ ok: false, reason: 'already-converted' })
    expect(lbRows(b.path)).toEqual(rows)
    expect(existsSync(join(b.reportDir, `${b.boardId}.json`))).toBe(true)
  })

  it('every template fixture converts through the file path with the diff at 100%', () => {
    for (const name of [
      'lobby-tour',
      'brainstorm',
      'mood-board',
      'pitch-outline',
      'production-plan',
      'retrospective',
      'storyboard',
    ]) {
      const dataDir = tempDir()
      const path = seedBoardRecords(
        dataDir,
        `b-${name.replace(/[^a-z]/g, '').slice(0, 20)}x`,
        fixtureRecords(name),
      )
      const report = convertBoardFile(
        {
          kind: 'convert',
          boardId: 'b-fixture',
          path,
          reportDir: join(dataDir, 'migration'),
          backupKey: null,
          verifyLocalMode: true,
        },
        metrics,
      )
      expect({ name, ok: report.ok, reason: report.reason, diff: report.diff?.ok }).toEqual({
        name,
        ok: true,
        reason: undefined,
        diff: true,
      })
    }
  })
})
