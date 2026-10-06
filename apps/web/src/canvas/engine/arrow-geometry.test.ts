// W5-53 (wave J, J6a): arrowheads about twice tldraw's size, and bound connectors that stopped 4-6 px short of
// the shape they join. Both live inside @excalidraw/element, so they are fixed by ONE pnpm patch of it
// (patches/@excalidraw__element@0.18.0-1118751.patch, `patchedDependencies` in pnpm-workspace.yaml). This file
// pins the patch's behaviour in BOTH builds the app can load (dist/dev is what Vitest and the dev server read,
// dist/prod, minified, is what the web bundle and the sync service read), and fails when the patch is not applied.
//
// The patch, to redo it after an @excalidraw/element bump (`pnpm patch @excalidraw/element@<version>`, edit the
// copy in the dir pnpm names, `pnpm patch-commit <dir>`, then restore the comments pnpm-workspace.yaml loses):
//   1. binding.ts: next to `BASE_BINDING_GAP = 5` add `getOrbitBindingGap = (t) => 1 + t.strokeWidth / 2`.
//   2. binding.ts `updateBoundPoint`: its two `intersectElementWithLineSegment(..., getBindingGap(x))` calls (the
//      bound end's `outlinePoint` and the other end's `otherOutlinePoint`) take `getOrbitBindingGap(x)`. Nothing
//      else changes: `getBindingGap`, `BASE_BINDING_GAP`, the elbow router's paired padding, the hit thresholds.
//   3. bounds.ts: next to `getArrowheadSize` add `getArrowheadStrokeScale = (w) => min(1, max(0.4, w / 4))`, and in
//      `getArrowheadPoints` multiply `getArrowheadSize(arrowhead)` by `getArrowheadStrokeScale(element.strokeWidth)`.
//   4. export both from dist/dev/index.js and dist/prod/index.js, and declare them in dist/types/.../binding.d.ts
//      and bounds.d.ts (the prod build is minified: the names `Be` / `Gt` / `ox` / `rt` are the build's own).
//
// Numbers (the default 2 px stroke, Lobby's "medium"): an orbit end sits 2 px off the outline (was 6: 5 + 2 / 2),
// which is 1 px clear of the target's own 2 px stroke; the "arrow" head's barbs are 12.5 px (was 25), the triangle,
// bar and dot 7.5 (was 15). The 4 px stroke keeps the engine's sizes, the 1 px stroke is floored at 0.4 of them.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// biome-ignore lint/suspicious/noExplicitAny: the engine module, one per build, typed loosely on purpose
type Engine = any
// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's own element objects
type El = any

const require = createRequire(import.meta.url)
/** `dist/` of the @excalidraw/element copy the workspace resolves (the patched one). */
const DIST = dirname(dirname(require.resolve('@excalidraw/element')))
const BUILDS = ['dev', 'prod'] as const
const load = (build: (typeof BUILDS)[number]): Promise<Engine> =>
  import(/* @vite-ignore */ pathToFileURL(join(DIST, build, 'index.js')).href)

const STYLE = {
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  roundness: null,
} as const

const OLD_BASE_GAP = 5 // the engine's own getBindingGap = 5 + strokeWidth / 2, still what everything else reads
const STROKES = [1, 2, 4] as const

/** The engine's own head sizes before the patch (getArrowheadSize), which the stroke scale multiplies. */
const BASE_SIZE = { arrow: 25, triangle: 15, bar: 15, diamond: 12 } as const

