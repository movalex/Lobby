// C0 arrow acceptance test s5 (ported from scratchpad/critic-r34/s5-freetext.mjs, 3.5 rules): an arrow
// start-bound to a free text T, with a free end. A holds T's lease and types until T's box grows (a
// centred text also moves its own x: that goes out as A's fit, rule 1 of §2.9.4); C drags the free end
// meanwhile. Both orders, left- and centre-aligned. Pass: A's follow is derived; the arrow follows T (its
// start on T's final edge) and C's free end survives.

import { isDerivedArrowChange } from '@draftroom/canvas-schema/groups'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  bind,
  cloneScene,
  dist,
  dragPoint,
  type El,
  followError,
  glob,
  newArrow,
  newText,
  type Pt,
  type Scene,
  TOL,
  typeInText,
  useServerTextMetrics,
} from './support/excalidraw.ts'
import { pathOp } from './support/room.ts'
import { freshBoard } from './support/scenario.ts'

const TYPED = 'Hello, this grew a lot'
const DROP: Pt = [500, 300]

beforeAll(() => useServerTextMetrics())

function setup(align: 'left' | 'center'): { T: El; A: El } {
  const T = newText({
    x: 0,
    y: 0,
    text: 'Hello',
    fontSize: 20,
    fontFamily: 5,
    textAlign: align,
    verticalAlign: align === 'center' ? 'middle' : 'top',
    autoResize: true,
  })
  const A = {
    ...newArrow({ x: T.width + 5, y: T.height / 2 }),
    points: [
      [0, 0],
      [300, 200],
    ],
    startArrowhead: null,
    endArrowhead: 'arrow',
  }
  bind(A, T, null, [1, 0.5])
  return { T, A }
}

/** A's typing push for T: `text` and `layout`, and T's own x, y as a fit when typing moved them (3.5). */
function typingOp(local: El, confirmed: El) {
  const fit: Record<string, number> = {}
  for (const k of ['x', 'y'] as const) if (local[k] !== confirmed[k]) fit[k] = local[k]
  return {
    k: 'p' as const,
    id: local.id,
    pv: confirmed.version,
    g: {
      text: { originalText: local.originalText },
      layout: { text: local.text, width: local.width, height: local.height },
    },
    ...(Object.keys(fit).length ? { fit } : {}),
  }
}

describe('s5 client side (groups.ts only)', () => {
  for (const align of ['left', 'center'] as const)
    it(`${align}: typing changes T's ${align === 'left' ? 'width' : 'x and width'}; A's follow of it is derived`, () => {
      const { T, A } = setup(align)
      const S: Scene = new Map([
        [T.id, T],
        [A.id, A],
      ])
      const conf = cloneScene(S)
      const Am = cloneScene(S)
      typeInText(Am, T.id, TYPED)
      const changed = ['x', 'y', 'width', 'height'].filter((k) => Am.get(T.id)[k] !== conf.get(T.id)[k])
      expect(changed).toContain('width')
      if (align === 'center') expect(changed).toContain('x')
      else expect(changed).not.toContain('x')
      expect(isDerivedArrowChange(Am.get(A.id), conf.get(A.id), Am, conf)).toBe(true)
    })
})

describe('s5 against the room', () => {
  for (const align of ['left', 'center'] as const)
    for (const order of ['C-then-A', 'A-then-C'] as const)
      it(`${align}, ${order}: the arrow follows T's box and C's free end survives`, async () => {
        const room = await freshBoard(`s5-${align}-${order}`)
        const { T, A } = setup(align)
        const S = await room.client('S')
        await S.create([T, A])
        const Ac = await room.client('A')
        const C = await room.client('C')
        expect((await Ac.acquire(T.id)).type).toBe('lease.grant')
        const Am = Ac.copy()
        typeInText(Am, T.id, TYPED)
        expect(isDerivedArrowChange(Am.get(A.id), Ac.confirmed.get(A.id), Am, Ac.confirmed)).toBe(true) // A pushes T only
        const opA = typingOp(Am.get(T.id), Ac.confirmed.get(T.id))
        const Cm = C.copy()
        dragPoint(Cm, A.id, 1, DROP)
        const cDrop = glob(Cm.get(A.id), -1, Cm)
        const opC = pathOp(Cm.get(A.id), C.confirmed.get(A.id))
        const [baseA, baseC] = [Ac.clock, C.clock]
        if (order === 'C-then-A') {
          expect((await C.push([opC], baseC)).r[0]).toMatchObject({ ok: true })
          expect((await Ac.push([opA], baseA)).r[0]).toMatchObject({ ok: true })
        } else {
          expect((await Ac.push([opA], baseA)).r[0]).toMatchObject({ ok: true })
          expect((await C.push([opC], baseC)).r[0]).toMatchObject({ ok: true })
        }
        const stored = await room.stored()
        const t = stored.get(T.id)
        expect(t.originalText).toBe(TYPED)
        expect(t.width).toBe(Am.get(T.id).width)
        expect(t.x).toBe(Am.get(T.id).x) // the fit applied (nobody moved T)
        expect(dist(glob(stored.get(A.id), -1, stored), cDrop)).toBeLessThanOrEqual(TOL)
        expect(followError(stored, A.id)).toBeLessThanOrEqual(TOL)
      })
})
