// Wave 3e: what the ported thumbnail shows (render.ts planThumbnail on a BoardView): the start view, else
// the first frame in presentation order (skipped ones left out, the one with the most imagery first),
// else the content; only what is inside the area is drawn, labels with their containers; and the
// renderer by item count.
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { DETAILED_MAX_SHAPES } from '../plan.ts'
import { planThumbnail, snapshotView } from './render.ts'

const base = { angle: 0, groupIds: [], frameId: null, locked: false, isDeleted: false, version: 1 }
const el = (e: Record<string, unknown>) => ({ ...base, ...e }) as unknown as CanvasElement
const frame = (id: string, x: number, present?: Record<string, unknown>) =>
  el({
    id,
    type: 'frame',
    name: id,
    x,
    y: 0,
    width: 1600,
    height: 1000,
    ...(present ? { customData: { lobby: { present } } } : {}),
  })
const box = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  el({ id, type: 'rectangle', x, y, width: 100, height: 100, ...extra })

describe('planThumbnail (snapshot view)', () => {
  it('an empty board draws nothing', () => {
    expect(planThumbnail(snapshotView([], null, () => false))).toEqual({ kind: 'empty' })
  })

  it('a board with frames shows its first frame in presentation order (skipped ones left out)', () => {
    const items = [
      frame('a', 0, { skip: true }),
      frame('b', 2000),
      frame('c', 4000, { index: 0, skip: true }),
      box('in-b', 2100, 100, { frameId: 'b' }),
      box('in-a', 100, 100, { frameId: 'a' }),
    ]
    const plan = planThumbnail(snapshotView(items, null, () => false))
    expect(plan.kind).toBe('draw')
    if (plan.kind !== 'draw') return
    // frame b plus its margin (4% of 1600 = 64), cropped to the card from its top
    expect(plan.frame.box.x).toBeCloseTo(2000 - 64)
    expect(plan.frame.box.y).toBeCloseTo(-40) // the 16:10 crop, centred (plan.ts fitBox)
    expect(plan.elements.map((e) => e.id).sort()).toEqual(['b', 'in-b'])
    expect(plan.frames).toEqual([{ x: 2000, y: 0, w: 1600, h: 1000 }])
    expect(plan.renderer).toBe('detailed')
  })

  it('the frame with the most imagery wins; a start view wins over frames', () => {
    const items = [
      frame('a', 0),
      frame('b', 2000),
      el({ id: 'img', type: 'image', x: 2100, y: 100, width: 800, height: 600, frameId: 'b' }),
    ]
    const byMedia = planThumbnail(snapshotView(items, null, () => false))
    expect(byMedia.kind === 'draw' && byMedia.frame.box.x).toBeCloseTo(2000 - 64)
    const start = planThumbnail(snapshotView(items, { x: 0, y: 0, w: 1600, h: 1000 }, () => false))
    expect(start.kind === 'draw' && start.frame.box.x).toBe(0)
  })

  it('hidden elements are left out; labels come with their containers; many items use the schematic', () => {
    const items = [
      el({
        id: 'n',
        type: 'stickynote',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        boundElements: [{ id: 'n.t', type: 'text' }],
      }),
      el({
        id: 'n.t',
        type: 'text',
        x: 10,
        y: 10,
        width: 180,
        height: 30,
        containerId: 'n',
        originalText: 'Hi',
      }),
      box('gone', 300, 0),
    ]
    const plan = planThumbnail(snapshotView(items, null, (id) => id === 'gone'))
    expect(plan.kind === 'draw' && plan.elements.map((e) => e.id)).toEqual(['n', 'n.t'])
    const many = Array.from({ length: DETAILED_MAX_SHAPES + 1 }, (_, i) =>
      box(`b${i}`, (i % 6) * 120, Math.floor(i / 6) * 120),
    )
    const big = planThumbnail(snapshotView(many, null, () => false))
    expect(big.kind === 'draw' && big.renderer).toBe('schematic')
  })
})
