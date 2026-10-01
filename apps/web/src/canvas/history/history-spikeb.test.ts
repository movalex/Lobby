import { GEOMETRY_TOLERANCE_PX } from '@draftroom/canvas-schema/limits'
import { describe, expect, it } from 'vitest'
import {
  bind,
  cloneScene,
  dist,
  dragFrame,
  dragPoint,
  dragSegment,
  type El,
  editTarget,
  glob,
  newArrow,
  newFrame,
  newRect,
  type Pt,
  resnap,
  routeElbow,
  type Scene,
  segments,
} from '../sync/testing/excalidraw.ts'
import type { HistEl } from './diff.ts'
import { LobbyHistory } from './stack.ts'

// Spike B additions to the undo core (docs/EXCALIDRAW-MIGRATION.md §2.8, revisions 3.3-3.5): arrow geometry
// compared through its user-set geometry in scene coordinates within GEOMETRY_TOLERANCE_PX, the whole
// `path` unit recorded and restored (the server re-snaps the bound ends), `derived` ack rows folded with no
// entry, and the life-version check (U11). Client copies are made with Excalidraw's own helpers.

const TOL = GEOMETRY_TOLERANCE_PX
type M = ReadonlyMap<string, HistEl>
const asScene = (s: Scene): M => s as unknown as M

/** Installs an undo's patches on a copy, then the server's re-snap of every arrow (rule 7). */
function applyUndo(
  scene: Scene,
  res: { patches: Map<string, Record<string, unknown>> },
  arrows: string[],
): Scene {
  const next = cloneScene(scene)
  for (const [id, patch] of res.patches) next.set(id, { ...next.get(id), ...patch })
  for (const a of arrows) resnap(next, a)
  return next
}

/** A remote change (applied with NEVER): absorbed, never a step. */
function absorbAll(h: LobbyHistory, before: Scene, after: Scene): void {
  for (const [id, el] of after) h.absorb(before.get(id) as HistEl | undefined, el as HistEl)
}

function startBound(angle = 0): Scene {
  const x = newRect({ id: 'x', x: 0, y: 0, width: 100, height: 100 })
  const a = bind(
    newArrow({
      id: 'a',
      x: 100,
      y: 50,
      points: [
        [0, 0],
        [200, 0],
      ],
      angle,
    }),
    x,
    null,
  )
  return new Map<string, El>([
    ['x', x],
    ['a', a],
  ])
}

