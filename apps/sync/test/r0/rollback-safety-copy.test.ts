// The rollback's safety copy (docs/EXCALIDRAW-MIGRATION.md §5.9 step 2, the runbook's B4 and gap G7): on
// the Excalidraw build, run-all in maintenance replaces the plan's `rollback-exports/<board>/<time>.json`
// (backup/run-all.ts says why). This holds the build to it: after Excalidraw-era edits and a roll-forward
// cycle, every lb_* table of the copy (lb_prev_1_* included), its indexes and AUTOINCREMENT counters have
// the live file's digests, the entry is described from the lb_* state (`lobby-elements-converted`, the
// lb_* digest as recordsSha256), held 90 days, and the run says maintenance was on from start to end.
import { join } from 'node:path'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import { ElementBackups } from '../../src/backup/element-backups.ts'
import { setBackupEngine } from '../../src/backup/engine.ts'
import { createRunAll } from '../../src/backup/run-all.ts'
import { lbFileFacts } from '../../src/r0/lb-files.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { tempData } from '../backup/offsite-fixtures.ts'
import {
  excalidrawEdit,
  fixtureRecords,
  lbRows,
  makeBornAfterFile,
  r0Edit,
  readDb,
  seedBoardRecords,
} from '../migrate/board-files.ts'
import { lbState, tablesOf } from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const DAY = 86_400_000
const t0 = Date.UTC(2026, 9, 4, 9, 0)
const CONVERTED = 'b-rsc-conv001'
const BORN = 'b-rsc-born001'

afterEach(() => setBackupEngine('tldraw'))

describe('run-all in maintenance on the Excalidraw build is the rollback’s lb_* safety copy', () => {
  it('every lb_* table of the held copy has the live file’s digest, after edits and a roll-forward', async () => {
    setBackupEngine('excalidraw')
    const data = tempData('dr-rsc-')
    try {
      const path = seedBoardRecords(data.rooms, CONVERTED, fixtureRecords('kitchen-sink'))
      const reportDir = join(data.root, 'migration')
      expect(
        convertBoardFile(
          { kind: 'convert', boardId: CONVERTED, path, reportDir, backupKey: null, at: t0 },
          metrics,
        ).ok,
      ).toBe(true)
      // Excalidraw-era edits, then a rollback's R0 edit and the roll-forward (lb_prev_1_* appear)
      const first = [...lbRows(path).values()].find((r) => r.deleted === 0)?.id as string
      excalidrawEdit(path, first, ['pos'], (e) => {
        e.x = Number(e.x) + 7
      })
      r0Edit(data.rooms, CONVERTED, (txn) => {
        const n3 = txn.get('shape:note3') as TLRecord & { x: number }
        txn.set('shape:note3', { ...n3, x: n3.x + 10 } as TLRecord)
      })
      const rf = rollForwardBoardFile(
        { kind: 'rollforward', boardId: CONVERTED, path, reportDir, at: t0 + DAY },
        metrics,
      )
      expect(rf.ok).toBe(true)
      expect(rf.cycle).toBe(1)
      expect(tablesOf(path).filter((t) => t.startsWith('lb_prev_1_'))).toHaveLength(5)
      excalidrawEdit(path, first, ['pos'], (e) => {
        e.y = Number(e.y) + 3
      })
      const born = boardDbPath(data.rooms, BORN)
      makeBornAfterFile(born)

      let n = 0
      const eb = new ElementBackups({
        roomsDir: data.rooms,
        backupsDir: data.backups,
        now: () => new Date(t0 + 2 * DAY + n++ * 1_000),
      })
      const runAll = createRunAll({
        registry: eb,
        backups: { status: () => ({ store: 'off' }) as never, copyOffsite: async () => null },
        now: () => new Date(t0 + 2 * DAY),
        maintenance: () => true,
      })
      const report = await runAll.run()
      expect(report.ok).toBe(true)
      expect(report.inMaintenance).toBe(true)
      expect(report.boards.map((b) => [b.boardId, b.format])).toEqual([
        [BORN, 'lobby-elements'],
        [CONVERTED, 'lobby-elements-converted'],
      ])
      for (const row of report.boards) {
        const live = boardDbPath(data.rooms, row.boardId)
        const copy = join(data.backups, row.boardId, row.file as string)
        // the whole lb_* state, byte for byte: tables (lb_prev_* too), indexes, AUTOINCREMENT counters
        expect(lbState(copy)).toEqual(lbState(live))
        // described from it: the lb_* digest and lb_meta.clock, held 90 days
        const facts = readDb(live, lbFileFacts)
        expect(row.recordsSha256).toBe(facts.recordsSha256)
        expect(row.documentClock).toBe(facts.documentClock)
        expect(row.holdUntil).toBe(new Date(t0 + 2 * DAY + 90 * DAY).toISOString())
      }
      // the converted board's copy also carries the tldraw side R0 serves (the file is copied whole)
      const convCopy = join(data.backups, CONVERTED, report.boards[1]?.file as string)
      expect(tablesOf(convCopy)).toEqual(tablesOf(path))
    } finally {
      data.cleanup()
    }
  })
})
