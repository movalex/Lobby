// D4: the polygon tools' geometry (./polygons.ts) is the converter's (packages/tldraw-import geometry.ts
// `polygonOf`), so a converted board's shapes and new ones are alike; the drag box; the holder test.
import { describe, expect, it } from 'vitest'
import { polygonOf } from '../../../../../../packages/tldraw-import/src/geometry.ts'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import {
  dragBox,
  isPolygonHolder,
  isPolygonLine,
  isPolygonTool,
  POLYGON_TOOLS,
  polygonGeometry,
  polygonHolderAt,
  polygonPoints,
} from './polygons.ts'

describe('polygonPoints (D4)', () => {
  it('is the converter’s outline for every polygon tool, closed', () => {
    for (const { id } of POLYGON_TOOLS) {
      for (const [w, h] of [
        [200, 200],
        [300, 120],
      ] as const) {
        const ours = polygonPoints(id, w, h)
        const theirs = polygonOf(id, w, h)
        expect(ours.length, id).toBe(theirs.length)
        ours.forEach(([x, y], i) => {
          expect(x, `${id} x${i}`).toBeCloseTo(theirs[i]?.[0] ?? Number.NaN, 9)
          expect(y, `${id} y${i}`).toBeCloseTo(theirs[i]?.[1] ?? Number.NaN, 9)
        })
        expect(ours[0]).toEqual(ours[ours.length - 1])
      }
    }
  })

  it('a line geometry starting at its first point, inside the box', () => {
    const g = polygonGeometry('triangle', { x: 100, y: 50, width: 200, height: 160 })
    expect([g.x, g.y]).toEqual([200, 50])
    expect(g.points[0]).toEqual([0, 0])
    expect(g.points).toEqual([
      [0, 0],
      [100, 160],
      [-100, 160],
      [0, 0],
    ])
    expect([g.width, g.height]).toEqual([200, 160])
  })
})

describe('the polygon tools', () => {
  it('are told apart from the other tools', () => {
    expect(isPolygonTool('star')).toBe(true)
    expect(isPolygonTool('arrow-right')).toBe(true)
    expect(isPolygonTool('arrow')).toBe(false)
    expect(isPolygonTool('rectangle')).toBe(false)
    expect(isPolygonTool(null)).toBe(false)
  })

  it('drag box: any direction, Shift a square on the longer side', () => {
    expect(dragBox({ x: 300, y: 260 }, { x: 100, y: 100 }, false)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 160,
    })
    expect(dragBox({ x: 100, y: 100 }, { x: 300, y: 160 }, true)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 200,
    })
    expect(dragBox({ x: 100, y: 100 }, { x: 40, y: 0 }, true)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })
  })

  it('a holder is a see-through rectangle grouped with a polygon line', () => {
    const line = { id: 'l', type: 'line', polygon: true, groupIds: ['g1'] } as unknown as CanvasElement
    const holder = {
      id: 'h',
      type: 'rectangle',
      strokeColor: 'transparent',
      backgroundColor: 'transparent',
      groupIds: ['g1'],
    } as unknown as CanvasElement
    const plain = { ...holder, id: 'p', groupIds: ['g2'] } as unknown as CanvasElement
    const seen = { ...holder, id: 's', strokeColor: '#1e1e1e' } as unknown as CanvasElement
    const canvas = { items: () => [line, holder, plain, seen] }
    expect(isPolygonLine(line)).toBe(true)
    expect(isPolygonLine(holder)).toBe(false)
    expect(isPolygonHolder(holder, canvas)).toBe(true)
    expect(isPolygonHolder(plain, canvas), 'no polygon in its group').toBe(false)
    expect(isPolygonHolder(seen, canvas), 'a drawn outline').toBe(false)
    expect(isPolygonHolder(line, canvas)).toBe(false)
  })

  it('a double-click labels the polygon: its holder, the holder of its outline, or the one whose box holds the point', () => {
    const line = { id: 'l', type: 'line', polygon: true, groupIds: ['g1'] } as unknown as CanvasElement
    const holder = {
      id: 'h',
      type: 'rectangle',
      strokeColor: 'transparent',
      backgroundColor: 'transparent',
      groupIds: ['g1'],
    } as unknown as CanvasElement
    const note = { id: 'n', type: 'stickynote', groupIds: [] } as unknown as CanvasElement
    const canvas = {
      items: () => [line, holder, note],
      bounds: (id: string) => (id === 'h' ? { x: 0, y: 0, width: 100, height: 100 } : null),
    }
    expect(polygonHolderAt(canvas, { x: 5, y: 5 }, holder)?.id).toBe('h')
    expect(polygonHolderAt(canvas, { x: 5, y: 5 }, line)?.id).toBe('h')
    expect(polygonHolderAt(canvas, { x: 50, y: 50 }, null)?.id).toBe('h')
    expect(polygonHolderAt(canvas, { x: 150, y: 50 }, null)).toBeNull()
    expect(polygonHolderAt(canvas, { x: 50, y: 50 }, note), 'a note over it edits the note').toBeNull()
  })
})
