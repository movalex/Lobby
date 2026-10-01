// The roll-forward's z-order keys against a key share the room admits (docs/EXCALIDRAW-MIGRATION.md §5.9
// step g: repair, or refuse with nothing written; never a board that cannot open). 2B, from V3's re-check
// of the spike B fix round (medium): 3390b0c's key check failed the whole roll-forward with
// INDEX_DUPLICATE whenever an element the merge wrote kept a key it shares with a tombstone, although the
// merge did not make that key. The room's index cache holds live elements only, so a raw push can move a
// live element onto a deleted element's key (V3's low, the room's: 2A); after a rollback, an R0 recolour
// or move of that element then left the board refused with 4099 CONVERSION_FAILED. These cases failed on
// beff59d (recolour, move: `validation`, [{id:'rect', code:'INDEX_DUPLICATE'}]) and pass here.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTableTextMetrics,
  indexKeyBetween,
  installServerTextMetrics,
} from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@draftroom/tldraw-import/tldraw'
import { afterAll, describe, expect, it } from 'vitest'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import {
  excalidrawCreate,
  excalidrawEdit,
  fixtureRecords,
  type LbRow,
  lbRows,
  r0Edit,
  seedBoardRecords,
} from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const suiteDir = mkdtempSync(join(tmpdir(), 'dr-rfkeys-'))
afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

type Variant = 'recolour' | 'move' | 'delete' | 'untouched' | 'no-share'
let n = 0

/**
 * A converted kitchen sink; on the Excalidraw side a tombstone `v3tomb` at key kT (created, then deleted),
 * and (unless `no-share`) `rect` moved onto kT by a stale client, as the room stores it; then R0 edits
 * `rect` (or another shape), and the board rolls forward.
 */
function scenario(variant: Variant, tombId = 'v3tomb') {
  const rooms = join(suiteDir, `${variant}-${n}`, 'rooms')
  const boardId = `b-rfkeys${String(n++).padStart(4, '0')}`
  const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
  const reportDir = join(rooms, '..', 'migration')
  expect(
    convertBoardFile({ kind: 'convert', boardId, path, reportDir, backupKey: null, at: 1 }, metrics).ok,
  ).toBe(true)
  const rows = lbRows(path)
  const sData = JSON.parse(rows.get('rect')?.data ?? '{}') as Record<string, unknown>
  const top = [...rows.values()]
    .map((r) => r.idx)
    .sort()
    .at(-1) as string
  const kT = indexKeyBetween(top, null)
  excalidrawCreate(path, {
    ...sData,
    id: tombId,
    index: kT,
    version: 1,
    boundElements: null,
    groupIds: [],
    frameId: null,
  })
  excalidrawEdit(path, tombId, ['life'], (e) => {
    e.isDeleted = true
  })
  if (variant !== 'no-share') {
    // a stale client (it never saw the tombstone) brings `rect` to the front: generateKeyBetween(top,
    // null) is deterministic, so it picks kT, and the room stores it (its index cache holds live elements)
    excalidrawEdit(path, 'rect', ['z'], (e) => {
      e.index = kT
    })
    // the room keeps a label after its container
    if (rows.has('rect.t'))
      excalidrawEdit(path, 'rect.t', ['z'], (e) => {
        e.index = indexKeyBetween(kT, null)
      })
  }
  const before = lbRows(path)
  if (variant !== 'no-share') expect(before.get('rect')?.idx).toBe(before.get(tombId)?.idx)
  r0Edit(rooms, boardId, (txn) => {
    const r = txn.get('shape:rect') as TLRecord & { props: Record<string, unknown>; x: number }
    if (variant === 'recolour' || variant === 'no-share')
      txn.set('shape:rect', {
        ...r,
        props: { ...r.props, color: r.props.color === 'red' ? 'blue' : 'red' },
      } as TLRecord)
    else if (variant === 'move') txn.set('shape:rect', { ...r, x: r.x + 40 } as TLRecord)
    else if (variant === 'delete') txn.delete('shape:rect')
    else {
      const other = txn.get('shape:diamond') as (TLRecord & { x: number }) | undefined
      if (other) txn.set('shape:diamond', { ...other, x: other.x + 40 } as TLRecord)
    }
  })
  const rep = rollForwardBoardFile({ kind: 'rollforward', boardId, path, reportDir, at: 2 }, metrics)
  return { rep, before, after: lbRows(path), kT, tombId }
}

/** Paint order as the room serves it: `(idx, id)`. */
const order = (rows: Map<string, LbRow>, live = true) =>
  [...rows.values()]
    .filter((r) => !live || r.deleted === 0)
    .sort((a, b) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : a.id < b.id ? -1 : 1))
    .map((r) => r.id)

describe('roll-forward: a key the room let a live element share with a tombstone', () => {
  for (const variant of ['recolour', 'move', 'delete'] as const)
    it(`R0 ${variant}s the element: the merge repairs the share and the board opens`, () => {
      const { rep, before, after, kT, tombId } = scenario(variant)
      expect(rep.failures).toEqual([])
      expect(rep).toMatchObject({ ok: true })
      // the written element got a key of its own, next to the shared one; the tombstone is untouched
      expect(after.get('rect')?.idx).not.toBe(kT)
      expect(after.get(tombId)).toEqual(before.get(tombId))
      expect(rep.repaired).toContainEqual({ id: 'rect', code: 'index-shared' })
      // every key unique, tombstones included
      const keys = [...after.values()].map((r) => r.idx)
      expect(new Set(keys).size).toBe(keys.length)
      // and the paint order of the live elements is the room's (rect stays where it was drawn)
      expect(order(after)).toEqual(order(before).filter((id) => after.get(id)?.deleted === 0))
      if (variant === 'delete') expect(after.get('rect')?.deleted).toBe(1)
    })

  it('the room orders a tie by id: a written element whose id sorts first goes just below the key', () => {
    // `a-tomb` sorts before `rect`: the room draws rect after it, so rect moves just above the shared key
    const above = scenario('recolour', 'a-tomb')
    expect(above.rep.ok).toBe(true)
    expect((above.after.get('rect')?.idx ?? '') > above.kT).toBe(true)
    // `z-tomb` sorts after `rect`: rect is drawn first, so it moves just below the shared key
    const below = scenario('recolour', 'z-tomb')
    expect(below.rep.ok).toBe(true)
    expect((below.after.get('rect')?.idx ?? '') < below.kT).toBe(true)
    for (const s of [above, below]) {
      const keys = [...s.after.values()].map((r) => r.idx)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('a share between elements the merge does not write is left as the room stores it (not a refusal)', () => {
    const { rep, before, after, kT, tombId } = scenario('untouched')
    expect(rep).toMatchObject({ ok: true })
    expect(after.get('rect')).toEqual(before.get('rect'))
    expect(after.get('rect')?.idx).toBe(kT)
    expect(after.get(tombId)?.idx).toBe(kT)
    expect(rep.repaired).toEqual([])
  })

  it('control: without a share nothing is re-keyed', () => {
    const { rep, before, after } = scenario('no-share')
    expect(rep).toMatchObject({ ok: true, repaired: [] })
    expect(after.get('rect')?.idx).toBe(before.get('rect')?.idx)
  })
})
