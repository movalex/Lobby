// L4-1: Alt+Arrow walks the connections (a11y/ported/traversal.ts, told the pressed arrow by features/flow) and
// the live region names them (a11y/ported/describe.ts). A board with no connectors walks the reading order as
// before.
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { connections, describeSelection } from '../a11y/ported/describe.ts'
import {
  connectedNeighbour,
  connectedShapes,
  noteWalkKey,
  selectAdjacent,
  selectionLevel,
  takeWalkKey,
} from '../a11y/ported/traversal.ts'
import { type El, fakeFlowCanvas } from './test-canvas.ts'

const box = (id: string, x: number, y: number, extra: Partial<El> = {}): Partial<El> => ({
  id,
  type: 'rectangle',
  x,
  y,
  width: 100,
  height: 60,
  ...extra,
})
const label = (id: string, of: string, text: string): Partial<El> => ({
  id,
  type: 'text',
  containerId: of,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  text,
  originalText: text,
})
const arrow = (id: string, from: string, to: string): Partial<El> => ({
  id,
  type: 'arrow',
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  points: [
    [0, 0],
    [1, 1],
  ],
  startBinding: { elementId: from, fixedPoint: [1, 0.5], mode: 'orbit' },
  endBinding: { elementId: to, fixedPoint: [0, 0.5], mode: 'orbit' },
})

/** Process in the middle; Review to its right, Decision below, Start above-left; Notes unconnected. */
function board() {
  return fakeFlowCanvas([
    box('process', 300, 300, {
      boundElements: [
        { id: 'l1', type: 'text' },
        { id: 'a1', type: 'arrow' },
        { id: 'a2', type: 'arrow' },
        { id: 'a3', type: 'arrow' },
      ],
    }),
    label('l1', 'process', 'Process'),
    box('review', 600, 300, {
      boundElements: [
        { id: 'l2', type: 'text' },
        { id: 'a1', type: 'arrow' },
      ],
    }),
    label('l2', 'review', 'Review'),
    box('decision', 300, 600, {
      type: 'diamond',
      boundElements: [
        { id: 'l3', type: 'text' },
        { id: 'a2', type: 'arrow' },
      ],
    }),
    label('l3', 'decision', 'Decision'),
    box('start', 0, 0, { type: 'ellipse', boundElements: [{ id: 'a3', type: 'arrow' }] }),
    box('notes', 2000, 2000),
    arrow('a1', 'process', 'review'),
    arrow('a2', 'process', 'decision'),
    arrow('a3', 'start', 'process'),
  ])
}

describe('Alt+Arrow along the connections', () => {
  it('lists the connected shapes at the other ends', () => {
    const f = board()
    expect(connectedShapes('process', (id) => f.canvas.get(id))).toEqual(['review', 'decision', 'start'])
    expect(connectedShapes('notes', (id) => f.canvas.get(id))).toEqual([])
  })

  it('picks the connected shape nearest the pressed direction', () => {
    const f = board()
    f.canvas.select(['process'])
    expect(connectedNeighbour(f.canvas, 'ArrowRight')).toBe('review')
    expect(connectedNeighbour(f.canvas, 'ArrowDown')).toBe('decision')
    // Start is up and to the left, 45 degrees from both
    expect(connectedNeighbour(f.canvas, 'ArrowUp')).toBe('start')
    expect(connectedNeighbour(f.canvas, 'ArrowLeft')).toBe('start')
    // a selected label stands for its container
    f.canvas.select(['l2'])
    expect(connectedNeighbour(f.canvas, 'ArrowLeft')).toBe('process')
    // nothing that way: no connected shape within the angle
    expect(connectedNeighbour(f.canvas, 'ArrowRight')).toBeNull()
  })

  it('selectAdjacent follows the noted arrow once; without one (or with no connection that way) it is the reading order', () => {
    const f = board()
    const canvas = f.canvas as LobbyCanvas
    canvas.select(['process'])
    noteWalkKey(canvas, 'ArrowRight')
    expect(selectAdjacent(canvas, 'next')).toBe(true)
    expect(f.selected).toEqual(['review'])
    // the key was taken: the next walk is the reading order
    expect(takeWalkKey(canvas)).toBeNull()
    const { order } = selectionLevel(canvas)
    const at = order.findIndex((e) => e.ids[0] === 'review')
    selectAdjacent(canvas, 'next')
    expect(f.selected).toEqual(order[(at + 1) % order.length]?.ids)
    // an unconnected shape: the reading order even with a noted arrow
    canvas.select(['notes'])
    noteWalkKey(canvas, 'ArrowRight')
    selectAdjacent(canvas, 'next')
    expect(f.selected).not.toEqual(['notes'])
    const reading = selectionLevel(canvas).order.map((e) => e.ids[0])
    expect(reading).toContain(f.selected[0])
  })

  it('several selected, or a connector selected: no connection walk', () => {
    const f = board()
    f.canvas.select(['process', 'review'])
    expect(connectedNeighbour(f.canvas, 'ArrowRight')).toBeNull()
    f.canvas.select(['a1'])
    expect(connectedNeighbour(f.canvas, 'ArrowRight')).toBeNull()
  })
})

describe('the live region names the connections', () => {
  const ctxOf = (f: ReturnType<typeof board>) => {
    const canvas = f.canvas as LobbyCanvas
    const { order } = selectionLevel(canvas)
    return { get: (id: string) => canvas.get(id) as CanvasElement | undefined, order, frame: null }
  }

  it('"Rectangle: Process, connected to Review, Decision and Ellipse. 2 of 8"', () => {
    const f = board()
    f.canvas.select(['process'])
    const words = describeSelection(['process'], ctxOf(f))
    expect(words).toMatch(/^Rectangle: Process, connected to Review, Decision and Ellipse\. \d of \d+$/)
  })

  it('one connection, or none', () => {
    const f = board()
    const get = (id: string) => f.canvas.get(id)
    expect(connections(get('review') as CanvasElement, get)).toBe(', connected to Process')
    expect(connections(get('notes') as CanvasElement, get)).toBe('')
    expect(connections(get('a1') as CanvasElement, get)).toBe('')
    expect(describeSelection(['notes'], ctxOf(f))).toMatch(/^Rectangle\. \d of \d+$/)
  })

  it('names five, then says how many more', () => {
    const many: Partial<El>[] = [box('hub', 0, 0, { boundElements: [] })]
    const hubBound: { id: string; type: string }[] = []
    for (let i = 0; i < 8; i++) {
      many.push(
        box(`s${i}`, 200 * i, 400, {
          boundElements: [
            { id: `x${i}`, type: 'arrow' },
            { id: `t${i}`, type: 'text' },
          ],
        }),
      )
      many.push(label(`t${i}`, `s${i}`, `Step ${i}`))
      many.push(arrow(`x${i}`, 'hub', `s${i}`))
      hubBound.push({ id: `x${i}`, type: 'arrow' })
    }
    ;(many[0] as El).boundElements = hubBound
    const f = fakeFlowCanvas(many)
    const get = (id: string) => f.canvas.get(id)
    expect(connections(get('hub') as CanvasElement, get)).toBe(
      ', connected to Step 0, Step 1, Step 2, Step 3, Step 4 and 3 more',
    )
  })
})
