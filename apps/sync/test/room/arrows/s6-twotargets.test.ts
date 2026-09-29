// C0 arrow acceptance test s6 (ported from scratchpad/critic-r34/s6-twotargets.mjs, 3.5 rules): A moves
// X (the start target) while B moves Y (the end target), for a straight, a curved, an elbow and an elbow
// arrow with a fixed segment. Pass: both movers' follows are derived; both commit orders store the same
// arrow; each undo (X back, or Y back) equals a fresh board with only the other move. Within
// GEOMETRY_TOLERANCE_PX.

import { isDerivedArrowChange } from '@draftroom/canvas-schema/groups'
import { describe, expect, it } from 'vitest'
import {
  bind,
  cloneScene,
  dist,
  type El,
  editTarget,
  engine,
  fakeScene,
  glob,
  LinearElementEditor,
  newArrow,
  newRect,
  type Pt,
  routeElbow,
  type Scene,
  segments,
  TOL,
} from './support/excalidraw.ts'
import type { TestClient } from './support/room.ts'
import { patchOf } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

type Kind = 'straight' | 'curved' | 'elbow' | 'elbow+fixed'
const KINDS: Kind[] = ['straight', 'curved', 'elbow', 'elbow+fixed']
const MOVE_X = { x: 60, y: -120 }
const MOVE_Y = { x: 380, y: 520 }

function setup(kind: Kind): { X: El; Y: El; A: El } {
  const X = newRect({ x: 0, y: 0, width: 200, height: 100 })
  const Y = newRect({ x: 500, y: 300, width: 200, height: 100 })
  const A = {
    ...newArrow({ x: 205, y: 50, elbowed: kind.startsWith('elbow') }),
    points:
      kind === 'curved'
        ? [
            [0, 0],
            [100, 150],
            [290, 300],
          ]
        : [
            [0, 0],
            [290, 300],
          ],
    roundness: kind === 'curved' ? { type: 2 } : null,
    startArrowhead: null,
    endArrowhead: 'arrow',
  }
  bind(A, X, Y)
  if (kind.startsWith('elbow')) {
    const S: Scene = new Map([
      [X.id, X],
      [Y.id, Y],
      [A.id, A],
    ])
    routeElbow(S, A, kind === 'elbow+fixed' ? { index: 2, x: 400 } : undefined)
  }
  return { X, Y, A }
}

/** Every point of the stored arrow in scene coordinates, its segments and flags: the arrow "as stored". */
function shape(a: El, map: Scene) {
  return {
    pts: a.points.map((_: Pt, i: number) => glob(a, i, map)),
    segs: segments(a),
    flags: [a.startIsSpecial ?? null, a.endIsSpecial ?? null],
  }
}
function sameShape(p: ReturnType<typeof shape>, q: ReturnType<typeof shape>): boolean {
  if (p.pts.length !== q.pts.length || p.segs.length !== q.segs.length) return false
  if (JSON.stringify(p.flags) !== JSON.stringify(q.flags)) return false
  return (
    p.pts.every((pt: Pt, i: number) => dist(pt, q.pts[i] as Pt) <= TOL) &&
    p.segs.every(
      (s, i) => s.v === q.segs[i]?.v && Math.abs(s.cross - (q.segs[i]?.cross ?? Number.NaN)) <= TOL,
    )
  )
}

async function race(kind: Kind, order: 'A-then-B' | 'B-then-A') {
  const room = await freshBoard(`s6-${kind}-${order}`)
  const { X, Y, A } = setup(kind)
  const S = await room.client('S')
  await S.create([X, Y, A])
  const Ac = await room.client('A')
  const B = await room.client('B')
  const Am = Ac.copy()
  editTarget(Am, X.id, MOVE_X)
  const Bm = B.copy()
  editTarget(Bm, Y.id, MOVE_Y)
  const derived = [
    isDerivedArrowChange(Am.get(A.id), Ac.confirmed.get(A.id), Am, Ac.confirmed),
    isDerivedArrowChange(Bm.get(A.id), B.confirmed.get(A.id), Bm, B.confirmed),
  ]
  const opA = patchOf(Am.get(X.id), Ac.confirmed.get(X.id))
  const opB = patchOf(Bm.get(Y.id), B.confirmed.get(Y.id))
  const [baseA, baseB] = [Ac.clock, B.clock]
  if (order === 'A-then-B') {
    await Ac.push([opA], baseA)
    await B.push([opB], baseB)
  } else {
    await B.push([opB], baseB)
    await Ac.push([opA], baseA)
  }
  return { room, ids: { X: X.id, Y: Y.id, A: A.id }, Ac, B, derived }
}

