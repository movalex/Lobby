// D1 (W5-08): the bound arrows of another person's drag, re-routed on copies (wave 5, 2C).
import * as element from '@excalidraw/element'
import { beforeAll, describe, expect, it } from 'vitest'
import { bind, glob, newArrow, newRect } from '../sync/testing/excalidraw.ts'
import type { SceneElement } from '../sync/types.ts'
import { arrowPaths, planDragArrows } from './drag-arrows.ts'

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window ??= globalThis
  ;(element as unknown as { setCustomTextMetricsProvider(p: unknown): void }).setCustomTextMetricsProvider({
    getLineWidth: (t: string) => t.length * 10,
  })
})

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element objects
type El = any

function scene() {
  const a = newRect({ id: 'A', x: 0, y: 0, width: 100, height: 100 })
  const b = newRect({ id: 'B', x: 400, y: 0, width: 100, height: 100 })
  const arrow = newArrow({
    id: 'ar',
    x: 100,
    y: 50,
    width: 300,
    height: 0,
    endArrowhead: 'arrow',
    points: [
      [0, 0],
      [300, 0],
    ],
  })
  bind(arrow, a, b, [1, 0.5], [0, 0.5])
  const map = new Map<string, El>([
    ['A', a],
    ['B', b],
    ['ar', arrow],
  ])
  return map as unknown as Map<string, SceneElement>
}

describe('planDragArrows', () => {
  it('an arrow with one end on a dragged element is re-routed on a copy: that end follows, the other stays', () => {
    const map = scene()
    const before = structuredClone(map.get('ar')) as El
    const plan = planDragArrows(map, new Map([['A', { x: 0, y: 200 }]]))
    expect(plan.moveWith.size).toBe(0)
    expect(plan.reroute).toHaveLength(1)
    const copy = plan.reroute[0] as El
    const local = new Map<string, El>([...map].map(([k, v]) => [k, v]))
    local.set('ar', copy)
    const start = glob(copy, 0, local)
    const end = glob(copy, copy.points.length - 1, local)
    // the start went down with A (by ~200), the end stays on B's near side (it slides along it)
    expect(start[1]).toBeGreaterThan(150)
    expect(Math.abs(end[0] - glob(before, 1, map as never)[0])).toBeLessThan(10)
    expect(end[1]).toBeGreaterThanOrEqual(0)
    expect(end[1]).toBeLessThanOrEqual(100)
    // the scene itself is untouched (drawing only)
    expect(map.get('ar')).toEqual(before)
    expect((map.get('A') as El).y).toBe(0)
  })

  it('an arrow whose two ends move together moves with them (an offset, no copy)', () => {
    const plan = planDragArrows(
      scene(),
      new Map([
        ['A', { x: 30, y: 40 }],
        ['B', { x: 30, y: 40 }],
      ]),
    )
    expect(plan.reroute).toEqual([])
    expect(plan.moveWith.get('ar')).toEqual({ x: 30, y: 40 })
  })

  it('a dragged arrow, or one bound to nothing dragged, is left alone', () => {
    const map = scene()
    expect(planDragArrows(map, new Map([['ar', { x: 5, y: 5 }]])).reroute).toEqual([])
    expect(planDragArrows(map, new Map([['other', { x: 5, y: 5 }]])).reroute).toEqual([])
  })
})

describe('arrowPaths', () => {
  it('draws the copy with Excalidraw’s own shape generator: the shaft and its head, as SVG paths', () => {
    const plan = planDragArrows(scene(), new Map([['A', { x: 0, y: 200 }]]))
    const paths = arrowPaths(plan.reroute[0], 'light')
    expect(paths.length).toBeGreaterThanOrEqual(2)
    for (const p of paths) {
      expect(p.d).toMatch(/^M/)
      expect(p.strokeWidth).toBeGreaterThan(0)
    }
  })
})