describe.each(BUILDS)('W5-53, the %s build of @excalidraw/element', (build) => {
  const engine = load(build)

  it('carries the patch: getOrbitBindingGap and getArrowheadStrokeScale are exported (an unpatched copy fails here)', async () => {
    const X = await engine
    expect(typeof X.getOrbitBindingGap, `${build}: getOrbitBindingGap`).toBe('function')
    expect(typeof X.getArrowheadStrokeScale, `${build}: getArrowheadStrokeScale`).toBe('function')
  })

  describe('the binding gap: a bound end in orbit mode sits 1 + strokeWidth / 2 off its target, not 5 + strokeWidth / 2', () => {
    it('is the formula, for every stroke, and a bad stroke width reads as 0', async () => {
      const X = await engine
      for (const strokeWidth of [0, 1, 2, 3.5, 4, 8.25])
        expect(X.getOrbitBindingGap({ strokeWidth })).toBe(1 + strokeWidth / 2)
      expect(X.getOrbitBindingGap({ strokeWidth: Number.NaN })).toBe(1)
      expect(X.getOrbitBindingGap({})).toBe(1)
    })

    it('leaves the engine’s own gap alone: everything that is not the placement of an orbit end still reads it', async () => {
      const X = await engine
      expect(X.BASE_BINDING_GAP).toBe(OLD_BASE_GAP)
      for (const strokeWidth of STROKES)
        expect(X.getBindingGap({ strokeWidth })).toBe(OLD_BASE_GAP + strokeWidth / 2)
    })

    /** Where `updateBoundPoint` puts the bound end of a horizontal arrow aimed at the middle of `target`, in scene x. */
    async function endOf(
      X: Engine,
      target: El,
      over: { strokeWidth: number; endArrowhead?: string | null },
    ): Promise<number> {
      const arrow = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        strokeWidth: over.strokeWidth,
        x: 700,
        y: 160,
        width: -300,
        height: 0,
        points: [
          [0, 0],
          [-300, 0],
        ],
        endArrowhead: over.endArrowhead === undefined ? 'arrow' : over.endArrowhead,
      })
      const bound = { ...arrow, endBinding: { elementId: target.id, fixedPoint: [0.5, 0.5], mode: 'orbit' } }
      const map = new Map<string, El>([
        [target.id, target],
        [bound.id, bound],
      ])
      const p = X.updateBoundPoint(bound, 'endBinding', bound.endBinding, target, map)
      expect(p, 'the end is placed').not.toBeNull()
      return bound.x + p[0]
    }

    it.each(['rectangle', 'ellipse'] as const)(
      'a %s: the end is exactly the orbit gap off the outline, whatever the strokes',
      async (type) => {
        const X = await engine
        for (const strokeWidth of STROKES) {
          const target = X.newElement({
            ...STYLE,
            type,
            strokeWidth,
            x: 100,
            y: 100,
            width: 200,
            height: 120,
          })
          // the arrow comes from the right, so it meets the right side (x = 300)
          for (const endArrowhead of ['arrow', null]) {
            const end = await endOf(X, target, { strokeWidth, endArrowhead })
            // (the ellipse's intersection is solved numerically: a millionth of a pixel)
            expect(end - 300, `${type} sw ${strokeWidth} head ${endArrowhead}`).toBeCloseTo(
              1 + strokeWidth / 2,
              4,
            )
            // 4-6 px short was the old gap; the new one is at most 3.5 px off even for the 4 px stroke
            expect(end - 300).toBeLessThan(OLD_BASE_GAP + strokeWidth / 2 - 3)
          }
        }
      },
    )

    it('a diamond: the end is near the vertex, well inside what the old gap gave', async () => {
      const X = await engine
      for (const strokeWidth of STROKES) {
        const target = X.newElement({
          ...STYLE,
          type: 'diamond',
          strokeWidth,
          x: 100,
          y: 100,
          width: 200,
          height: 120,
        })
        const end = await endOf(X, target, { strokeWidth })
        expect(end - 300).toBeGreaterThan(0)
        expect(end - 300).toBeLessThan(OLD_BASE_GAP + strokeWidth / 2 - 2)
      }
    })

    it('both ends bound: each sits its own target’s orbit gap off it (the other-end outline uses the same gap)', async () => {
      const X = await engine
      const a = X.newElement({
        ...STYLE,
        type: 'rectangle',
        strokeWidth: 4,
        x: 100,
        y: 100,
        width: 200,
        height: 120,
      })
      const b = X.newElement({
        ...STYLE,
        type: 'rectangle',
        strokeWidth: 1,
        x: 600,
        y: 100,
        width: 200,
        height: 120,
      })
      const arrow = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        x: 180,
        y: 160,
        width: 540,
        height: 0,
        points: [
          [0, 0],
          [540, 0],
        ],
        endArrowhead: 'arrow',
      })
      const bound = {
        ...arrow,
        startBinding: { elementId: a.id, fixedPoint: [0.4, 0.5], mode: 'orbit' },
        endBinding: { elementId: b.id, fixedPoint: [0.6, 0.5], mode: 'orbit' },
      }
      const map = new Map<string, El>([
        [a.id, a],
        [b.id, b],
        [bound.id, bound],
      ])
      const start = X.updateBoundPoint(bound, 'startBinding', bound.startBinding, a, map)
      const end = X.updateBoundPoint(bound, 'endBinding', bound.endBinding, b, map)
      expect(bound.x + start[0] - 300).toBeCloseTo(1 + 4 / 2, 6) // a's right side, its 4 px stroke
      expect(600 - (bound.x + end[0])).toBeCloseTo(1 + 1 / 2, 6) // b's left side, its 1 px stroke
    })

    it('an end that is the whole outline away from its target (a vertical approach to the top side) agrees', async () => {
      const X = await engine
      const target = X.newElement({
        ...STYLE,
        type: 'rectangle',
        strokeWidth: 2,
        x: 100,
        y: 300,
        width: 200,
        height: 120,
      })
      const arrow = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        x: 200,
        y: 0,
        width: 0,
        height: 360,
        points: [
          [0, 0],
          [0, 360],
        ],
        endArrowhead: 'arrow',
      })
      const bound = { ...arrow, endBinding: { elementId: target.id, fixedPoint: [0.5, 0.5], mode: 'orbit' } }
      const map = new Map<string, El>([
        [target.id, target],
        [bound.id, bound],
      ])
      const p = X.updateBoundPoint(bound, 'endBinding', bound.endBinding, target, map)
      expect(300 - (bound.y + p[1])).toBeCloseTo(2, 6) // the top side is y = 300; 1 + 2 / 2
    })
  })

  describe('arrowheads: the size follows the stroke (the engine’s fixed 25 / 15 / 12 times clamp(strokeWidth / 4, 0.4, 1))', () => {
    it('the scale', async () => {
      const X = await engine
      expect(X.getArrowheadStrokeScale(4)).toBe(1)
      expect(X.getArrowheadStrokeScale(2)).toBe(0.5)
      expect(X.getArrowheadStrokeScale(1)).toBe(0.4) // floored: a hairline's head stays readable
      expect(X.getArrowheadStrokeScale(0)).toBe(0.4)
      expect(X.getArrowheadStrokeScale(Number.NaN)).toBe(0.4)
      expect(X.getArrowheadStrokeScale(3)).toBe(0.75)
      expect(X.getArrowheadStrokeScale(8)).toBe(1) // never bigger than the engine's own
      // the unscaled sizes the scale multiplies are untouched
      expect(X.getArrowheadSize('arrow')).toBe(BASE_SIZE.arrow)
      expect(X.getArrowheadSize('triangle')).toBe(BASE_SIZE.triangle)
      expect(X.getArrowheadSize('diamond')).toBe(BASE_SIZE.diamond)
    })

    /** A long horizontal arrow and the points of its head at the end (`getArrowheadPoints`, what is drawn). */
    function headOf(X: Engine, strokeWidth: number, head: string, length = 300) {
      const arrow = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        strokeWidth,
        x: 0,
        y: 0,
        width: length,
        height: 0,
        points: [
          [0, 0],
          [length, 0],
        ],
        endArrowhead: head,
      })
      const shape = X.ShapeCache.generateElementShape(arrow, null)
      return X.getArrowheadPoints(arrow, shape, 'end', head) as number[]
    }
    /** The barb's length: from the tip to the end of a wing. */
    const barb = (pts: number[]) => Math.hypot((pts[2] ?? 0) - (pts[0] ?? 0), (pts[3] ?? 0) - (pts[1] ?? 0))

    it.each(Object.entries(BASE_SIZE))(
      'the %s head (engine size %d) follows the stroke: 0.4 of it at 1 px, half at 2 px (about tldraw’s), whole at 4 px',
      async (head, base) => {
        const X = await engine
        for (const [strokeWidth, scale] of [
          [1, 0.4],
          [2, 0.5],
          [4, 1],
        ] as const) {
          const pts = headOf(X, strokeWidth, head)
          // the tip is the arrow's end
          expect(pts[0]).toBeCloseTo(300, 6)
          expect(pts[1]).toBeCloseTo(0, 6)
          // the diamond's wings are half-size along the axis (its far point is 2 sizes back): barb = size
          expect(barb(pts), `${head} at ${strokeWidth} px`).toBeCloseTo(base * scale, 6)
        }
        // and never the engine's old size at the default stroke
        expect(barb(headOf(X, 2, head))).toBeLessThan(base)
      },
    )

    it('the circle head (dot) scales with the stroke too: its diameter is the size plus the stroke less 2', async () => {
      const X = await engine
      expect(headOf(X, 2, 'circle')[2]).toBeCloseTo(15 * 0.5 + 2 - 2, 6)
      expect(headOf(X, 4, 'circle')[2]).toBeCloseTo(15 * 1 + 4 - 2, 6)
    })

    it('a short connector still caps its head at half its last segment, as before', async () => {
      const X = await engine
      // 16 px long: half is 8, below the 4 px stroke's 25 and the 2 px stroke's 12.5
      expect(barb(headOf(X, 4, 'arrow', 16))).toBeCloseTo(8, 6)
      expect(barb(headOf(X, 2, 'arrow', 16))).toBeCloseTo(8, 6)
      // 40 px long: half is 20: the 2 px stroke's 12.5 is now under it, the 4 px stroke's 25 is not
      expect(barb(headOf(X, 2, 'arrow', 40))).toBeCloseTo(12.5, 6)
      expect(barb(headOf(X, 4, 'arrow', 40))).toBeCloseTo(20, 6)
    })

    it('a head is drawn on the stroke of its own arrow, at either end', async () => {
      const X = await engine
      const arrow = X.newArrowElement({
        ...STYLE,
        type: 'arrow',
        strokeWidth: 2,
        x: 0,
        y: 0,
        width: 300,
        height: 0,
        points: [
          [0, 0],
          [300, 0],
        ],
        startArrowhead: 'arrow',
        endArrowhead: 'arrow',
      })
      const shape = X.ShapeCache.generateElementShape(arrow, null)
      for (const position of ['start', 'end'] as const) {
        const pts = X.getArrowheadPoints(arrow, shape, position, 'arrow') as number[]
        expect(barb(pts), position).toBeCloseTo(12.5, 6)
      }
    })
  })
})

