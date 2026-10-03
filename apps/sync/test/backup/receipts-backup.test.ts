// W5-ENG-2 (wave C, C2; CONTRACTS_REV 11): the board file's push receipts (room/schema.ts lb_receipts) in
// the backups. The table is an lb_* table, so the local and offsite backups copy it with the file, the
// manifest digest covers it, and the restore drill reproduces it. It is made in the first batch that
// records a receipt, never by an open alone: the drill's live check fails a board whose live file has the
// backup's clock but other records, which an open-time CREATE TABLE would have done to every board opened
// after the deploy and not written since its last backup.
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createFsBlobStore } from '@draftroom/blob-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectBoardDb } from '../../src/backup/backup.ts'
import { runRestoreDrill, storeBackupSource } from '../../src/backup/drill.ts'
import { ElementBackups } from '../../src/backup/element-backups.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'
import { BoardStore } from '../../src/room/store.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { makeBornAfterFile } from '../migrate/board-files.ts'
import { type TempData, tempData } from './offsite-fixtures.ts'

const BOARD = 'b-rcpt-bk001'
const key = backupSigningKey(TEST_INTERNAL_SECRET)

let data: TempData
beforeEach(() => {
  data = tempData('dr-rcpt-')
  mkdirSync(data.rooms, { recursive: true })
})
afterEach(() => {
  data.cleanup()
})

/** One room batch on the file: a move of r1 at the next clock, with this push's receipt (as the drain writes). */
function writeWithReceipt(path: string, rid: string): number {
  const store = new BoardStore(path)
  try {
    const clock = store.meta.clock + 1
    const row = store.get('r1')
    if (!row) throw new Error('no r1')
    store.begin()
    store.upsert({
      el: { ...row.el, x: clock, version: row.version + 1 } as never,
      clock,
      gclock: { ...row.gclock, pos: clock },
      deletedClock: null,
      deletedAt: null,
    })
    store.putReceipts([{ uid: 'alice', rid, clock }], 1_000 + clock)
    store.setClock(clock)
    store.commit()
    store.meta.clock = clock
    return clock
  } finally {
    store.close()
  }
}

const receiptRows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT uid, rid, clock FROM lb_receipts ORDER BY uid, rid').all()
  } finally {
    db.close()
  }
}

describe('push receipts in the backups (W5-ENG-2)', () => {
  it('an open of a pre-rev-11 board file changes nothing: the drill still finds the live board identical', async () => {
    const path = boardDbPath(data.rooms, BOARD)
    makeBornAfterFile(path)
    const eb = new ElementBackups({ roomsDir: data.rooms, backupsDir: data.backups })
    await eb.runPass()
    const before = inspectBoardDb(path)
    // the room opens the file (and a receipts query reads it): no table is made, nothing changes
    const store = new BoardStore(path)
    expect(store.receipts('alice', ['p.1'])).toEqual({ landed: {}, from: 0 })
    store.close()
    expect(inspectBoardDb(path)).toEqual(before)
    const drill = await runRestoreDrill({ dataDir: data.root, boardIds: [BOARD] })
    expect(drill.boards.map((b) => [b.boardId, b.ok, b.live, b.problems])).toEqual([
      [BOARD, true, 'identical', []],
    ])
  })

  it('a backup after a receipt holds the table; the drill restores it with the digest, locally and offsite', async () => {
    const path = boardDbPath(data.rooms, BOARD)
    makeBornAfterFile(path)
    const clock = writeWithReceipt(path, 'pg1.1')
    expect(receiptRows(path)).toEqual([{ uid: 'alice', rid: 'pg1.1', clock }])
    const eb = new ElementBackups({ roomsDir: data.rooms, backupsDir: data.backups })
    const entry = await eb.backupFresh(BOARD)
    expect(entry.documentClock).toBe(clock)
    const local = await runRestoreDrill({ dataDir: data.root, boardIds: [BOARD] })
    expect(local.boards.map((b) => [b.boardId, b.ok, b.live, b.problems])).toEqual([
      [BOARD, true, 'identical', []],
    ])
    // the restored copy answers the same receipts (the drill opened it through the room's store)
    const restored = local.boards[0]
    expect(restored?.checks.some((c) => c.startsWith("opened through the element room's store"))).toBe(true)
    const store = createFsBlobStore(data.blobs)
    const offsite = new OffsiteBackups({ store, localRoot: data.backups, signingKey: key })
    await offsite.runPass()
    const remote = await runRestoreDrill({
      dataDir: data.root,
      source: storeBackupSource(store, { signingKey: key }),
    })
    expect(remote.ok).toBe(true)
    expect(remote.boards.map((b) => [b.boardId, b.ok])).toEqual([[BOARD, true]])
    // a later receipt moves the clock with the records: the next pass backs it up, the drill agrees
    writeWithReceipt(path, 'pg1.2')
    await eb.runPass()
    const again = await runRestoreDrill({ dataDir: data.root, boardIds: [BOARD] })
    expect(again.boards.map((b) => [b.ok, b.live])).toEqual([[true, 'identical']])
  })
})
