// The converter on known shapes (OWNER: WS1, wave Q): what each SVG element becomes, the joins, the refusals the
// build report lists, and the fidelity gate. The every-icon proofs are in ./generate.test.ts.
import { IconGeometry, type IconPrimitive } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { convertIcon, RECT_BUDGET, referenceOf } from './convert.ts'
import type { IconNode } from './index.ts'
import { drawn, drawnCornerRadius, hausdorff, ICON_MAX_HAUSDORFF } from './measure.ts'

const path = (d: string, extra: Record<string, string> = {}): IconNode => ['path', { d, ...extra }]

function ok(nodes: IconNode[]): IconPrimitive[] {
  const r = convertIcon(nodes)
  if (!r.ok) throw new Error(`refused: ${r.reason} ${r.detail}`)
  expect(IconGeometry.safeParse(r.geometry).success).toBe(true)
  return [...r.geometry]
}

describe('convertIcon', () => {
  it('circles and ellipses are ellipse primitives; a filled circle is filled', () => {
    expect(ok([['circle', { cx: '12', cy: '12', r: '10' }]])).toEqual([
      { t: 'ellipse', x: 2, y: 2, w: 20, h: 20 },
    ])
    expect(ok([['ellipse', { cx: 12, cy: 6, rx: 8, ry: 3 }]])).toEqual([
      { t: 'ellipse', x: 4, y: 3, w: 16, h: 6 },
    ])
    expect(ok([['circle', { cx: '7.5', cy: '7.5', r: '.5', fill: 'currentColor' }]])).toEqual([
      { t: 'ellipse', x: 7, y: 7, w: 1, h: 1, f: true },
    ])
  })

  it("Tabler's circles (two half arcs in a path) are ellipses too", () => {
    expect(ok([path('M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0')])).toEqual([
      { t: 'ellipse', x: 3, y: 3, w: 18, h: 18 },
    ])
    expect(ok([path('M11.5 7.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0 -1 0', { fill: 'currentColor' })])).toEqual([
      { t: 'ellipse', x: 11.5, y: 7, w: 1, h: 1, f: true },
    ])
  })

  it('a rect keeps its corner radius while Excalidraw draws that corner close enough, else becomes a line', () => {
    expect(ok([['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]])).toEqual([
      { t: 'rect', x: 3, y: 3, w: 18, h: 18, r: 2 },
    ])
    expect(ok([['rect', { width: '20', height: '8', x: '2', y: '8' }]])).toEqual([
      { t: 'rect', x: 2, y: 8, w: 20, h: 8 },
    ])
    // a pill: Excalidraw caps an adaptive radius at a quarter of the shorter side (here 1.5, not 3)
    expect(drawnCornerRadius(3, 20, 6)).toBe(1.5)
    const pill = ok([['rect', { width: '20', height: '6', x: '2', y: '9', rx: '3' }]])
    expect(pill).toHaveLength(1)
    expect(pill[0]?.t).toBe('line')
    expect((pill[0] as { closed?: true }).closed).toBe(true)
    // an elliptic corner (rx ≠ ry) has no rectangle either
    expect(ok([['rect', { width: '18', height: '12', x: '3', y: '6', rx: '3', ry: '1' }]])[0]?.t).toBe('line')
  })

  it("a rect corner is kept only within RECT_BUDGET (Excalidraw's quadratic corner is 0.061 r off the arc)", () => {
    const at = (r: number) =>
      hausdorff(
        referenceOf([['rect', { width: '18', height: '18', x: '3', y: '3', rx: String(r) }]]),
        drawn({ t: 'rect', x: 3, y: 3, w: 18, h: 18, r }),
      )
    expect(at(2)).toBeCloseTo(0.061 * 2, 2)
    expect(at(2)).toBeLessThanOrEqual(RECT_BUDGET)
    expect(at(3)).toBeGreaterThan(RECT_BUDGET)
    expect(ok([['rect', { width: '18', height: '18', x: '3', y: '3', rx: '3' }]])[0]?.t).toBe('line')
  })

  it('lines, polylines and polygons; a closed path is a closed line without its repeated point', () => {
    expect(ok([['line', { x1: '2', y1: '2', x2: '22', y2: '22' }]])).toEqual([
      { t: 'line', p: [2, 2, 22, 22] },
    ])
    expect(ok([['polyline', { points: '22 12 18 12 15 21 9 3' }]])).toEqual([
      { t: 'line', p: [22, 12, 18, 12, 15, 21, 9, 3] },
    ])
    expect(ok([['polygon', { points: '12 2 22 22 2 22' }]])).toEqual([
      { t: 'line', p: [12, 2, 22, 22, 2, 22], closed: true },
    ])
    expect(ok([path('M6 14h2v2h-2v-2', { fill: 'currentColor' })])).toEqual([
      { t: 'line', p: [6, 14, 8, 14, 8, 16, 6, 16], closed: true, f: true },
    ])
  })

  it('a dot (a 0.01 long stroke) keeps two points, so Excalidraw draws its round cap', () => {
    expect(ok([path('M12 17h.01')])).toEqual([{ t: 'line', p: [12, 17, 12.01, 17] }])
  })

  it('joins open strokes that meet end to end, and continuous subpaths (m0 0)', () => {
    expect(ok([path('M5 12h7'), path('M12 12h7'), path('M2 2l3 3')])).toEqual([
      { t: 'line', p: [5, 12, 12, 12, 19, 12] },
      { t: 'line', p: [2, 2, 5, 5] },
    ])
    // reversed: B's end meets A's end
    expect(ok([path('M5 12h7'), path('M19 12h-7')])).toEqual([{ t: 'line', p: [5, 12, 12, 12, 19, 12] }])
  })

  it('a closed subpath followed by a continuous open one is not closed back to the first start (lucide headset)', () => {
    const nodes: IconNode[] = [
      path(
        'M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z',
      ),
    ]
    const r = convertIcon(nodes)
    expect(r.ok && r.hausdorff).toBeLessThanOrEqual(ICON_MAX_HAUSDORFF)
  })

  it('refuses what Excalidraw cannot draw: fill-only parts, holes, unknown attributes, too many parts', () => {
    const refused = (nodes: IconNode[]) => {
      const r = convertIcon(nodes)
      return r.ok ? 'ok' : r.reason
    }
    const pie = path('M12 3a9 9 0 0 1 8 5l-8 4z', { fill: 'currentColor', stroke: 'none' })
    expect(refused([pie])).toBe('fill-only-part')
    expect(refused([path('M2 2h20v20h-20zM8 8h8v8h-8z', { fill: 'currentColor' })])).toBe('holed-fill')
    expect(refused([path('M2 2h20', { opacity: '.5' })])).toBe('unsupported-attribute')
    expect(refused([path('M2 2h20', { 'fill-rule': 'evenodd' })])).toBe('unsupported-attribute')
    expect(refused([path('M2 2h20', { fill: '#f00' })])).toBe('unsupported-attribute')
    expect(refused([['image', { href: 'x.png' }]])).toBe('unsupported-element')
    expect(refused([path('M2 2h20 X')])).toBe('malformed')
    expect(refused(Array.from({ length: 13 }, (_, n) => path(`M${n} 2v3`)))).toBe('too-many-parts')
    expect(refused([path('M-5 2h3')])).toBe('outside-grid')
    expect(refused([])).toBe('empty')
    // a part with neither stroke nor fill draws nothing and is skipped
    expect(ok([path('M0 0h24v24H0z', { stroke: 'none', fill: 'none' }), path('M2 2h20')])).toEqual([
      { t: 'line', p: [2, 2, 22, 2] },
    ])
    // two separate filled islands are two fills
    expect(ok([path('M2 2h4v4h-4zM10 10h4v4h-4z', { fill: 'currentColor' })])).toHaveLength(2)
  })

  it('rounds to two decimals and never writes -0', () => {
    const [line] = ok([path('M0.004 1.23456L2.005 -0.001')])
    expect(line).toEqual({ t: 'line', p: [0, 1.23, 2.01, 0] })
    expect(Object.is((line as { p: number[] }).p[3], -0)).toBe(false)
  })
})