describe('W5-53, the two builds agree', () => {
  /** A seeded generator (Park-Miller), so the sweep is the same on every run. */
  function rng(seed: number) {
    let s = seed
    return () => {
      s = (s * 16807) % 2147483647
      return s / 2147483647
    }
  }

  it('600 random bound ends: the minified prod build places every one where the dev build does, to a thousandth of a pixel', async () => {
    const [dev, prod] = await Promise.all(BUILDS.map(load))
    const rnd = rng(11)
    const types = ['rectangle', 'ellipse', 'diamond'] as const
    let worst = 0
    for (let i = 0; i < 600; i++) {
      const strokeWidth = [1, 2, 4][i % 3] as number
      const type = types[i % 3] as (typeof types)[number]
      const geo = {
        x: Math.round(rnd() * 400),
        y: Math.round(rnd() * 400),
        width: 60 + Math.round(rnd() * 260),
        height: 60 + Math.round(rnd() * 260),
      }
      const from: [number, number] = [Math.round(rnd() * 1200 - 200), Math.round(rnd() * 1200 - 200)]
      const fixedPoint: [number, number] = [0.1 + rnd() * 0.8, 0.1 + rnd() * 0.8]
      const place = (X: Engine) => {
        const target = X.newElement({ ...STYLE, type, strokeWidth, ...geo, id: 'target' })
        const dx = geo.x + geo.width * fixedPoint[0] - from[0]
        const dy = geo.y + geo.height * fixedPoint[1] - from[1]
        const arrow = X.newArrowElement({
          ...STYLE,
          type: 'arrow',
          id: 'arrow',
          x: from[0],
          y: from[1],
          width: dx,
          height: dy,
          points: [
            [0, 0],
            [dx, dy],
          ],
          endArrowhead: 'arrow',
        })
        const bound = { ...arrow, endBinding: { elementId: 'target', fixedPoint, mode: 'orbit' } }
        const map = new Map<string, El>([
          ['target', target],
          ['arrow', bound],
        ])
        const p = X.updateBoundPoint(bound, 'endBinding', bound.endBinding, target, map)
        return p ? ([bound.x + p[0], bound.y + p[1]] as const) : null
      }
      const a = place(dev)
      const b = place(prod)
      expect(Boolean(a), `case ${i}`).toBe(Boolean(b))
      if (a && b) worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
    }
    expect(worst).toBeLessThan(0.001)
  })
})
