// Binding-record diffs in the roll-forward's local mode (docs/EXCALIDRAW-MIGRATION.md open item 12, §5.9
// steps a-c and g). 2B. tldraw keeps an arrow's ends in `binding` records of their own (fromId = the
// arrow, toId = the target, props.terminal = start | end); Excalidraw keeps them on both elements: the
// arrow's `startBinding` / `endBinding` (group `bind`, travelling with the arrow's `path` unit) and the
// target's `boundElements` (group `bound`). The mapping, as rollforward.ts implements it:
//
//  1. a binding record created, deleted or changed in theirs touches BOTH its ends (in base and in theirs:
//     a re-targeted binding touches the old target too), so each end is converted in local mode within
//     base and within theirs;
//  2. the arrow's `bind` group (and its `path` unit when the ends moved) is what theirs changed: merged per
//     group like any other (theirs only → theirs; both → theirs wins, ours' value kept in lb_prev_* and
//     the conflict listed as `bind`);
//  3. a target's `boundElements` is never merged from either conversion: it is derived from the merged
//     arrows (and labels) in step g, so it holds exactly the arrows bound to it after the merge, ours'
//     Excalidraw-era bindings included; an arrow bound to a deleted target loses that binding (its end
//     stays where it is) and a deleted arrow leaves its targets' lists;
//  4. arrows whose ends or targets moved are re-snapped (step g); then the §2.4.4 invariants, which check
//     both directions, run on the merged board.
//
// The cases below pin each rule; they also check that every binding is symmetric afterwards.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTableTextMetrics,
  indexKeyBetween,
  installServerTextMetrics,
} from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@tldraw/tlschema'
import { afterAll, describe, expect, it } from 'vitest'
import { unregisterBornAfterCheck } from '../../src/r0/index.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { type RollForwardReport, rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import {
  excalidrawCreate,
  excalidrawEdit,
  fixtureRecords,
  lbRows,
  r0Edit,
  seedBoardRecords,
} from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const suiteDir = mkdtempSync(join(tmpdir(), 'dr-rfbind-'))
afterAll(() => {
  unregisterBornAfterCheck()
  rmSync(suiteDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

type El = Record<string, unknown> & {
  id: string
  type: string
  isDeleted?: boolean
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  boundElements?: { id: string; type: string }[] | null
}
type Txn = Parameters<Parameters<typeof r0Edit>[2]>[0]

let n = 0
function scenario(opts: {
  ours?: (path: string, els: Map<string, El>) => void
  theirs: (txn: Txn) => void
}): { rep: RollForwardReport; els: Map<string, El> } {
  const rooms = join(suiteDir, `s${n}`, 'rooms')
  const boardId = `b-rfbind${String(n++).padStart(4, '0')}`
  const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
  const reportDir = join(rooms, '..', 'migration')
  expect(
    convertBoardFile({ kind: 'convert', boardId, path, reportDir, backupKey: null, at: 1 }, metrics).ok,
  ).toBe(true)
  const parse = () => new Map([...lbRows(path)].map(([id, r]) => [id, JSON.parse(r.data) as El]))
  opts.ours?.(path, parse())
  r0Edit(rooms, boardId, opts.theirs)
  const rep = rollForwardBoardFile({ kind: 'rollforward', boardId, path, reportDir, at: 2 }, metrics)
  return { rep, els: parse() }
}

const bound = (els: Map<string, El>, id: string) =>
  (els.get(id)?.boundElements ?? [])
    .filter((b) => b.type === 'arrow')
    .map((b) => b.id)
    .sort()

/** Every live arrow's bindings name a live target that lists it, and every listed arrow is bound to it. */
function expectSymmetric(els: Map<string, El>) {
  for (const e of els.values()) {
    if (e.isDeleted) continue
    if (e.type === 'arrow')
      for (const b of [e.startBinding, e.endBinding]) {
        if (!b) continue
        const t = els.get(b.elementId)
        expect(t && !t.isDeleted, `${e.id} bound to a live target`).toBe(true)
        expect(bound(els, b.elementId)).toContain(e.id)
      }
    for (const ref of e.boundElements ?? []) {
      if (ref.type !== 'arrow') continue
      const a = els.get(ref.id)
      expect(a && !a.isDeleted, `${e.id} lists a live arrow`).toBe(true)
      expect([a?.startBinding?.elementId, a?.endBinding?.elementId]).toContain(e.id)
    }
  }
}

const binding = (txn: Txn, id: string) => txn.get(id) as TLRecord & Record<string, unknown>

describe('roll-forward: binding records map to the arrow and its targets (open item 12)', () => {
  it('a binding R0 deleted unbinds that end only, and the target stops listing the arrow', () => {
    const { rep, els } = scenario({ theirs: (txn) => txn.delete('binding:b1s') })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    expect(els.get('arr1')?.startBinding ?? null).toBeNull()
    expect(els.get('arr1')?.endBinding?.elementId).toBe('rect')
    expect(bound(els, 'note1')).not.toContain('arr1')
    expect(bound(els, 'rect')).toContain('arr1')
    expectSymmetric(els)
  })

  it('a binding R0 created binds the arrow, and the target lists it', () => {
    const { rep, els } = scenario({
      theirs: (txn) => {
        const b = binding(txn, 'binding:b1s')
        txn.set('binding:new', {
          ...b,
          id: 'binding:new',
          fromId: 'shape:arr2',
          toId: 'shape:tri',
          props: { ...(b.props as object), terminal: 'start' },
        } as unknown as TLRecord)
        txn.delete('binding:b2s')
      },
    })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    expect(els.get('arr2')?.startBinding?.elementId).toBe('tri')
    expect(bound(els, 'tri')).toContain('arr2')
    expect(bound(els, 'rect')).not.toContain('arr2')
    expectSymmetric(els)
  })

  it('a binding R0 re-targeted moves the arrow from the old target to the new one', () => {
    const { rep, els } = scenario({
      theirs: (txn) => {
        const b = binding(txn, 'binding:b1e')
        txn.set('binding:b1e', { ...b, toId: 'shape:tri' } as unknown as TLRecord)
      },
    })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    expect(els.get('arr1')?.endBinding?.elementId).toBe('tri')
    expect(bound(els, 'tri')).toContain('arr1')
    expect(bound(els, 'rect')).toEqual(['arr2'])
    expectSymmetric(els)
  })

  it("an arrow ours bound to a target on Excalidraw stays in that target's list when R0 unbinds another", () => {
    const { rep, els } = scenario({
      ours: (path, before) => {
        const a = before.get('arr2') as El
        excalidrawCreate(path, {
          ...a,
          id: 'xa',
          index: indexKeyBetween(
            [...before.values()]
              .map((e) => String(e.index))
              .sort()
              .at(-1),
            null,
          ),
          version: 1,
          startBinding: { ...(a.startBinding as object), elementId: 'rect' },
          endBinding: null,
          boundElements: null,
        })
        excalidrawEdit(path, 'rect', ['bound'], (e) => {
          e.boundElements = [...((e.boundElements as El['boundElements']) ?? []), { id: 'xa', type: 'arrow' }]
        })
      },
      theirs: (txn) => txn.delete('binding:b2s'),
    })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    expect(bound(els, 'rect')).toEqual(['arr1', 'xa'])
    expect(els.get('arr2')?.startBinding ?? null).toBeNull()
    expectSymmetric(els)
  })

  it('a target R0 deleted (with its bindings) unbinds every arrow that pointed at it', () => {
    const { rep, els } = scenario({
      theirs: (txn) => {
        txn.delete('binding:b2e')
        txn.delete('binding:b3s')
        txn.delete('shape:diamond')
      },
    })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    expect(els.get('diamond')?.isDeleted).toBe(true)
    expect(els.get('arr2')?.endBinding ?? null).toBeNull()
    expect(els.get('arr3')?.startBinding ?? null).toBeNull()
    expect(els.get('arr3')?.endBinding?.elementId).toBe('star')
    expectSymmetric(els)
  })

  it('an arrow R0 deleted (with its bindings) leaves both targets’ lists', () => {
    const { rep, els } = scenario({
      theirs: (txn) => {
        txn.delete('binding:b1s')
        txn.delete('binding:b1e')
        txn.delete('shape:arr1')
      },
    })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    expect(els.get('arr1')?.isDeleted).toBe(true)
    expect(bound(els, 'note1')).toEqual([])
    expect(bound(els, 'rect')).toEqual(['arr2'])
    expectSymmetric(els)
  })

  it('ours re-bound the same end on Excalidraw: theirs wins, the conflict is listed as `bind`', () => {
    const { rep, els } = scenario({
      ours: (path, before) => {
        const a = before.get('arr1') as El
        excalidrawEdit(path, 'arr1', ['bind'], (e) => {
          e.startBinding = { ...(a.startBinding as object), elementId: 'note2' }
        })
        excalidrawEdit(path, 'note1', ['bound'], (e) => {
          e.boundElements = ((e.boundElements as El['boundElements']) ?? []).filter((b) => b.id !== 'arr1')
        })
        excalidrawEdit(path, 'note2', ['bound'], (e) => {
          e.boundElements = [
            ...((e.boundElements as El['boundElements']) ?? []),
            { id: 'arr1', type: 'arrow' },
          ]
        })
      },
      theirs: (txn) => txn.delete('binding:b1s'),
    })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    expect(rep.conflicts).toContainEqual({ elementId: 'arr1', group: 'bind' })
    expect(els.get('arr1')?.startBinding ?? null).toBeNull()
    expect(bound(els, 'note2')).not.toContain('arr1')
    expect(bound(els, 'note1')).not.toContain('arr1')
    expectSymmetric(els)
  })

  it('an anchor R0 changed lands on the arrow while ours moved the target: the end follows the moved target', () => {
    let rectBefore: El | undefined
    const { rep, els } = scenario({
      ours: (path, before) => {
        rectBefore = before.get('rect')
        excalidrawEdit(path, 'rect', ['pos'], (e) => {
          e.x = Number(e.x) + 300
          e.y = Number(e.y) + 120
        })
      },
      theirs: (txn) => {
        const b = binding(txn, 'binding:b1e')
        txn.set('binding:b1e', {
          ...b,
          props: {
            ...(b.props as object),
            normalizedAnchor: { x: 0.9, y: 0.2 },
            isPrecise: true,
            isExact: true,
          },
        } as unknown as TLRecord)
      },
    })
    expect(rep).toMatchObject({ ok: true, violations: [] })
    const a = els.get('arr1') as El & { x: number; y: number; points: [number, number][] }
    const end = a.endBinding as unknown as { elementId: string; fixedPoint: [number, number]; mode: string }
    expect(end.elementId).toBe('rect')
    // theirs' anchor (exact: `inside`, at the anchor; the converter maps a precise one to `orbit` at it), ours'
    // position of the target
    expect(end.mode).toBe('inside')
    expect(end.fixedPoint[0]).toBeCloseTo(0.9, 3)
    expect(end.fixedPoint[1]).toBeCloseTo(0.2, 3)
    const r = els.get('rect') as El & { x: number; y: number; width: number; height: number }
    expect(r.x).toBe(Number(rectBefore?.x) + 300)
    const last = a.points.at(-1) as [number, number]
    const ex = a.x + last[0]
    const ey = a.y + last[1]
    expect(Math.abs(ex - (r.x + 0.9 * r.width))).toBeLessThan(2)
    expect(Math.abs(ey - (r.y + 0.2 * r.height))).toBeLessThan(2)
    expectSymmetric(els)
  })
})
