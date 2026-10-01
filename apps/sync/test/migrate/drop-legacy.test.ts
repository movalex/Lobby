// drop-legacy (docs/EXCALIDRAW-MIGRATION.md §5.9 step 5, §7.5 step 10; the cut-over runbook's gap G8 and
// step D7): the tldraw side of a converted board file goes, the room's tables stay byte-identical, the file
// shrinks, R0 refuses the file afterwards. The guards: the 7-day window since the conversion or the newest
// roll-forward (forced only on purpose), never an unconverted or a roll-forward-pending board, nothing on
// a board born on the new canvas, a dry run writes nothing. Nothing of this existed on 5caee00.
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@draftroom/tldraw-import/tldraw'
import { describe, expect, it } from 'vitest'
import { classifyBoardFile } from '../../src/r0/born-after.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { lbDigests, tableNames } from '../../src/room/migrate/digest.ts'
import {
  DROP_LEGACY_WINDOW_MS,
  type DropLegacyJob,
  dropLegacyBoardFile,
} from '../../src/room/migrate/drop-legacy.ts'
import { rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import { boardFileState } from '../../src/room/migrate/service.ts'
import { BoardStore } from '../../src/room/store.ts'
import { boardDbPath } from '../../src/rooms.ts'
import {
  addDeletedRows,
  fixtureRecords,
  lbRows,
  makeBornAfterFile,
  r0Edit,
  readDb,
  seedBoardRecords,
  tempDir,
} from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const DAY = 86_400_000
/** the conversion time */
const AT = Date.UTC(2026, 9, 3, 6, 0)
const LEGACY = [
  'documents',
  'dr_deleted_records',
  'dr_deleted_schemas',
  'lb_source',
  'metadata',
  'objects',
  'tombstones',
]
/** the room's tables: never touched */
const SERVING = ['lb_deleted', 'lb_doc', 'lb_elements', 'lb_meta'] as const

function converted(at = AT) {
  const dataDir = tempDir()
  const rooms = join(dataDir, 'rooms')
  const boardId = 'b-drop000001'
  const records = fixtureRecords('kitchen-sink')
  const path = seedBoardRecords(rooms, boardId, records)
  addDeletedRows(path, [
    { ...(records.find((r) => r.id === 'shape:note3') as object), id: 'shape:gone1' } as never,
  ])
  const reportDir = join(dataDir, 'migration')
  const rep = convertBoardFile({ kind: 'convert', boardId, path, reportDir, backupKey: null, at }, metrics)
  expect(rep.ok).toBe(true)
  return { dataDir, rooms, boardId, path, reportDir }
}

const job = (b: { boardId: string; path: string; reportDir: string }, over: Partial<DropLegacyJob> = {}) =>
  ({
    kind: 'drop-legacy',
    boardId: b.boardId,
    path: b.path,
    reportDir: b.reportDir,
    force: false,
    dryRun: false,
    now: AT + 8 * DAY,
    ...over,
  }) satisfies DropLegacyJob

const servingDigests = (path: string) =>
  readDb(path, (db) => Object.fromEntries(SERVING.map((t) => [t, lbDigests(db)[t]])))

const onDisk = (b: { reportDir: string; boardId: string }) =>
  JSON.parse(readFileSync(join(b.reportDir, `${b.boardId}.drop-legacy.json`), 'utf8')) as Record<
    string,
    unknown
  >

describe('dropLegacyBoardFile', () => {
  it('after the window: drops the tldraw side, keeps the room’s tables byte-identical, shrinks the file', () => {
    const b = converted()
    const before = servingDigests(b.path)
    const rows = lbRows(b.path)
    expect(readDb(b.path, tableNames)).toEqual([...LEGACY, ...SERVING, 'sqlite_sequence'].sort())
    const rep = dropLegacyBoardFile(job(b))
    expect(rep).toMatchObject({
      ok: true,
      dryRun: false,
      forced: false,
      plan: LEGACY,
      dropped: LEGACY,
      unknownTables: [],
      convertedAt: AT,
      rolledForwardAt: null,
      windowEndsAt: AT + DROP_LEGACY_WINDOW_MS,
    })
    expect(rep.reason).toBeUndefined()
    expect(rep.bytesAfter).toBeLessThan(rep.bytesBefore)
    expect(readDb(b.path, tableNames)).toEqual([...SERVING, 'sqlite_sequence'])
    expect(servingDigests(b.path)).toEqual(before)
    expect(lbRows(b.path)).toEqual(rows)
    // the new build still serves it; R0 refuses it (a rollback is no longer possible)
    expect(boardFileState(b.path)).toBe('converted')
    expect(classifyBoardFile(b.path)).toBe('converted-without-tldraw')
    expect(onDisk(b)).toMatchObject({ ok: true, dropped: LEGACY })
    // a second run has nothing to do
    expect(dropLegacyBoardFile(job(b))).toMatchObject({
      ok: true,
      reason: 'nothing-to-drop',
      plan: [],
      dropped: [],
    })
    // the room's store recreates an empty lb_source on open (IF NOT EXISTS); that is not legacy
    const store = new BoardStore(b.path)
    expect(store.snapshotRows().filter((r) => !r.deleted)).toHaveLength(rows.size)
    store.close()
    expect(readDb(b.path, tableNames)).toContain('lb_source')
    expect(dropLegacyBoardFile(job(b))).toMatchObject({ ok: true, reason: 'nothing-to-drop', dropped: [] })
  })

  it('inside the window: refused and the file is as it was; `force` overrides it and says so', () => {
    const b = converted()
    const tables = readDb(b.path, tableNames)
    const rep = dropLegacyBoardFile(job(b, { now: AT + 6 * DAY + 23 * 3_600_000 }))
    expect(rep).toMatchObject({
      ok: false,
      reason: 'window',
      plan: LEGACY,
      dropped: [],
      windowEndsAt: AT + 7 * DAY,
    })
    expect(readDb(b.path, tableNames)).toEqual(tables)
    expect(onDisk(b)).toMatchObject({ ok: false, reason: 'window' })
    // the last millisecond of the window still refuses; the window's end does not
    expect(dropLegacyBoardFile(job(b, { now: AT + 7 * DAY - 1 })).reason).toBe('window')
    const forced = dropLegacyBoardFile(job(b, { now: AT + 1 * DAY, force: true }))
    expect(forced).toMatchObject({ ok: true, forced: true, dropped: LEGACY })
    expect(readDb(b.path, tableNames)).toEqual([...SERVING, 'sqlite_sequence'])
  })

  it('a dry run reports the plan and the verdict and writes nothing', () => {
    const b = converted()
    const tables = readDb(b.path, tableNames)
    const bytes = readDb(b.path, (db) => db.prepare('PRAGMA page_count').get())
    expect(dropLegacyBoardFile(job(b, { dryRun: true }))).toMatchObject({
      ok: true,
      dryRun: true,
      plan: LEGACY,
      dropped: [],
    })
    expect(dropLegacyBoardFile(job(b, { dryRun: true, now: AT + DAY }))).toMatchObject({
      ok: false,
      reason: 'window',
      dryRun: true,
      plan: LEGACY,
      dropped: [],
    })
    expect(readDb(b.path, tableNames)).toEqual(tables)
    expect(readDb(b.path, (db) => db.prepare('PRAGMA page_count').get())).toEqual(bytes)
    expect(onDisk(b)).toMatchObject({ dryRun: true })
  })

  it('never drops the tables of an unconverted board, forced or not', () => {
    const dataDir = tempDir()
    const boardId = 'b-drop-tldraw'
    const path = seedBoardRecords(dataDir, boardId, fixtureRecords('brainstorm'))
    const tables = readDb(path, tableNames)
    const b = { boardId, path, reportDir: join(dataDir, 'migration') }
    expect(dropLegacyBoardFile(job(b))).toMatchObject({ ok: false, reason: 'not-converted', dropped: [] })
    expect(dropLegacyBoardFile(job(b, { force: true }))).toMatchObject({ ok: false, reason: 'not-converted' })
    expect(readDb(path, tableNames)).toEqual(tables)
  })

  it('never drops the tables a pending roll-forward needs (R0 wrote the tldraw side), forced or not', () => {
    const b = converted()
    r0Edit(b.rooms, b.boardId, (txn) => {
      const n3 = txn.get('shape:note3') as TLRecord & { x: number }
      txn.set('shape:note3', { ...n3, x: n3.x + 10 } as TLRecord)
    })
    expect(boardFileState(b.path)).toBe('rollforward-needed')
    const tables = readDb(b.path, tableNames)
    expect(dropLegacyBoardFile(job(b))).toMatchObject({
      ok: false,
      reason: 'rollforward-pending',
      dropped: [],
    })
    expect(dropLegacyBoardFile(job(b, { force: true }))).toMatchObject({
      ok: false,
      reason: 'rollforward-pending',
    })
    expect(readDb(b.path, tableNames)).toEqual(tables)
  })

  it('a rolled-forward board: the window counts from the roll-forward too, and lb_prev_* go with the rest', () => {
    const b = converted(AT - 30 * DAY)
    r0Edit(b.rooms, b.boardId, (txn) => {
      const n3 = txn.get('shape:note3') as TLRecord & { x: number }
      txn.set('shape:note3', { ...n3, x: n3.x + 10 } as TLRecord)
    })
    const rf = rollForwardBoardFile(
      { kind: 'rollforward', boardId: b.boardId, path: b.path, reportDir: b.reportDir, at: AT },
      metrics,
    )
    expect(rf.ok).toBe(true)
    expect(rf.cycle).toBe(1)
    const prev = readDb(b.path, tableNames).filter((t) => t.startsWith('lb_prev_1_'))
    expect(prev).toHaveLength(5)
    const reportFile = join(b.reportDir, `${b.boardId}.rollforward.json`)
    expect(existsSync(reportFile)).toBe(true)
    // the conversion is 30 days old, the roll-forward just happened: refused
    const now = Date.now()
    const rep = dropLegacyBoardFile(job(b, { now }))
    expect(rep).toMatchObject({ ok: false, reason: 'window', convertedAt: AT - 30 * DAY })
    expect(rep.rolledForwardAt).toBeGreaterThan(now - 60_000)
    expect(rep.windowEndsAt).toBe((rep.rolledForwardAt as number) + DROP_LEGACY_WINDOW_MS)
    // 8 days later (the report's time is what dates the roll-forward)
    const eightDaysAgo = new Date(now - 8 * DAY)
    utimesSync(reportFile, eightDaysAgo, eightDaysAgo)
    const before = servingDigests(b.path)
    const dropped = dropLegacyBoardFile(job(b, { now }))
    expect(dropped.ok).toBe(true)
    expect(dropped.dropped).toEqual([...LEGACY, ...prev].sort())
    expect(readDb(b.path, tableNames)).toEqual([...SERVING, 'sqlite_sequence'])
    expect(servingDigests(b.path)).toEqual(before)
  })

  it('a converted board whose conversion cannot be dated: refused unless forced', () => {
    const b = converted()
    const db = new DatabaseSync(b.path)
    db.prepare("DELETE FROM lb_doc WHERE key = 'import'").run()
    db.close()
    expect(dropLegacyBoardFile(job(b))).toMatchObject({
      ok: false,
      reason: 'window-unknown',
      convertedAt: null,
      windowEndsAt: null,
      dropped: [],
    })
    expect(dropLegacyBoardFile(job(b, { force: true }))).toMatchObject({
      ok: true,
      forced: true,
      dropped: LEGACY,
    })
  })

  it('a board born on the new canvas has nothing legacy; a missing file is reported', () => {
    const dataDir = tempDir()
    const boardId = 'b-drop-born01'
    const path = boardDbPath(dataDir, boardId)
    makeBornAfterFile(path)
    const tables = readDb(path, tableNames)
    const b = { boardId, path, reportDir: join(dataDir, 'migration') }
    expect(dropLegacyBoardFile(job(b, { force: true }))).toMatchObject({
      ok: true,
      reason: 'nothing-to-drop',
      dropped: [],
    })
    expect(readDb(path, tableNames)).toEqual(tables)
    expect(
      dropLegacyBoardFile(
        job({ boardId: 'b-drop-none1', path: boardDbPath(dataDir, 'b-drop-none1'), reportDir: b.reportDir }),
      ),
    ).toMatchObject({ ok: false, reason: 'no-file' })
  })
})
