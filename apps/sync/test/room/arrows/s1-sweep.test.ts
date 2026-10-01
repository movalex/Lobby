// C0 arrow acceptance test s1, the sweeps (ported from scratchpad/critic-r34/s1-sweep2.mjs,
// s1-fp-race.mjs and the sweep half of s1-rot-literal.mjs, 3.5 rules): 2,000 random resizes of a
// start-bound arrow's target, half of the arrows rotated. Pass: no resizer's follow is misclassified
// (Excalidraw's follow is not bit-exact, so the compare is within GEOMETRY_TOLERANCE_PX), and against the
// room no user drag is lost: C drags each free end 60 px right and commits first, then B's resize lands.

import { compareArrowChange, isDerivedArrowChange } from '@draftroom/canvas-schema/groups'
import { describe, expect, it } from 'vitest'
import {
  bind,
  cloneScene,
  dist,
  dragPoint,
  type El,
  editTarget,
  engine,
  fakeScene,
  glob,
  LinearElementEditor,
  newArrow,
  newRect,
  type Pt,
  type Scene,
  TOL,
} from './support/excalidraw.ts'
import { patchOf, pathOp } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

const CASES = 2_000

/**
 * The probes' generator (Park–Miller, seed 7) and cases: X random, A below it, its start bound to X's
 * bottom. `roughness` 0 is Lobby's; 1 is Excalidraw's default the probes used, with the rough-shape seeds
 * fixed so the run is deterministic (see support/excalidraw.ts).
 */
function cases(
  rounded: boolean,
  roughness: 0 | 1 = 0,
): { X: El; A: El; resize: { width: number; height: number } }[] {
  let seed = 7
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const out: { X: El; A: El; resize: { width: number; height: number } }[] = []
  for (let i = 0; i < CASES; i++) {
    const rot = i % 2 === 1
    const X = newRect({
      x: +(rnd() * 500).toFixed(2),
      y: +(rnd() * 500).toFixed(2),
      width: +(50 + rnd() * 300).toFixed(2),
      height: +(50 + rnd() * 300).toFixed(2),
      roughness,
    })
    const A = {
      ...newArrow({ x: 0, y: 0, roughness }),
      points: [
        [0, 0],
        [+(rnd() * 400 - 200).toFixed(2), +(rnd() * 400 + 50).toFixed(2)],
      ],
      angle: rot ? +(rnd() * 3).toFixed(3) : 0,
      startArrowhead: null,
      endArrowhead: 'arrow',
    }
    if (roughness === 1) {
      X.seed = 1000 + i
      A.seed = 5000 + i
    }
    bind(A, X, null, [+rnd().toFixed(3), 1])
    A.x = X.x + X.width / 2
    A.y = X.y + X.height + 5
    const S: Scene = new Map([
      [X.id, X],
      [A.id, A],
    ])
    const p = engine.updateBoundPoint(A, 'startBinding', A.startBinding, X, S)
    if (p) LinearElementEditor.movePoints(A, fakeScene(S), new Map([[0, { point: p }]]))
    if (rounded)
      A.points = A.points.map(([a, b]: Pt) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100])
    out.push({ X, A, resize: { width: +(X.width * 1.3).toFixed(2), height: +(X.height + 37.5).toFixed(2) } })
  }
  return out
}

describe('s1 sweep, client side (groups.ts only)', () => {
  for (const roughness of [0, 1] as const)
    for (const rounded of [false, true])
      it(`${CASES} resizes (${rounded ? 'rounded points' : 'raw points'}, roughness ${roughness}${roughness ? ', fixed seeds' : ''}), half rotated: no follow misclassified`, () => {
        let misclassified = 0
        let worst = 0
        for (const { X, A, resize } of cases(rounded, roughness)) {
          const S: Scene = new Map([
            [X.id, X],
            [A.id, A],
          ])
          const conf = cloneScene(S)
          const B = cloneScene(S)
          editTarget(B, X.id, resize)
          const c = compareArrowChange(B.get(A.id), conf.get(A.id), B, conf)
          if (!c.derived) misclassified++
          worst = Math.max(worst, c.userSetDelta)
        }
        expect(misclassified).toBe(0)
        expect(worst).toBeLessThanOrEqual(TOL)
      })
})

describe('s1 sweep against the room', () => {
  it(`${CASES} races: C's 60 px free-end drag commits first, then B's resize; no drag is lost`, {
    timeout: 600_000,
  }, async () => {
    const room = await freshBoard('s1-sweep')
    const all = cases(false)
    const S = await room.client('S')
    for (let i = 0; i < all.length; i += 250) await S.create(all.slice(i, i + 250).flatMap((c) => [c.X, c.A]))
    const C = await room.client('C')
    const B = await room.client('B')
    const Cm = C.copy()
    const Bm = B.copy()
    const drops = new Map<string, Pt>()
    const opsC = []
    const opsB = []
    for (const { X, A, resize } of all) {
      const fe = glob(Cm.get(A.id), -1, Cm)
      dragPoint(Cm, A.id, 1, [fe[0] + 60, fe[1]])
      drops.set(A.id, glob(Cm.get(A.id), -1, Cm))
      opsC.push(pathOp(Cm.get(A.id), C.confirmed.get(A.id)))
      editTarget(Bm, X.id, resize)
      expect(isDerivedArrowChange(Bm.get(A.id), B.confirmed.get(A.id), Bm, B.confirmed)).toBe(true)
      opsB.push(patchOf(Bm.get(X.id), B.confirmed.get(X.id)))
    }
    const [baseC, baseB] = [C.clock, B.clock]
    for (let i = 0; i < opsC.length; i += 500) {
      const ack = await C.push(opsC.slice(i, i + 500), baseC)
      expect(ack.r.every((r) => r.ok)).toBe(true)
    }
    for (let i = 0; i < opsB.length; i += 500) {
      const ack = await B.push(opsB.slice(i, i + 500), baseB)
      expect(ack.r.every((r) => r.ok)).toBe(true)
    }
    const stored = await room.stored()
    let lost = 0
    let worst = 0
    for (const { A } of all) {
      const d = dist(glob(stored.get(A.id), -1, stored), drops.get(A.id) as Pt)
      worst = Math.max(worst, d)
      if (d > TOL) lost++
    }
    expect({ lost, worst: worst <= TOL }).toEqual({ lost: 0, worst: true })
  })
})
