// OWNER: 3a. W5-11: a connector's `inside` ends move onto their shapes' outlines (./connector-outline.ts).
import { newArrowElement, newElement, newFrameElement } from '@excalidraw/element'
import type { ExcalidrawElement } from '@excalidraw/element/types'
import { describe, expect, it } from 'vitest'
import { connectorOutlinePatch } from './connector-outline.ts'

const style = {
  strokeColor: '#1e1e1e',
  backgroundColor: '#ffffff',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  roundness: null,
} as const

/** Two filled boxes, A at x 100-300 and B at x 600-800, both y 100-220. */
function boxes() {
  const a = newElement({ ...style, type: 'rectangle', x: 100, y: 100, width: 200, height: 120 })
  const b = newElement({ ...style, type: 'rectangle', x: 600, y: 100, width: 200, height: 120 })
  return { a, b }
}

/** A connector from (sx, sy) to (ex, ey) with the given bindings. */
function arrow(
  from: [number, number],
  to: [number, number],
  start: { elementId: string; fixedPoint: [number, number]; mode: 'inside' | 'orbit' } | null,
  end: { elementId: string; fixedPoint: [number, number]; mode: 'inside' | 'orbit' } | null,
) {
  const el = newArrowElement({
    ...style,
    type: 'arrow',
    x: from[0],
    y: from[1],
    width: to[0] - from[0],
    height: to[1] - from[1],
    points: [
      [0, 0],
      [to[0] - from[0], to[1] - from[1]],
    ] as never,
    endArrowhead: 'arrow',
  })
  return { ...el, startBinding: start, endBinding: end } as unknown as ExcalidrawElement
}

const scenePoint = (
  p: { x: number; y: number; points: readonly (readonly [number, number])[] },
  i: number,
) => {
  const q = p.points[i < 0 ? p.points.length + i : i] as readonly [number, number]
  return [p.x + q[0], p.y + q[1]] as const
}

describe('connectorOutlinePatch (W5-11)', () => {
  it('ends a centre-to-centre connector on both outlines, one binding gap out, keeping the anchors', () => {
    const { a, b } = boxes()
    const c = arrow(
      [180, 150],
      [720, 170],
      { elementId: a.id, fixedPoint: [0.4, 0.42], mode: 'inside' },
      { elementId: b.id, fixedPoint: [0.6, 0.58], mode: 'inside' },
    )
    const patch = connectorOutlinePatch(c, [a, b, c])
    expect(patch).not.toBeNull()
    if (!patch) return
    expect(patch.startBinding).toMatchObject({ elementId: a.id, fixedPoint: [0.4, 0.42], mode: 'orbit' })
    expect(patch.endBinding).toMatchObject({ elementId: b.id, fixedPoint: [0.6, 0.58], mode: 'orbit' })
    const [sx, sy] = scenePoint(patch, 0)
    const [ex, ey] = scenePoint(patch, -1)
    // A's right side (x 300) and B's left side (x 600), each a gap (5 + stroke / 2) outside the shape
    expect(sx).toBeGreaterThan(300)
    expect(sx).toBeLessThan(310)
    expect(ex).toBeLessThan(600)
    expect(ex).toBeGreaterThan(590)
    expect(sy).toBeGreaterThan(100)
    expect(sy).toBeLessThan(220)
    expect(ey).toBeGreaterThan(100)
    expect(ey).toBeLessThan(220)
    // the first point is the origin, the box is the points' box
    expect(patch.points[0]).toEqual([0, 0])
    expect(patch.width).toBeCloseTo(Math.abs(ex - sx), 5)
    expect(patch.height).toBeCloseTo(Math.abs(ey - sy), 5)
  })

  it('moves only the inside end; an orbit end and a free end stay where they are', () => {
    const { a, b } = boxes()
    const c = arrow([450, 160], [720, 160], null, { elementId: b.id, fixedPoint: [0.6, 0.5], mode: 'inside' })
    const patch = connectorOutlinePatch(c, [a, b, c])
    expect(patch).not.toBeNull()
    if (!patch) return
    expect(scenePoint(patch, 0)).toEqual([450, 160])
    const [ex] = scenePoint(patch, -1)
    expect(ex).toBeLessThan(600)
    expect(ex).toBeGreaterThan(590)
    expect(patch.startBinding).toBeNull()
    expect(patch.endBinding?.mode).toBe('orbit')
  })

  it('moves an orbit end the engine left inside its shape (the start of a connector drawn out of one)', () => {
    const { a, b } = boxes()
    const c = arrow([180, 150], [595, 160], { elementId: a.id, fixedPoint: [0.4, 0.42], mode: 'orbit' }, null)
    const patch = connectorOutlinePatch(c, [a, b, c])
    expect(patch).not.toBeNull()
    if (!patch) return
    const [sx] = scenePoint(patch, 0)
    expect(sx).toBeGreaterThan(300)
    expect(sx).toBeLessThan(310)
    expect(scenePoint(patch, -1)[0]).toBeCloseTo(595, 5)
  })

  it('leaves connectors with nothing to move: ends already on the outlines, frame targets, one shape at both ends, elbows', () => {
    const { a, b } = boxes()
    const frame = newFrameElement({ x: 0, y: 0, width: 1000, height: 600 })
    const drawn = arrow(
      [180, 150],
      [720, 170],
      { elementId: a.id, fixedPoint: [0.4, 0.42], mode: 'inside' },
      { elementId: b.id, fixedPoint: [0.6, 0.58], mode: 'inside' },
    )
    const once = connectorOutlinePatch(drawn, [a, b, drawn])
    const outlined = { ...drawn, ...once } as unknown as ExcalidrawElement
    expect(connectorOutlinePatch(outlined, [a, b, outlined]), 'a second pass writes nothing').toBeNull()
    const toFrame = arrow([305, 160], [450, 400], null, {
      elementId: frame.id,
      fixedPoint: [0.45, 0.66],
      mode: 'inside',
    })
    expect(connectorOutlinePatch(toFrame, [frame, a, toFrame])).toBeNull()
    const within = arrow(
      [120, 120],
      [280, 200],
      { elementId: a.id, fixedPoint: [0.1, 0.17], mode: 'inside' },
      { elementId: a.id, fixedPoint: [0.9, 0.83], mode: 'inside' },
    )
    expect(connectorOutlinePatch(within, [a, within])).toBeNull()
    const elbow = {
      ...arrow([180, 150], [720, 170], { elementId: a.id, fixedPoint: [0.4, 0.42], mode: 'inside' }, null),
      elbowed: true,
    } as ExcalidrawElement
    expect(connectorOutlinePatch(elbow, [a, b, elbow])).toBeNull()
    expect(connectorOutlinePatch(a, [a, b])).toBeNull()
  })
})
