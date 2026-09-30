// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.9 step 2): a staged restore of a CONVERTED board
// during a rollback puts the backup's tldraw side in place and keeps the live board's new-canvas tables
// (lb_*) as they are. It used to replace the file whole, so the Excalidraw-era edits, lb_deleted and
// lb_prev_* survived only in the .pre-restore copy, with no warning, and the roll-forward would have
// converted the board afresh (verifier, staged-restore-converted).
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeBoardDb, inspectBoardDb } from '../../src/backup/backup.ts'
import { fileBackupSource } from '../../src/backup/drill.ts'
import { applyStagedRestores, stageRestore } from '../../src/backup/staged-restore.ts'
import { classifyBoardFile } from '../../src/r0/born-after.ts'
import { boardDbPath, RoomRegistry } from '../../src/rooms.ts'
import { type TempData, tempData } from '../backup/offsite-fixtures.ts'
import { note, RoomClient } from '../deleted/fixtures.ts'
import {
  ALL_LB_TABLES,
  CONVERTED_FROM,
  lbState,
  markConverted,
  seedTldrawBoard,
  tablesOf,
} from './support.ts'

const BOARD = 'b-restconv1'
let data: TempData

beforeEach(() => {
  data = tempData('dr-r0-restconv-')
  mkdirSync(data.rooms, { recursive: true })
})
afterEach(() => data.cleanup())

const tldrawIds = (path: string) => [...describeBoardDb(path).records.keys()].sort()

async function stageAndApply(backupPath: string) {
  const staged = await stageRestore({
    dataDir: data.root,
    source: fileBackupSource(backupPath),
    boardId: BOARD,
  })
  const results = await applyStagedRestores({ dataDir: data.root })
  return { staged, results }
}

describe('a staged restore over a converted board', () => {
  it('keeps every lb_* table, index and counter of the live board, and restores the tldraw side', async () => {
    const live = seedTldrawBoard(data.rooms, BOARD, [note('n1', 'before the cut-over') as TLRecord])
    const preCutover = join(data.root, 'pre-cutover.sqlite')
    copyFileSync(live, preCutover)
    markConverted(live)
    // edits on R0 during the rollback (the tldraw side)
    const reg = new RoomRegistry({ dataDir: data.rooms, schema: draftroomSchema, backup: false })
    try {
      const c = new RoomClient(reg.getOrCreate(BOARD), 'usr_a')
      await c.connect()
      await c.put(note('n2', 'during the rollback'))
    } finally {
      reg.closeAll()
    }
    const lbBefore = lbState(live)
    const liveClock = inspectBoardDb(live).documentClock
    expect(Object.keys(lbBefore.lb).sort()).toEqual([...ALL_LB_TABLES])

    const { staged, results } = await stageAndApply(preCutover)
    expect(staged.checks.join('\n')).toContain('new-canvas (lb_*) tables are carried over unchanged')
    expect(results).toEqual([
      { boardId: BOARD, ok: true, message: expect.stringContaining('new-canvas tables were carried over') },
    ])
    // the new-canvas side is exactly the live board's; the tldraw side is the backup's
    expect(lbState(live)).toEqual(lbBefore)
    expect(classifyBoardFile(live)).toBe('converted')
    expect(tldrawIds(live)).toEqual(tldrawIds(preCutover))
    expect(tldrawIds(live)).not.toContain('shape:n2')
    // the roll-forward sees a tldraw side edited during the rollback (clock past converted_from's)
    const clock = inspectBoardDb(live).documentClock
    expect(clock).toBeGreaterThan(liveClock)
    expect(clock).toBeGreaterThan(CONVERTED_FROM.documentClock)
    // the previous file is kept as before
    expect(readdirSync(data.rooms).filter((f) => f.includes('.pre-restore-'))).toHaveLength(1)
    // and the board opens in R0 as a converted board
    const again = new RoomRegistry({ dataDir: data.rooms, schema: draftroomSchema, backup: false })
    try {
      expect(again.snapshot(BOARD)?.documents.map((d) => d.state.id)).toContain('shape:n1')
    } finally {
      again.closeAll()
    }
    expect(lbState(live)).toEqual(lbBefore)
  })

  it("replaces an older backup's own lb_* tables with the live board's newer ones", async () => {
    const live = seedTldrawBoard(data.rooms, BOARD, [note('n1', 'x') as TLRecord])
    markConverted(live)
    const older = join(data.root, 'converted-era.sqlite')
    copyFileSync(live, older)
    // the new canvas moved on after that backup (a roll-forward cycle): newer lb_* rows in the live file
    const db = new DatabaseSync(live)
    try {
      db.prepare(
        "INSERT INTO lb_elements (id, clock, idx, deleted, type, version, gclock, data) VALUES ('r9', 9, 'a9', 0, 'rectangle', 1, '{}', '{}')",
      ).run()
      db.prepare("UPDATE lb_meta SET value = '9' WHERE key = 'clock'").run()
      db.exec('DELETE FROM lb_deleted')
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
    const lbBefore = lbState(live)
    expect(lbBefore).not.toEqual(lbState(older))
    const { results } = await stageAndApply(older)
    expect(results[0]?.ok).toBe(true)
    expect(lbState(live)).toEqual(lbBefore)
    expect(tablesOf(live)).toEqual(tablesOf(older))
  })

  it('a plain tldraw board is restored exactly as before (no lb_* table appears)', async () => {
    const live = seedTldrawBoard(data.rooms, BOARD, [note('n1', 'x') as TLRecord])
    const backup = join(data.root, 'plain.sqlite')
    copyFileSync(live, backup)
    const { results } = await stageAndApply(backup)
    expect(results[0]?.ok).toBe(true)
    expect(results[0]?.message).not.toContain('new-canvas')
    expect(tablesOf(live).some((t) => t.startsWith('lb_'))).toBe(false)
    expect(boardDbPath(data.rooms, BOARD)).toBe(live)
  })
})