async function fresh(kind: Kind, only: 'X' | 'Y') {
  const room = await freshBoard(`s6-fresh-${kind}-${only}`)
  const { X, Y, A } = setup(kind)
  const S = await room.client('S')
  await S.create([X, Y, A])
  const Sm = S.copy()
  const id = only === 'X' ? X.id : Y.id
  Object.assign(Sm.get(id), only === 'X' ? MOVE_X : MOVE_Y)
  await S.push([patchOf(Sm.get(id), S.confirmed.get(id))])
  const stored = await room.stored()
  return shape(stored.get(A.id), stored)
}

async function undoMove(client: TestClient, id: string, to: { x: number; y: number }) {
  const m = client.copy()
  Object.assign(m.get(id), to)
  await client.push([patchOf(m.get(id), client.confirmed.get(id))])
}

describe('s6 client side (groups.ts only)', () => {
  for (const kind of KINDS)
    it(`${kind}: both movers' follows are derived`, () => {
      const { X, Y, A } = setup(kind)
      const S: Scene = new Map([
        [X.id, X],
        [Y.id, Y],
        [A.id, A],
      ])
      if (!kind.startsWith('elbow')) {
        // the probes' snap of both ends
        const ups: [number, { point: Pt }][] = []
        for (const [prop, idx] of [
          ['startBinding', 0],
          ['endBinding', A.points.length - 1],
        ] as const) {
          const p = engine.updateBoundPoint(A, prop, A[prop], S.get(A[prop].elementId), S)
          if (p) ups.push([idx, { point: p }])
        }
        LinearElementEditor.movePoints(A, fakeScene(S), new Map(ups))
      }
      const conf = cloneScene(S)
      const Am = cloneScene(S)
      editTarget(Am, X.id, MOVE_X)
      const Bm = cloneScene(S)
      editTarget(Bm, Y.id, MOVE_Y)
      expect(isDerivedArrowChange(Am.get(A.id), conf.get(A.id), Am, conf)).toBe(true)
      expect(isDerivedArrowChange(Bm.get(A.id), conf.get(A.id), Bm, conf)).toBe(true)
    })
})

describe('s6 against the room', () => {
  for (const kind of KINDS)
    it(`${kind}: both commit orders store the same arrow; each undo equals a fresh board with only the other move`, async () => {
      const results = []
      for (const order of ['A-then-B', 'B-then-A'] as const) {
        const r = await race(kind, order)
        expect(r.derived).toEqual([true, true])
        const stored = await r.room.stored()
        results.push({ r, final: shape(stored.get(r.ids.A), stored) })
      }
      const [one, two] = results as [(typeof results)[0], (typeof results)[0]]
      expect(sameShape(one.final, two.final)).toBe(true)
      const onlyY = await fresh(kind, 'Y')
      const onlyX = await fresh(kind, 'X')
      // in each order, on a board of its own: A undoes X's move, and B undoes Y's move
      for (const order of ['A-then-B', 'B-then-A'] as const) {
        const ra = await race(kind, order)
        await ra.Ac.untilClock((await ra.room.snapshot()).clock)
        await undoMove(ra.Ac, ra.ids.X, { x: 0, y: 0 })
        let stored = await ra.room.stored()
        expect(sameShape(shape(stored.get(ra.ids.A), stored), onlyY), `${order}: A's undo`).toBe(true)
        const rb = await race(kind, order)
        await rb.B.untilClock((await rb.room.snapshot()).clock)
        await undoMove(rb.B, rb.ids.Y, { x: 500, y: 300 })
        stored = await rb.room.stored()
        expect(sameShape(shape(stored.get(rb.ids.A), stored), onlyX), `${order}: B's undo`).toBe(true)
      }
    })
})
