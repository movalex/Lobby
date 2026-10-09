// L8-3: the polygon pieces are built the way canvas-ux's polygon tools build theirs (D4): a closed `line` under
// a see-through box, grouped. The flowchart's data shape is canvas-ux's "rhombus" (a parallelogram), point for
// point; this keeps the two in step if either changes.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { instantiatePiece } from '@draftroom/templates/pieces'
import { describe, expect, it } from 'vitest'
import { polygonPoints } from '../canvas-ux/ported/polygons.ts'

installServerTextMetrics()

describe('the data piece and canvas-ux’s rhombus', () => {
  it('have the same outline for the same box', () => {
    const piece = instantiatePiece('data', { origin: { x: 0, y: 0 } })
    const line = piece.elements.find((e) => e.type === 'line')
    expect(line).toBeTruthy()
    if (line?.type !== 'line') return
    const mine = line.points.map(([x, y]) => [x + line.x, y + line.y])
    const theirs = polygonPoints('rhombus', line.width, line.height)
    // the line starts at the first corner: compare in the box's own space
    const first = theirs[0] as [number, number]
    const rel = theirs.map(([x, y]) => [
      Math.round((x - first[0]) * 100) / 100,
      Math.round((y - first[1]) * 100) / 100,
    ])
    expect(line.points.map(([x, y]) => [x, y])).toEqual(rel)
    expect(mine[0]).toEqual([line.x, line.y])
  })
})
