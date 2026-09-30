// Wave 3e: what an export draws (plan.ts): the board or a selection with its labels and frame children,
// one frame with only its own content, an exact rectangle through the synthetic frame, and the size caps.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT_PADDING,
  EXPORT_BOUNDS_FRAME_ID,
  EXPORT_CANVAS_LIMITS,
  exportScale,
  type PlanElement,
  type PlanRect,
  planExport,
  reparentToBounds,
} from './plan.ts'

type El = PlanElement & PlanRect

const el = (id: string, type: string, x: number, y: number, more: Partial<El> = {}): El => ({
  id,
  type,
  x,
  y,
  width: 100,
  height: 100,
  ...more,
})

const scene: El[] = [
  el('F', 'frame', 0, 0, { width: 800, height: 600 }),
  el('n', 'stickynote', 20, 20, { frameId: 'F' }),
  el('n.t', 'text', 30, 30, { containerId: 'n', frameId: 'F' }),
  el('loose', 'rectangle', 700, 500),
  el('far', 'rectangle', 5000, 5000),
  el('gone', 'rectangle', 10, 10, { isDeleted: true }),
  el('h', 'stickynote', 300, 300),
  el('h.t', 'text', 310, 310, { containerId: 'h' }),
]
const boundsOf = (e: El): PlanRect => ({ x: e.x, y: e.y, width: e.width, height: e.height })
const hidden = new Set(['h', 'h.t'])
const deps = { boundsOf, isHidden: (id: string) => hidden.has(id) }
const ids = (list: readonly El[]) => list.map((e) => e.id)

describe('planExport', () => {
  it('the board: every live, visible element, with the default margin', () => {
    const p = planExport(scene, {}, deps)
    expect(p.kind).toBe('elements')
    expect(ids(p.elements)).toEqual(['F', 'n', 'n.t', 'loose', 'far'])
    expect(p.kind === 'elements' && p.padding).toBe(DEFAULT_EXPORT_PADDING)
    expect(planExport(scene, { padding: 32 }, deps)).toMatchObject({ padding: 32 })
  })

  it('a selection brings its labels and a selected frame its children; hidden ones stay out', () => {
    expect(ids(planExport(scene, { ids: ['n'] }, deps).elements)).toEqual(['n', 'n.t'])
    expect(ids(planExport(scene, { ids: ['F'] }, deps).elements)).toEqual(['F', 'n', 'n.t'])
    expect(ids(planExport(scene, { ids: ['h'] }, deps).elements)).toEqual([])
  })

  it('one frame: the frame and its own content, not a loose element overlapping it', () => {
    const p = planExport(scene, { frameId: 'F' }, deps)
    expect(p.kind).toBe('frame')
    expect(ids(p.elements)).toEqual(['F', 'n', 'n.t'])
    expect(() => planExport(scene, { frameId: 'n' }, deps)).toThrow(/no frame/)
  })

  it('an exact rectangle keeps what intersects it and re-parents copies to the synthetic frame', () => {
    const p = planExport(scene, { bounds: { x: 650, y: 450, width: 400, height: 400 } }, deps)
    expect(p.kind).toBe('bounds')
    expect(ids(p.elements)).toEqual(['F', 'loose'])
    const frame = el(EXPORT_BOUNDS_FRAME_ID, 'frame', 650, 450, { width: 400, height: 400 })
    const out = reparentToBounds(p.elements, frame)
    expect(out.map((e) => [e.id, e.frameId ?? null])).toEqual([
      [EXPORT_BOUNDS_FRAME_ID, null],
      ['F', EXPORT_BOUNDS_FRAME_ID],
      ['loose', EXPORT_BOUNDS_FRAME_ID],
    ])
    // copies: the scene's elements keep their own frame
    expect(scene.find((e) => e.id === 'loose')?.frameId).toBeUndefined()
  })
})

describe('exportScale', () => {
  it('the asked scale, capped by maxSide and by what browsers draw', () => {
    expect(exportScale(800, 600, { scale: 2 })).toBe(2)
    expect(exportScale(800, 600, {})).toBe(1)
    expect(exportScale(4000, 1000, { scale: 1, maxSide: 800 })).toBe(0.2)
    expect(exportScale(10_000, 100, { scale: 4 })).toBeCloseTo(EXPORT_CANVAS_LIMITS.maxSide / 10_000)
    const s = exportScale(10_000, 10_000, { scale: 4 })
    expect(10_000 * s * 10_000 * s).toBeLessThanOrEqual(EXPORT_CANVAS_LIMITS.maxArea + 1)
  })
})