describe('undo of arrow geometry after a re-snap (§2.8, spike B)', () => {
  for (const angle of [0, 0.6]) {
    it(`a start-bound arrow's free end goes back after its target moved (angle ${angle}); no "change kept"`, () => {
      const s0 = startBound(angle)
      const h = new LobbyHistory()
      h.reset(asScene(s0))
      const before = glob(s0.get('a'), 1, s0)
      // C drags the free end
      const s1 = cloneScene(s0)
      dragPoint(s1, 'a', 1, [before[0] + 5, before[1] + 60])
      const entry = h.record(asScene(s1))
      expect(entry?.changes.get('a')).toBeDefined()
      // the whole path unit is recorded, not the points alone
      expect(Object.keys(entry?.changes.get('a')?.fields ?? {}).sort()).toEqual(
        expect.arrayContaining(['angle', 'height', 'points', 'width', 'x', 'y']),
      )
      const dropped = glob(s1.get('a'), 1, s1)
      // B grows X (the server re-snaps the arrow; C applies it with NEVER)
      const s2 = cloneScene(s1)
      editTarget(s2, 'x', { height: 180 })
      expect(dist(glob(s2.get('a'), 1, s2), dropped)).toBeLessThanOrEqual(TOL) // the free end kept its spot
      absorbAll(h, s1, s2)
      const res = h.undo(asScene(s2))
      expect(res?.kept).toBe(0)
      const s3 = applyUndo(s2, res as never, ['a'])
      expect(dist(glob(s3.get('a'), 1, s3), before)).toBeLessThanOrEqual(TOL)
      // the restore carries the whole unit
      expect(Object.keys(res?.patches.get('a') ?? {})).toEqual(
        expect.arrayContaining(['x', 'y', 'points', 'angle']),
      )
    })
  }

  it("a curved arrow's midpoint goes back after both targets moved", () => {
    const x = newRect({ id: 'x', x: 0, y: 0, width: 100, height: 100 })
    const y = newRect({ id: 'y', x: 400, y: 0, width: 100, height: 100 })
    const a = bind(
      newArrow({
        id: 'a',
        x: 100,
        y: 50,
        points: [
          [0, 0],
          [150, -40],
          [300, 0],
        ],
        roundness: { type: 2 },
      }),
      x,
      y,
    )
    const s0: Scene = new Map<string, El>([
      ['x', x],
      ['y', y],
      ['a', a],
    ])
    const h = new LobbyHistory()
    h.reset(asScene(s0))
    const mid0 = glob(s0.get('a'), 1, s0)
    const s1 = cloneScene(s0)
    dragPoint(s1, 'a', 1, [mid0[0] + 20, mid0[1] - 30])
    h.record(asScene(s1))
    const s2 = cloneScene(s1)
    editTarget(s2, 'x', { y: 40 })
    editTarget(s2, 'y', { x: 440 })
    absorbAll(h, s1, s2)
    const res = h.undo(asScene(s2))
    expect(res?.kept).toBe(0)
    const s3 = applyUndo(s2, res as never, ['a'])
    expect(dist(glob(s3.get('a'), 1, s3), mid0)).toBeLessThanOrEqual(TOL)
  })

  it("an elbow arrow's fixed segment goes back by ORDER after the target's rotation renumbered it", () => {
    const x = newRect({ id: 'x', x: 0, y: 0, width: 100, height: 100 })
    const y = newRect({ id: 'y', x: 600, y: 300, width: 100, height: 100 })
    const a = bind(
      newArrow({
        id: 'a',
        x: 100,
        y: 50,
        points: [
          [0, 0],
          [500, 300],
        ],
        elbowed: true,
      }),
      x,
      y,
    )
    const s0: Scene = new Map<string, El>([
      ['x', x],
      ['y', y],
      ['a', a],
    ])
    routeElbow(s0, s0.get('a'), { index: 2, x: 400 })
    const h = new LobbyHistory()
    h.reset(asScene(s0))
    const seg0 = segments(s0.get('a'))
    const s1 = cloneScene(s0)
    const idx = (seg0[0] as { index: number }).index
    dragSegment(s1, 'a', idx, 450)
    h.record(asScene(s1))
    expect(segments(s1.get('a'))[0]?.cross).toBeCloseTo(450, 1)
    // B rotates X by 90 degrees: the router may insert a special point and renumber the segment
    const s2 = cloneScene(s1)
    editTarget(s2, 'x', { angle: Math.PI / 2 })
    absorbAll(h, s1, s2)
    const res = h.undo(asScene(s2))
    expect(res?.kept).toBe(0)
    const patched = { ...s2.get('a'), ...(res?.patches.get('a') ?? {}) }
    expect(segments(patched)[0]?.cross).toBeCloseTo(seg0[0]?.cross ?? 0, 1)
  })

  it('a free START is compared and restored through x, y', () => {
    const y = newRect({ id: 'y', x: 400, y: 0, width: 100, height: 100 })
    const a = bind(
      newArrow({
        id: 'a',
        x: 100,
        y: 50,
        points: [
          [0, 0],
          [300, 0],
        ],
      }),
      null,
      y,
      [1, 0.5],
      [0, 0.5],
    )
    const s0: Scene = new Map<string, El>([
      ['y', y],
      ['a', a],
    ])
    const h = new LobbyHistory()
    h.reset(asScene(s0))
    const start0 = glob(s0.get('a'), 0, s0)
    const s1 = cloneScene(s0)
    dragPoint(s1, 'a', 0, [60, 120])
    h.record(asScene(s1))
    const s2 = cloneScene(s1)
    editTarget(s2, 'y', { x: 460 })
    absorbAll(h, s1, s2)
    const res = h.undo(asScene(s2))
    expect(res?.kept).toBe(0)
    const s3 = applyUndo(s2, res as never, ['a'])
    expect(dist(glob(s3.get('a'), 0, s3), start0)).toBeLessThanOrEqual(TOL)
  })

  it('a frame drag that translated an arrow inside the frame is undone with the frame', () => {
    const f = newFrame({ id: 'f', x: 0, y: 0, width: 600, height: 400 })
    const n = newRect({ id: 'n', x: 40, y: 40, width: 100, height: 100, frameId: 'f' })
    const a = bind(
      newArrow({
        id: 'a',
        x: 140,
        y: 90,
        points: [
          [0, 0],
          [100, 60],
          [200, 0],
        ],
        frameId: 'f',
      }),
      n,
      null,
    )
    const s0: Scene = new Map<string, El>([
      ['f', f],
      ['n', n],
      ['a', a],
    ])
    const h = new LobbyHistory()
    h.reset(asScene(s0))
    const free0 = glob(s0.get('a'), 2, s0)
    const s1 = cloneScene(s0)
    dragFrame(s1, 'f', { x: 80, y: 30 })
    expect(dist(glob(s1.get('a'), 2, s1), [free0[0] + 80, free0[1] + 30])).toBeLessThanOrEqual(TOL)
    h.record(asScene(s1))
    const res = h.undo(asScene(s1))
    expect(res?.kept).toBe(0)
    const s2 = applyUndo(s1, res as never, ['a'])
    expect(dist(glob(s2.get('a'), 2, s2), free0)).toBeLessThanOrEqual(TOL)
  })

  it("a compare that differs only by floating-point noise or the server's 2-decimal rounding applies", () => {
    const s0 = startBound()
    const h = new LobbyHistory()
    h.reset(asScene(s0))
    const s1 = cloneScene(s0)
    dragPoint(s1, 'a', 1, [305.123456, 100.987654])
    h.record(asScene(s1))
    // the server rounds points to 2 decimals and returns the stored values as its own write
    const s2 = cloneScene(s1)
    const a2 = s2.get('a')
    a2.points = a2.points.map(([px, py]: Pt) => [
      Math.round(px * 100) / 100,
      Math.round(py * 100) / 100 + 1e-9,
    ])
    absorbAll(h, s1, s2)
    const res = h.undo(asScene(s2))
    expect(res?.kept).toBe(0)
    expect(res?.patches.has('a')).toBe(true)
  })

  it('a 1 px move of the free end by someone else since IS a change (kept, not overwritten)', () => {
    const s0 = startBound()
    const h = new LobbyHistory()
    h.reset(asScene(s0))
    const s1 = cloneScene(s0)
    dragPoint(s1, 'a', 1, [305, 100])
    h.record(asScene(s1))
    const s2 = cloneScene(s1)
    dragPoint(s2, 'a', 1, [306, 100])
    absorbAll(h, s1, s2)
    const res = h.undo(asScene(s2))
    expect(res?.kept).toBe(1)
    expect(res?.patches.has('a')).toBe(false)
  })
})

