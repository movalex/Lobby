// D4: the polygon tools' geometry (./polygons.ts) is the converter's (CR-2B-2: canvas-schema engine/
// geo-outlines.ts `geoOutline`, which the converter builds a converted geo's outline from), so a converted
// board's shapes and new ones are alike; the drag box; the holder test.
import { createTableTextMetrics, geoOutline } from '@draftroom/canvas-schema/engine'
import { describe, expect, it } from 'vitest'
import { convertBoard, type TlRecord } from '../../../../../../packages/tldraw-import/src/index.ts'
import { toRichText } from '../../../../../../packages/tldraw-import/src/tldraw.ts'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import {
  dragBox,
  isPolygonHolder,
  isPolygonLine,
  isPolygonTool,
  POLYGON_TOOLS,
  type PolygonKind,
  polygonGeometry,
  polygonHolderAt,
  polygonPoints,
} from './polygons.ts'

/** A tldraw geo shape of `kind` at (x, y), w × h, unrotated and unflipped, converted by the real converter. */
function converted(kind: PolygonKind, x: number, y: number, w: number, h: number) {
  const records = [
    { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
    { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
    {
      id: 'shape:p1',
      typeName: 'shape',
      type: 'geo',
      parentId: 'page:page',
      index: 'a2',
      x,
      y,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {
        geo: kind,
        dash: 'draw',
        url: '',
        w,
        h,
        growY: 0,
        scale: 1,
        labelColor: 'black',
        color: 'blue',
        fill: 'none',
        size: 'm',
        font: 'draw',
        align: 'middle',
        verticalAlign: 'middle',
        richText: toRichText(''),
      },
    },
  ] as unknown as TlRecord[]
  const conv = convertBoard(records, { updatedAt: 1, metrics: createTableTextMetrics() })
  expect(conv.failures).toEqual([])
  const line = conv.elements.find((e) => e.id === 'p1.o') as unknown as {
    x: number
    y: number
    points: [number, number][]
    width: number
    height: number
  }
  expect(line, kind).toBeDefined()
  return line
}

describe('polygonPoints (D4, CR-2B-2)', () => {
  it('is the converter’s outline (canvas-schema geoOutline) for every polygon tool, closed', () => {
    for (const { id } of POLYGON_TOOLS) {
      for (const [w, h] of [
        [200, 200],
        [300, 120],
      ] as const) {
        const ours = polygonPoints(id, w, h, 'g-seed')
        const theirs = geoOutline(id, w, h, { seed: 'g-seed', size: 'm', scale: 1 })
        expect(ours, id).toEqual(theirs)
        expect(ours[0]).toEqual(ours[ours.length - 1])
      }
    }
  })

  it('a shape drawn with a tool is the converted tldraw shape of the same kind and box (no 57 px octagon gap)', () => {
    for (const { id } of POLYGON_TOOLS) {
      const theirs = converted(id, 120, 80, 260, 180)
      // the converter seeds a cloud's bumps with the tldraw shape id; a tool with the new shape's group id
      const ours = polygonGeometry(id, { x: 120, y: 80, width: 260, height: 180 }, 'shape:p1')
      expect([ours.x, ours.y, ours.width, ours.height], id).toEqual([
        theirs.x,
        theirs.y,
        theirs.width,
        theirs.height,
      ])
      expect(ours.points, id).toEqual(theirs.points)
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
