import { describe, expect, it } from 'vitest'
import { frameInView, openingArea, openingScale } from './export-defaults.ts'

// The Lobby tour's row: six 1600 x 1000 frames, 480 apart (packages/templates lobby-tour).
const TOUR = Array.from({ length: 6 }, (_, i) => ({
  id: `shape:f${i + 1}`,
  bounds: { x: -4000 + i * 2080, y: -74, w: 1600, h: 1000 },
}))
const f2 = TOUR[1]?.bounds ?? { x: 0, y: 0, w: 0, h: 0 }

describe('frameInView', () => {
  it('is the frame the camera was zoomed to (a margin around it)', () => {
    const vp = { x: f2.x - 60, y: f2.y - 100, w: 1720, h: 1200 }
    expect(frameInView(vp, TOUR)).toBe('shape:f2')
  })

  it('is the frame when zoomed into part of it', () => {
    const vp = { x: f2.x + 200, y: f2.y + 300, w: 700, h: 400 }
    expect(frameInView(vp, TOUR)).toBe('shape:f2')
  })

  it('is no frame with the whole tour in view (each frame is a small part of the view)', () => {
    const vp = { x: -4400, y: -2000, w: 11_600, h: 5_000 }
    expect(frameInView(vp, TOUR)).toBeNull()
  })

  it('is no frame halfway between two frames', () => {
    const vp = { x: f2.x + 1000, y: f2.y - 100, w: 1700, h: 1200 }
    expect(frameInView(vp, TOUR)).toBeNull()
  })

  it('prefers a nested frame that fills the view over its parent', () => {
    const parent = { id: 'shape:parent', bounds: { x: 0, y: 0, w: 4000, h: 3000 } }
    const child = { id: 'shape:child', bounds: { x: 1000, y: 1000, w: 800, h: 500 } }
    expect(frameInView({ x: 950, y: 950, w: 900, h: 600 }, [parent, child])).toBe('shape:child')
  })

  it('ignores empty or broken input', () => {
    expect(frameInView({ x: 0, y: 0, w: 0, h: 0 }, TOUR)).toBeNull()
    expect(
      frameInView({ x: 0, y: 0, w: 100, h: 100 }, [{ id: 'shape:z', bounds: { x: 0, y: 0, w: 0, h: 0 } }]),
    ).toBeNull()
  })
})

describe('openingScale', () => {
  const SCALES = [1, 2, 4] as const
  type S = (typeof SCALES)[number]
  const tourBoard = { w: 10_400, h: 1_268 }

  it('keeps the remembered size when the image fits', () => {
    expect(openingScale<S>(2, SCALES, { w: 1600, h: 1000 })).toBe(2)
    expect(openingScale<S>(4, SCALES, { w: 1600, h: 1000 })).toBe(4)
  })

  it('steps down until it fits: the whole tour at 2x or 4x opens at 1x (20,800 px would warn)', () => {
    expect(openingScale<S>(2, SCALES, tourBoard)).toBe(1)
    expect(openingScale<S>(4, SCALES, tourBoard)).toBe(1)
    expect(openingScale<S>(4, SCALES, { w: 5000, h: 3000 })).toBe(2)
  })

  it('stays at the smallest when nothing fits, and keeps the remembered size with no area', () => {
    expect(openingScale<S>(4, SCALES, { w: 40_000, h: 2_000 })).toBe(1)
    expect(openingScale<S>(2, SCALES, null)).toBe(2)
  })
})

// P-026 (wave P): the image export opens on the whole board, or on the selection when there is one. It used to open on
// the frame in view ("Frame: 1 · Welcome" on the tour, a file named after one frame when the person wanted the board).
describe('openingArea', () => {
  it('is the whole board with nothing selected, whatever frame the camera shows', () => {
    expect(openingArea({ selected: 0, selectedFrame: false })).toBe('board')
    // the frame that fills the view is no longer a reason
    expect(frameInView({ x: f2.x - 40, y: f2.y - 40, w: f2.w + 80, h: f2.h + 80 }, TOUR)).toBe('shape:f2')
  })

  it('is the selection when something is selected', () => {
    expect(openingArea({ selected: 3, selectedFrame: false })).toBe('selection')
    expect(openingArea({ selected: 1, selectedFrame: false })).toBe('selection')
  })

  it('is that frame when the selection is exactly one frame (it is the selection)', () => {
    expect(openingArea({ selected: 1, selectedFrame: true })).toBe('frame')
    // a frame among other things is a selection
    expect(openingArea({ selected: 2, selectedFrame: true })).toBe('selection')
  })
})
