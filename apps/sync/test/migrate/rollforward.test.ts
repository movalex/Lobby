// The record-level roll-forward (docs/EXCALIDRAW-MIGRATION.md §5.9, §6.1 "Roll-forward merge", §8.3 B8
// "Rollback drill" in-process): convert → Excalidraw edits (A) → R0 edits on the tldraw tables (B: an add,
// a delete, a z-order change, an edit on page 2, a frame move while A moved one of its children, a planted
// same-group conflict) → roll forward → a second cycle against the refreshed lb_source.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@tldraw/tlschema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unregisterBornAfterCheck } from '../../src/r0/index.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { lbDigests, recordsSha256, tableDigest } from '../../src/room/migrate/digest.ts'
import { rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import { boardFileState } from '../../src/room/migrate/service.ts'
import type { ConvertedFrom } from '../../src/room/schema.ts'
import {
  excalidrawCreate,
  excalidrawEdit,
  fixtureRecords,
  lbRows,
  r0Edit,
  readDb,
  seedBoardRecords,
} from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const suiteDir = mkdtempSync(join(tmpdir(), 'dr-rf-'))
afterAll(() => {
  unregisterBornAfterCheck()
  rmSync(suiteDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const el = (path: string, id: string) => {
  const r = lbRows(path).get(id)
  return r ? { row: r, e: JSON.parse(r.data) as Record<string, unknown> } : null
}
const cfOf = (path: string) =>
  readDb(
    path,
    (db) =>
      JSON.parse(
        (db.prepare("SELECT value FROM lb_meta WHERE key = 'converted_from'").get() as { value: string })
          .value,
      ) as ConvertedFrom,
  )

describe('the rollback drill, in-process', () => {
  let rooms = ''
  let path = ''
  const boardId = 'b-drill0001'
  let converted = new Map<string, ReturnType<typeof lbRows> extends Map<string, infer R> ? R : never>()

  beforeAll(() => {
    rooms = join(suiteDir, 'rooms')
    path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    const rep = convertBoardFile(
      {
        kind: 'convert',
        boardId,
        path,
        reportDir: join(rooms, '..', 'migration'),
        backupKey: null,
        at: 1_759_017_600_000,
      },
      metrics,
    )
    expect(rep.ok).toBe(true)
    converted = lbRows(path)
  })

  it('cycle 1: every edit of both sides is kept, the conflict is listed and kept in lb_prev_1_*, untouched rows are byte-identical', () => {
    const orig = (id: string) => JSON.parse(converted.get(id)?.data ?? '{}') as { x: number; y: number }
    // ---- A: edits on Excalidraw
    excalidrawEdit(path, 'note2', ['pos'], (e) => {
      e.x = (e.x as number) + 100
    })
    excalidrawEdit(path, 'rect', ['style'], (e) => {
      e.backgroundColor = '#abcdef'
    })
    excalidrawEdit(path, 'note3', ['style'], (e) => {
      e.backgroundColor = '#111111'
    })
    excalidrawEdit(path, 'autotext', ['life'], (e) => {
      e.isDeleted = true
    })
    excalidrawCreate(path, {
      ...JSON.parse(converted.get('rect')?.data ?? '{}'),
      id: 'excal1',
      x: 5_000,
      y: 5_000,
      boundElements: null,
      customData: undefined,
      index: `${converted.get('rect')?.idx}V`,
      version: 1,
    })
    const lbBeforeR0 = readDb(path, lbDigests)

    // ---- B: edits on R0 (the tldraw tables), through today's registry with the stand-in's check
    r0Edit(rooms, boardId, (txn) => {
      const rect = txn.get('shape:rect') as TLRecord & Record<string, unknown>
      txn.set('shape:r0new', {
        ...rect,
        id: 'shape:r0new',
        x: 3_000,
        y: 3_000,
        index: 'aH',
        meta: {},
      } as TLRecord)
      txn.delete('shape:tri')
      const line = txn.get('shape:line1') as TLRecord
      txn.set('shape:line1', { ...line, index: 'a0' } as TLRecord)
      const img = txn.get('shape:img1') as TLRecord & { x: number }
      txn.set('shape:img1', { ...img, x: img.x + 50 } as TLRecord)
      const frame = txn.get('shape:frameA') as TLRecord & { x: number }
      txn.set('shape:frameA', { ...frame, x: frame.x + 200 } as TLRecord)
      const n3 = txn.get('shape:note3') as TLRecord & { props: Record<string, unknown> }
      txn.set('shape:note3', { ...n3, props: { ...n3.props, color: 'red' } } as TLRecord)
    })
    // R0 never wrote an lb_* table while serving
    expect(readDb(path, lbDigests)).toEqual(lbBeforeR0)
    expect(boardFileState(path)).toBe('rollforward-needed')
    const oursBefore = lbRows(path)

    // ---- roll forward
    const rep = rollForwardBoardFile(
      {
        kind: 'rollforward',
        boardId,
        path,
        reportDir: join(rooms, '..', 'migration'),
        at: 1_759_100_000_000,
      },
      metrics,
    )
    expect(rep.reason).toBeUndefined()
    expect(rep.ok).toBe(true)
    expect(rep.cycle).toBe(1)
    expect(rep.counts).toMatchObject({ created: 1, deleted: 1 })
    expect(rep.conflicts).toEqual([{ elementId: 'note3', group: 'style' }])

    // A's edits
    expect(el(path, 'rect')?.e.backgroundColor).toBe('#abcdef')
    expect(el(path, 'autotext')?.row.deleted).toBe(1)
    expect(el(path, 'excal1')?.row).toEqual(oursBefore.get('excal1'))
    // the frame move composes with A's move of its child: +100 (A) +200 (B)
    expect(el(path, 'note2')?.e.x).toBeCloseTo(orig('note2').x + 300, 6)
    expect(el(path, 'frameA')?.e.x).toBeCloseTo(orig('frameA').x + 200, 6)
    // B's edits: the add, the delete, the z-order change, the page-2 edit, and B's colour in the conflict
    const added = el(path, 'r0new')
    expect(added?.row.deleted).toBe(0)
    expect(el(path, 'tri')?.row.deleted).toBe(1)
    expect(el(path, 'tri.o')?.row.deleted).toBe(1)
    expect(el(path, 'img1')?.e.x).toBeCloseTo(orig('img1').x + 50, 6)
    expect(el(path, 'note3')?.e.backgroundColor).toBe('#ef8c82')
    // the line went to the bottom of its page (B's re-order), z-order otherwise as A left it
    const idx = (id: string) => lbRows(path).get(id)?.idx ?? ''
    expect(idx('line1') < idx('frameA')).toBe(true)
    const kept = [...oursBefore.values()]
      .filter((r) => r.id !== 'line1' && r.id !== 'line1.t')
      .map((r) => r.id)
    const sorted = (ids: string[]) => [...ids].sort((a, b) => (idx(a) < idx(b) ? -1 : 1))
    const oursOrder = [...kept].sort((a, b) =>
      (oursBefore.get(a)?.idx ?? '') < (oursBefore.get(b)?.idx ?? '') ? -1 : 1,
    )
    expect(sorted(kept)).toEqual(oursOrder)
    // ours' value of the conflict is kept in lb_prev_1_elements
    const prev = readDb(
      path,
      (db) => db.prepare("SELECT data FROM lb_prev_1_elements WHERE id = 'note3'").get() as { data: string },
    )
    expect(JSON.parse(prev.data).backgroundColor).toBe('#111111')
    // untouched elements are byte-identical to their pre-merge rows
    // B's records, frameA and every element inside it (the frame move composes onto them), and the arrows
    // bound to anything that moved (re-snapped)
    const inFrame = [...oursBefore.values()]
      .filter((r) => JSON.parse(r.data).frameId === 'frameA' || JSON.parse(r.data).frameId === 'frameInner')
      .map((r) => r.id)
    const touched = new Set([
      'note3',
      'note3.t',
      'frameA',
      'frameInner',
      'r0new',
      'r0new.t',
      'tri',
      'tri.o',
      'tri.t',
      'line1',
      'img1',
      ...inFrame,
    ])
    const after = lbRows(path)
    const changedRows = [...oursBefore.keys()].filter(
      (id) => JSON.stringify(after.get(id)) !== JSON.stringify(oursBefore.get(id)),
    )
    for (const id of changedRows)
      expect({ id, touched: touched.has(id) || id.startsWith('arr') }).toEqual({ id, touched: true })
    // and some rows must be untouched
    for (const id of [
      'star',
      'cloud',
      'hl',
      'pen1',
      'draw1',
      'title',
      'excal1',
      'autotext',
      'rect',
      'diamond',
    ])
      expect(changedRows).not.toContain(id)
    expect(rep.counts.elementsUntouched).toBe(oursBefore.size - changedRows.length)
    // the refreshed base and converted_from
    const cf = cfOf(path)
    expect(cf.cycle).toBe(1)
    expect(cf.sourceSha256).toBe(readDb(path, (db) => recordsSha256(db, 'documents')))
    expect(readDb(path, (db) => recordsSha256(db, 'lb_source'))).toBe(cf.sourceSha256)
    expect(boardFileState(path)).toBe('converted')
    expect(readDb(path, (db) => tableDigest(db, 'lb_prev_1_source').rows)).toBeGreaterThan(0)
  })

  it('cycle 2 merges against the refreshed lb_source, never the original cut-over base', () => {
    const before = lbRows(path)
    // A recolours note3 again; B does not touch it this time: ours stays (no conflict, no re-apply)
    excalidrawEdit(path, 'note3', ['style'], (e) => {
      e.backgroundColor = '#222222'
    })
    excalidrawEdit(path, 'rect', ['pos'], (e) => {
      e.x = (e.x as number) + 10
    })
    r0Edit(rooms, boardId, (txn) => {
      const rect = txn.get('shape:rect') as TLRecord & { x: number }
      txn.set('shape:rect', { ...rect, x: rect.x + 40 } as TLRecord)
    })
    const rep = rollForwardBoardFile(
      {
        kind: 'rollforward',
        boardId,
        path,
        reportDir: join(rooms, '..', 'migration'),
        at: 1_759_200_000_000,
      },
      metrics,
    )
    expect(rep.ok).toBe(true)
    expect(rep.cycle).toBe(2)
    expect(rep.conflicts).toEqual([{ elementId: 'rect', group: 'pos' }])
    expect(el(path, 'note3')?.e.backgroundColor).toBe('#222222')
    // theirs wins the pos conflict: B's +40 on the base of cycle 1
    const base1 = JSON.parse(before.get('rect')?.data ?? '{}') as { x: number }
    expect(el(path, 'rect')?.e.x).toBeCloseTo(base1.x + 40, 6)
    expect(readDb(path, (db) => tableDigest(db, 'lb_prev_2_elements').rows)).toBe(before.size)
    expect(cfOf(path).cycle).toBe(2)
    // nothing more to merge
    expect(
      rollForwardBoardFile(
        { kind: 'rollforward', boardId, path, reportDir: join(rooms, '..', 'migration') },
        metrics,
      ),
    ).toMatchObject({
      ok: true,
      reason: 'nothing-to-merge',
    })
  })
})

describe('the roll-forward, other cases', () => {
  it('a page created on R0 gets one new offset right of the board, appended to the frozen legacyPages', () => {
    const rooms = join(suiteDir, 'newpage', 'rooms')
    const boardId = 'b-newpage01'
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('brainstorm'))
    expect(
      convertBoardFile(
        { kind: 'convert', boardId, path, reportDir: join(rooms, '..', 'migration'), backupKey: null, at: 1 },
        metrics,
      ).ok,
    ).toBe(true)
    const importOf = () =>
      readDb(path, (db) =>
        JSON.parse(
          (db.prepare("SELECT value FROM lb_doc WHERE key = 'import'").get() as { value: string }).value,
        ),
      ) as {
        legacyPages: Record<string, { dx: number; dy: number; index: number }>
      }
    const frozen = importOf().legacyPages
    const right = Math.max(
      ...[...lbRows(path).values()].map((r) => JSON.parse(r.data)).map((e) => e.x + e.width),
    )
    r0Edit(rooms, boardId, (txn) => {
      txn.set('page:later', {
        id: 'page:later',
        typeName: 'page',
        name: 'Later',
        index: 'a5',
        meta: {},
      } as unknown as TLRecord)
      const note = [...fixtureRecords('brainstorm')].find(
        (r) => (r as unknown as { type?: string }).type === 'note',
      ) as TLRecord & Record<string, unknown>
      txn.set('shape:on-later', {
        ...note,
        id: 'shape:on-later',
        parentId: 'page:later',
        x: 0,
        y: 0,
        index: 'a1',
        meta: {},
      } as unknown as TLRecord)
    })
    const rep = rollForwardBoardFile(
      { kind: 'rollforward', boardId, path, reportDir: join(rooms, '..', 'migration'), at: 2 },
      metrics,
    )
    expect(rep.ok).toBe(true)
    expect(rep.counts.pagesAppended).toBe(1)
    const pages = importOf().legacyPages
    // every frozen offset is unchanged; the new page is right of everything that was there
    for (const [id, p] of Object.entries(frozen)) expect(pages[id]).toEqual(p)
    expect(pages['page:later']?.dx).toBeGreaterThan(0)
    const added = JSON.parse(lbRows(path).get('on-later')?.data ?? 'null') as { x: number } | null
    expect(added?.x).toBeGreaterThan(right)
  })

  it('a shape R0 adds where R0 deleted one never takes the tombstone key: keys stay unique over live elements and tombstones', () => {
    // B8 phase 3 (the drill through the browser, kitchen sink): R0 deleted `rect` and added a shape whose
    // paint-order neighbour sat right below it; the merge placed the new shape between the live keys
    // around it and got `rect`'s key. A client holds the tombstones in its scene array, so Excalidraw
    // re-keyed the tombstone on open and pushed it back.
    const rooms = join(suiteDir, 'tombkey', 'rooms')
    const boardId = 'b-tombkey01'
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    expect(
      convertBoardFile(
        { kind: 'convert', boardId, path, reportDir: join(rooms, '..', 'migration'), backupKey: null, at: 1 },
        metrics,
      ).ok,
    ).toBe(true)
    const rectKey = lbRows(path).get('rect')?.idx
    expect(rectKey).toBeTruthy()
    r0Edit(rooms, boardId, (txn) => {
      const text = txn.get('shape:autotext') as TLRecord & Record<string, unknown>
      txn.delete('shape:rect')
      txn.set('shape:added', {
        ...text,
        id: 'shape:added',
        parentId: 'page:page',
        x: 5_000,
        y: 5_000,
        index: 'a1V',
        meta: {},
      } as unknown as TLRecord)
    })
    const rep = rollForwardBoardFile(
      { kind: 'rollforward', boardId, path, reportDir: join(rooms, '..', 'migration'), at: 2 },
      metrics,
    )
    expect(rep.ok).toBe(true)
    const rows = [...lbRows(path).values()]
    expect(rows.find((r) => r.id === 'rect')?.deleted).toBe(1)
    expect(rows.find((r) => r.id === 'added')?.deleted).toBe(0)
    expect(rows.find((r) => r.id === 'added')?.idx).not.toBe(rectKey)
    // every key unique, tombstones included
    const keys = rows.map((r) => r.idx)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('refuses a board whose lb_source no longer matches its recorded digest (the board stays closed)', () => {
    const rooms = join(suiteDir, 'tampered', 'rooms')
    const boardId = 'b-tampered1'
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('retrospective'))
    expect(
      convertBoardFile(
        { kind: 'convert', boardId, path, reportDir: join(rooms, '..', 'migration'), backupKey: null, at: 1 },
        metrics,
      ).ok,
    ).toBe(true)
    r0Edit(rooms, boardId, (txn) => {
      const f = [...fixtureRecords('retrospective')].find((r) => r.typeName === 'shape') as TLRecord & {
        x: number
      }
      txn.set(f.id, { ...f, x: f.x + 1 } as TLRecord)
    })
    const db = new DatabaseSync(path)
    db.exec("UPDATE lb_source SET state = '{}' WHERE rowid = (SELECT min(rowid) FROM lb_source)")
    db.close()
    const rows = lbRows(path)
    const rep = rollForwardBoardFile(
      { kind: 'rollforward', boardId, path, reportDir: join(rooms, '..', 'migration') },
      metrics,
    )
    expect(rep).toMatchObject({ ok: false, reason: 'base-digest' })
    expect(lbRows(path)).toEqual(rows)
  })
})