describe('derived rows and the life-version check (§2.8)', () => {
  it("a derived re-snap of the writer's own resize folds in with no entry for the arrow", () => {
    const s0 = startBound()
    const h = new LobbyHistory()
    h.reset(asScene(s0))
    const s1 = cloneScene(s0)
    editTarget(s1, 'x', { width: 140 }) // B's resize; the arrow's local follow is derived (the core never records it)
    const recordView = cloneScene(s1)
    recordView.set('a', s0.get('a')) // the adapter records held derived arrows at their server copy
    const entry = h.record(asScene(recordView))
    expect([...(entry?.changes.keys() ?? [])]).toEqual(['x'])
    h.markPushed(1, ['x'])
    const resnapped = cloneScene(s1)
    h.onAck(
      {
        seq: 1,
        r: [{ id: 'x', ok: true, v: 3 }],
        derived: [
          {
            id: 'a',
            v: 3,
            fix: {
              x: resnapped.get('a').x,
              points: resnapped.get('a').points,
              width: resnapped.get('a').width,
            },
          },
        ],
      },
      asScene(resnapped),
    )
    expect(h.undoSize).toBe(1)
    const res = h.undo(asScene(resnapped))
    expect(res?.kept).toBe(0)
    expect([...(res?.patches.keys() ?? [])]).toEqual(['x'])
  })

  it('U11: A deletes X by an undo, B restores X, C deletes it again: A redo leaves X deleted', () => {
    const x = newRect({ id: 'X', x: 0, y: 0 })
    const h = new LobbyHistory()
    h.reset(new Map())
    const s1 = new Map<string, El>([['X', x]])
    h.record(asScene(s1)) // A creates X
    const u = h.undo(asScene(s1)) // A's undo deletes it
    const s2 = cloneScene(s1)
    s2.get('X').isDeleted = u?.patches.get('X')?.isDeleted
    expect(s2.get('X').isDeleted).toBe(true)
    // B restores, C deletes again (remote writes, absorbed)
    const s3 = cloneScene(s2)
    s3.get('X').isDeleted = false
    absorbAll(h, s2, s3)
    const s4 = cloneScene(s3)
    s4.get('X').isDeleted = true
    absorbAll(h, s3, s4)
    const r = h.redo(asScene(s4))
    expect(r?.patches.get('X')?.isDeleted).toBeUndefined()
    expect(r?.skips.some((k) => k.reason === 'deleted')).toBe(true)
  })

  it('without an intervening restore the redo of that undo still revives (the check is not a block)', () => {
    const x = newRect({ id: 'X', x: 0, y: 0 })
    const h = new LobbyHistory()
    h.reset(new Map())
    const s1 = new Map<string, El>([['X', x]])
    h.record(asScene(s1))
    const u = h.undo(asScene(s1))
    const s2 = cloneScene(s1)
    s2.get('X').isDeleted = u?.patches.get('X')?.isDeleted
    const r = h.redo(asScene(s2))
    expect(r?.patches.get('X')?.isDeleted).toBe(false)
  })
})
