// "Recently deleted" across a rollback (docs/EXCALIDRAW-MIGRATION.md open item 10, §5.4, §5.9 step h): R0
// manages its own `dr_deleted_*` during a rollback. Besides appending the rows of what it deletes (which
// the roll-forward already converted and appended), it REMOVES rows: a restore takes the restored shapes'
// rows out (deleted/store.ts removeRestored), and its trims drop whole old batches (trimNow). The
// roll-forward mirrors both into `lb_deleted`: a converted row whose source row R0 removed goes too, so an
// element restored during the rollback is not still listed as deleted, and a batch R0 trimmed is not
// offered again. Rows the Excalidraw build wrote itself (origin `live`) are never touched, whatever their
// batch number (a converted board's batch numbers overlap the room's). 2B. Failed on f336ae4 (the restored
// and the trimmed shapes' rows stayed in lb_deleted).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@tldraw/tlschema'
import { afterAll, describe, expect, it } from 'vitest'
import { DeletedStore } from '../../src/deleted/store.ts'
import { unregisterBornAfterCheck } from '../../src/r0/index.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import { RoomRegistry } from '../../src/rooms.ts'
import {
  addDeletedRows,
  excalidrawEdit,
  fixtureRecords,
  lbRows,
  r0Edit,
  readDb,
  seedBoardRecords,
} from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const suiteDir = mkdtempSync(join(tmpdir(), 'dr-rfdel-'))
afterAll(() => {
  unregisterBornAfterCheck()
  rmSync(suiteDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface LbDeletedRow {
  seq: number
  batch: number
  element_id: string
  data: string
  origin: string
  epoch: string
}
const lbDeleted = (path: string) =>
  readDb(path, (db) => db.prepare('SELECT * FROM lb_deleted ORDER BY seq').all() as unknown as LbDeletedRow[])
const drShapeIds = (path: string) =>
  readDb(path, (db) =>
    (
      db
        .prepare("SELECT record_id FROM dr_deleted_records WHERE kind = 'shape' ORDER BY seq")
        .all() as Array<{
        record_id: string
      }>
    ).map((r) => r.record_id),
  )
const owner = (elementId: string) => elementId.split('.')[0]

/** A tldraw delete as R0 leaves it: the record gone from `documents`, its row in "Recently deleted". */
function r0Delete(rooms: string, boardId: string, path: string, id: string) {
  let rec: TLRecord | undefined
  r0Edit(rooms, boardId, (txn) => {
    rec = txn.get(id)
    txn.delete(id)
  })
  addDeletedRows(path, [rec as TLRecord])
}

describe('roll-forward: R0 restores and trims in "Recently deleted"', () => {
  it('removes the converted rows R0 removed, appends the ones it added, and leaves every other row as it was', () => {
    const rooms = join(suiteDir, 'restore-trim', 'rooms')
    const boardId = 'b-rfdel0001'
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    // before the cut-over: three deletes on tldraw, one batch each (title 1, cloud 2, autotext 3)
    for (const id of ['shape:title', 'shape:cloud', 'shape:autotext']) r0Delete(rooms, boardId, path, id)
    const reportDir = join(rooms, '..', 'migration')
    expect(
      convertBoardFile({ kind: 'convert', boardId, path, reportDir, backupKey: null, at: 1 }, metrics).ok,
    ).toBe(true)
    const converted = lbDeleted(path)
    expect(new Set(converted.map((r) => owner(r.element_id)))).toEqual(
      new Set(['title', 'cloud', 'autotext']),
    )
    // on Excalidraw: pen1 deleted, with a batch number that collides with a converted batch
    excalidrawEdit(path, 'pen1', ['life'], (e) => {
      e.isDeleted = true
    })
    const cloudBatch = converted.find((r) => owner(r.element_id) === 'cloud')?.batch as number
    const db = new DatabaseSync(path)
    db.prepare(
      `INSERT INTO lb_deleted (batch, element_id, type, container_id, frame_id, data, deleted_by, deleted_by_name,
         deleted_at, epoch, origin) VALUES (?, 'pen1', 'freedraw', NULL, NULL, '{}', 'usr_a', 'A', 2, 'room-1', 'live')`,
    ).run(cloudBatch)
    db.close()
    const live = lbDeleted(path).filter((r) => r.origin === 'live')

    // the rollback: R0 restores the cloud (its own restore), trims to the newest batch, deletes tri
    const reg = new RoomRegistry({ dataDir: rooms, schema: draftroomSchema, backup: false })
    try {
      reg.getOrCreate(boardId)
      expect(reg.restoreDeleted(boardId, ['shape:cloud']).restored).toContain('shape:cloud')
    } finally {
      reg.closeAll()
    }
    const tdb = new DatabaseSync(path)
    try {
      const schemaId = (
        tdb.prepare('SELECT id FROM dr_deleted_schemas ORDER BY id LIMIT 1').get() as { id: number }
      ).id
      new DeletedStore({ db: tdb, schemaId, limits: { retainRecent: 1, hardCap: 1 } }).trimNow()
    } finally {
      tdb.close()
    }
    r0Delete(rooms, boardId, path, 'shape:tri')
    expect(drShapeIds(path)).toEqual(['shape:autotext', 'shape:tri'])

    const rep = rollForwardBoardFile({ kind: 'rollforward', boardId, path, reportDir, at: 3 }, metrics)
    expect(rep).toMatchObject({ ok: true })
    const after = lbDeleted(path)
    const owners = (rows: LbDeletedRow[]) =>
      rows.filter((r) => r.origin === 'converted').map((r) => owner(r.element_id))
    // the restored cloud and the trimmed title are no longer listed; autotext stays; tri is appended
    expect(new Set(owners(after))).toEqual(new Set(['autotext', 'tri']))
    // autotext's rows are byte-identical (same seq, batch and data), and so is the Excalidraw build's own row
    const keep = (rows: LbDeletedRow[]) => rows.filter((r) => owner(r.element_id) === 'autotext')
    expect(keep(after)).toEqual(keep(converted))
    expect(after.filter((r) => r.origin === 'live')).toEqual(live)
    // the cloud is on the board again
    expect(lbRows(path).get('cloud')?.deleted).toBe(0)
    const removed = converted.filter((r) => ['title', 'cloud'].includes(owner(r.element_id) as string)).length
    expect(rep.counts.deletedRowsRemoved).toBe(removed)
    // and dr_deleted_* was only read
    expect(drShapeIds(path)).toEqual(['shape:autotext', 'shape:tri'])
  })

  it('a second cycle mirrors a restore of a row the first roll-forward appended', () => {
    const rooms = join(suiteDir, 'second-cycle', 'rooms')
    const boardId = 'b-rfdel0002'
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    const reportDir = join(rooms, '..', 'migration')
    expect(
      convertBoardFile({ kind: 'convert', boardId, path, reportDir, backupKey: null, at: 1 }, metrics).ok,
    ).toBe(true)
    // rollback 1: R0 deletes tri; roll-forward 1 appends its row
    r0Delete(rooms, boardId, path, 'shape:tri')
    expect(rollForwardBoardFile({ kind: 'rollforward', boardId, path, reportDir, at: 2 }, metrics).ok).toBe(
      true,
    )
    expect(lbDeleted(path).map((r) => owner(r.element_id))).toContain('tri')
    // rollback 2: R0 restores tri
    const reg = new RoomRegistry({ dataDir: rooms, schema: draftroomSchema, backup: false })
    try {
      reg.getOrCreate(boardId)
      expect(reg.restoreDeleted(boardId, ['shape:tri']).restored).toContain('shape:tri')
    } finally {
      reg.closeAll()
    }
    const rep = rollForwardBoardFile({ kind: 'rollforward', boardId, path, reportDir, at: 3 }, metrics)
    expect(rep).toMatchObject({ ok: true, cycle: 2 })
    expect(lbDeleted(path).map((r) => owner(r.element_id))).not.toContain('tri')
    expect(lbRows(path).get('tri')?.deleted).toBe(0)
  })
})
