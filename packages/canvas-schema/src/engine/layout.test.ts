// `layoutBoundText` (plan §2.9.4 rules 4 and 6): Excalidraw's own `redrawTextBoundingBox` for the label
// of a rectangle, ellipse or diamond, run in plain Node (no DOM, no real Scene) with the metrics table.

import { beforeAll, describe, expect, it } from 'vitest'
import { layoutBoundText } from './layout.ts'
import { installServerTextMetrics } from './text-metrics.ts'

const base = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roundness: null,
  roughness: 0,
  opacity: 100,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  groupIds: [],
  frameId: null,
  updated: 1,
  link: null,
  locked: false,
}
const words = 'a label long enough to wrap onto several lines'
const container = (type: string, width: number, height: number) => ({
  ...base,
  id: 'c1',
  type,
  x: 100,
  y: 50,
  width,
  height,
  index: 'a0',
  boundElements: [{ id: 'c1.t', type: 'text' }],
})
const label = {
  ...base,
  id: 'c1.t',
  type: 'text',
  x: 120,
  y: 68,
  width: 400,
  height: 25,
  index: 'a1',
  boundElements: null,
  text: words,
  originalText: words,
  fontSize: 20,
  fontFamily: 5,
  baseFontSize: null,
  textAlign: 'center',
  verticalAlign: 'middle',
  containerId: 'c1',
  autoResize: true,
  lineHeight: 1.25,
}

beforeAll(() => {
  installServerTextMetrics()
})

describe('layoutBoundText (redrawTextBoundingBox in Node)', () => {
  for (const type of ['rectangle', 'ellipse', 'diamond'])
    it(`${type}: re-wraps for a narrow container, grows its height, keeps its width, centres the label`, () => {
      const c = container(type, 160, 60)
      const before = JSON.stringify([c, label])
      const lay = layoutBoundText(c as never, label as never)
      expect(JSON.stringify([c, label])).toBe(before) // the inputs are not mutated
      expect(lay.text.text.split('\n').length).toBeGreaterThan(2)
      expect(lay.text.text.replace(/\n/g, ' ')).toBe(words)
      expect(lay.container.width).toBe(160)
      expect(lay.container.height).toBeGreaterThan(60)
      expect(lay.text.width).toBeLessThanOrEqual(160)
      // centred on the container's centre (within a pixel of rounding)
      expect(lay.text.x + lay.text.width / 2).toBeCloseTo(100 + 160 / 2, 0)
      expect(lay.text.y + lay.text.height / 2).toBeCloseTo(50 + lay.container.height / 2, 0)
      expect(lay.text.angle).toBe(0)
    })

  it('a wide container: one line, the container unchanged', () => {
    const lay = layoutBoundText(container('rectangle', 800, 60) as never, label as never)
    expect(lay.text.text).toBe(words)
    expect(lay.container).toEqual({ width: 800, height: 60 })
  })

  it('deterministic: the same input gives the same layout', () => {
    const a = layoutBoundText(container('ellipse', 140, 80) as never, label as never)
    const b = layoutBoundText(container('ellipse', 140, 80) as never, label as never)
    expect(a).toEqual(b)
  })
})
