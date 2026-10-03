// M3P3: "Recently deleted" groups `lb_deleted` rows by (origin, batch), not by batch number alone
// (room-internal/deleted.ts). A converted board's rows keep tldraw's batch numbers (convert-board.ts,
// rollforward.ts), and those overlap the room's clocks: before, a converted frame and an unrelated live
// deletion of the same number were one batch, so the live row could be hidden as the frame's child, counted
// in its "objects inside" and brought back by restoring the frame.
//
// In-process, on the room's BoardStore (room/store.ts): the list reader and the restore's apply, as the
// routes and the room's server write call them. No storage rewrite: the rows stay as they are.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerWriteTx } from '../../src/engine-switch.ts'
import { BoardStore } from '../../src/room/store.ts'
import { applyRestore, listDeleted } from '../../src/room-internal/deleted.ts'
import { type El, frame, rect } from '../element-room/support/elements.ts'

let dirs: string[] = []
let stores: BoardStore[] = []
afterEach(() => {
  for (const s of stores) s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  stores = []
})

function board(): BoardStore {
  const d = mkdtempSync(join(tmpdir(), 'dr-lbdel-batch-'))
  dirs.push(d)
  const s = new BoardStore(join(d, 'board.sqlite'))
  stores.push(s)
  return s
}

/** The element's row in lb_elements (a tombstone when `isDeleted`). */
function put(s: BoardStore, el: El, clock = 1): void {
  s.upsert({
    el: el as never,
    clock,
    gclock: {},
    deletedClock: el.isDeleted ? clock : null,
    deletedAt: el.isDeleted ? 1_000 : null,
  })
}

/** A live deletion row, as the room writes it (origin `live`, the push's clock as the batch). */
function liveRow(s: BoardStore, batch: number, el: El): void {
  s.insertDeleted({
    batch,
    el: el as never,
    deletedBy: 'ann',
    deletedByName: 'Ann',
    deletedAt: 2_000 + batch,
    session: 'room-session',
  })
}

/** A converted row, as convert-board.ts and the roll-forward write it (origin `converted`, tldraw's batch). */
function convertedRow(s: BoardStore, batch: number, el: El): void {
  s.db
    .prepare(
      `INSERT INTO lb_deleted (batch, element_id, type, container_id, frame_id, data, deleted_by, deleted_by_name,
         deleted_at, epoch, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'converted')`,
    )
    .run(
      batch,
      el.id,
      el.type,
      null,
      el.frameId ?? null,
      JSON.stringify(el),
      'bob',
      'Bob',
      1_000,
      'tl-session',
    )
}

const BATCH = 7

describe('lb_deleted batches are (origin, batch) (M3P3)', () => {
  it('a live deletion that shares a converted batch number is its own entry, never a converted frame’s child', () => {
    const s = board()
    // On the new canvas a note N inside frame F was deleted at clock 7; the board was rolled back, R0
    // deleted F (tldraw batch 7), and the roll-forward appended that batch as converted rows. F's newest
    // row is the converted one, N's is the live one, and both say batch 7.
    const F = frame('F', { x: 0, y: 0, index: 'a0', isDeleted: true, name: 'Ideas' })
    const C = rect('C', { x: 20, y: 20, index: 'a1', frameId: 'F', isDeleted: true })
    const N = rect('N', { x: 300, y: 20, index: 'a2', frameId: 'F', isDeleted: true })
    put(s, F)
    put(s, C)
    put(s, N)
    liveRow(s, BATCH, N)
    convertedRow(s, BATCH, F)
    convertedRow(s, BATCH, C)

    const { entries, total } = listDeleted(s.db, 100)
    expect(total).toBe(2)
    expect(entries.map((e) => [e.shapeId, e.type, e.childCount, e.deletedBy.id])).toEqual([
      ['shape:F', 'frame', 1, 'bob'], // C only: N was not deleted with F
      ['shape:N', 'geo', 0, 'ann'],
    ])

    // restoring F brings back what was deleted with it (C), never N
    s.begin()
    const tx: ServerWriteTx = { store: s, clock: 20, now: 5_000 }
    const out = applyRestore(tx, ['shape:F'])
    s.commit()
    expect([...out.result.restored].sort()).toEqual(['shape:C', 'shape:F'])
    expect(s.get('N')?.el.isDeleted).toBe(true)
    expect(s.get('C')?.el.isDeleted).toBe(false)
    expect(listDeleted(s.db, 100).entries.map((e) => e.shapeId)).toEqual(['shape:N'])
  })

  it('a live deletion inside a frame that came back from a converted batch of the same number is listed', () => {
    const s = board()
    // F came back (restored) after the conversion; its newest row is still the converted one. N, inside
    // F, was deleted live at clock 7: before, the converted F of "batch 7" hid N as its child.
    const F = frame('F', { x: 0, y: 0, index: 'a0', name: 'Ideas' })
    const N = rect('N', { x: 20, y: 20, index: 'a1', frameId: 'F', isDeleted: true })
    put(s, F)
    put(s, N)
    convertedRow(s, BATCH, { ...F, isDeleted: true })
    liveRow(s, BATCH, N)
    expect(listDeleted(s.db, 100).entries.map((e) => [e.shapeId, e.deletedBy.id])).toEqual([
      ['shape:N', 'ann'],
    ])
  })

  it('rows of one origin and one batch number are still one batch', () => {
    const s = board()
    const F = frame('F', { x: 0, y: 0, index: 'a0', isDeleted: true, name: 'Ideas' })
    const C = rect('C', { x: 20, y: 20, index: 'a1', frameId: 'F', isDeleted: true })
    put(s, F)
    put(s, C)
    liveRow(s, BATCH, F)
    liveRow(s, BATCH, C)
    expect(listDeleted(s.db, 100).entries.map((e) => [e.shapeId, e.childCount])).toEqual([['shape:F', 1]])
  })
})
