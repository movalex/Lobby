// C0 arrow acceptance test: the drift probe scratchpad/lead-r35/drift-rot2.mjs. A start-bound arrow's
// target grows a little 1,000 times (as typing in a note does), so the room re-snaps the arrow 1,000 times.
// Pass (the 3.5 rounding rule: points and an UNROTATED arrow's x, y to 2 decimals; a rotated one's x, y
// unrounded): the free end, unrotated and rotated, is within GEOMETRY_TOLERANCE_PX of where it started.

import { describe, expect, it } from 'vitest'
import { bind, dist, type El, glob, newArrow, newRect, type Pt, TOL } from './support/excalidraw.ts'
import { freshBoard } from './support/scenario.ts'

const ANGLES = [0, 0.6, 2.2]
const RESNAPS = 1_000

describe('lead-r35 drift against the room', () => {
  it(`${RESNAPS} re-snaps at angles ${ANGLES.join(', ')}: no free end creeps past the tolerance`, {
    timeout: 600_000,
  }, async () => {
    const room = await freshBoard('r35-drift')
    const pairs = ANGLES.map((angle, i) => {
      const X = newRect({ x: 0, y: 1000 * i, width: 200, height: 100 })
      const A = {
        ...newArrow({ x: 205, y: 1000 * i + 50 }),
        points: [
          [0, 0],
          [300, 300],
        ],
        angle,
        startArrowhead: null,
        endArrowhead: 'arrow',
      }
      bind(A, X, null, [1, 0.5])
      return { X, A }
    })
    const S = await room.client('S')
    await S.create(pairs.flatMap((p) => [p.X, p.A]))
    const start = new Map<string, Pt>(
      pairs.map(({ A }) => [A.id, glob(S.confirmed.get(A.id), -1, S.confirmed)]),
    )
    const size = new Map<string, { width: number; height: number }>(
      pairs.map(({ X }) => [
        X.id,
        { width: S.confirmed.get(X.id).width, height: S.confirmed.get(X.id).height },
      ]),
    )
    const version = new Map<string, number>(pairs.map(({ X }) => [X.id, S.confirmed.get(X.id).version]))
    const pending: Promise<unknown>[] = []
    for (let i = 1; i <= RESNAPS; i++) {
      const ops = pairs.map(({ X }: { X: El }) => {
        const s = size.get(X.id) as { width: number; height: number }
        s.height = +(s.height + 0.37).toFixed(2)
        s.width = +(s.width + 0.11).toFixed(2)
        return {
          k: 'p' as const,
          id: X.id,
          pv: version.get(X.id) as number,
          g: { shape: { height: s.height, width: s.width } },
        }
      })
      pending.push(S.pushNow(ops).ack)
    }
    const acks = (await Promise.all(pending)) as { r: { ok: boolean }[] }[]
    expect(acks.every((a) => a.r.every((r) => r.ok))).toBe(true)
    const stored = await room.stored()
    for (const { X, A } of pairs) {
      expect(stored.get(X.id).height).toBeCloseTo(100 + 0.37 * RESNAPS, 6)
      const drift = dist(glob(stored.get(A.id), -1, stored), start.get(A.id) as Pt)
      expect(drift, `angle ${A.angle}`).toBeLessThanOrEqual(TOL)
    }
  })
})
