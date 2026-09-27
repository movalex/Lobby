import { describe, expect, it } from 'vitest'
import {
  containingFrame,
  findEmptySpot,
  offsetToCenter,
  type Rect,
  rectsOverlap,
  unionRects,
} from './placement.ts'

const size = { w: 1000, h: 600 }
const center = { x: 0, y: 0 }
const boxAt = (p: { x: number; y: number }): Rect => ({ ...p, ...size })

describe('findEmptySpot', () => {
  it('centres on the target when the board is empty', () => {
    expect(findEmptySpot(size, center, [])).toEqual({ x: -500, y: -300 })
  })

  it('centres on the target when nothing is in the way', () => {
    const far = [{ x: 5000, y: 5000, w: 200, h: 200 }]
    expect(findEmptySpot(size, center, far)).toEqual({ x: -500, y: -300 })
  })

  it('moves the nearest free distance away from content under the viewport centre', () => {
    const obstacles = [{ x: -100, y: -100, w: 200, h: 200 }]
    const p = findEmptySpot(size, center, obstacles, { gap: 80 })
    expect(obstacles.some((o) => rectsOverlap(boxAt(p), o, 80))).toBe(false)
    // Close by: within a few steps of the requested position.
    expect(Math.hypot(p.x + 500, p.y + 300)).toBeLessThan(1500)
  })

  it('keeps the requested clearance', () => {
    const obstacles = [{ x: -600, y: -400, w: 1200, h: 800 }]
    for (const gap of [0, 40, 200]) {
      const p = findEmptySpot(size, center, obstacles, { gap })
      expect(rectsOverlap(boxAt(p), obstacles[0] as Rect, gap)).toBe(false)
    }
  })

  it('never overlaps on a dense board and falls back to the right of all content', () => {
    // A 40 x 40 grid of 200 px notes with 20 px gaps covers ~8800 px square around the centre.
    const obstacles: Rect[] = []
    for (let i = 0; i < 40; i++)
      for (let j = 0; j < 40; j++) obstacles.push({ x: -4400 + i * 220, y: -4400 + j * 220, w: 200, h: 200 })
    const p = findEmptySpot(size, center, obstacles, { gap: 80, maxRings: 3 })
    expect(obstacles.some((o) => rectsOverlap(boxAt(p), o, 80))).toBe(false)
    const all = unionRects(obstacles) as Rect
    expect(p.x).toBeGreaterThanOrEqual(all.x + all.w + 80)
  })

  it('ignores malformed obstacles', () => {
    const p = findEmptySpot(size, center, [{ x: Number.NaN, y: 0, w: 10, h: 10 }])
    expect(p).toEqual({ x: -500, y: -300 })
  })
})

describe('helpers', () => {
  it('unionRects', () => {
    expect(
      unionRects([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: -5, w: 5, h: 5 },
      ]),
    ).toEqual({ x: 0, y: -5, w: 25, h: 15 })
    expect(unionRects([])).toBeNull()
  })

  it('offsetToCenter', () => {
    expect(offsetToCenter({ x: 0, y: 0, w: 100, h: 50 }, { x: 500, y: 500 })).toEqual({ x: 450, y: 475 })
  })

  it('containingFrame picks the smallest frame that fully contains the rect', () => {
    const frames = [
      { id: 'big', bounds: { x: 0, y: 0, w: 2000, h: 2000 } },
      { id: 'small', bounds: { x: 100, y: 100, w: 800, h: 800 } },
      { id: 'partial', bounds: { x: 300, y: 300, w: 100, h: 100 } },
    ]
    expect(containingFrame({ x: 200, y: 200, w: 300, h: 300 }, frames)?.id).toBe('small')
    expect(containingFrame({ x: 50, y: 50, w: 1000, h: 300 }, frames)?.id).toBe('big')
    expect(containingFrame({ x: -10, y: 0, w: 10, h: 10 }, frames)).toBeNull()
  })
})
