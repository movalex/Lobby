import { describe, expect, it } from 'vitest'
import {
  containingFrame,
  FRAME_HEADING,
  findEmptySpot,
  findEmptySpotWithin,
  frameCamera,
  offsetToCenter,
  onScreen,
  type Rect,
  rectsOverlap,
  START_VIEW_PAD,
  startViewCamera,
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

describe('findEmptySpotWithin (pasting into a frame)', () => {
  const within: Rect = { x: 0, y: 0, w: 800, h: 900 }
  const top: Rect = { x: 20, y: 20, w: 760, h: 380 }
  it('keeps the box inside and clear of the obstacles, as close to the target as possible', () => {
    const p = findEmptySpotWithin({ w: 600, h: 400 }, { x: 400, y: 300 }, [top], within, { gap: 40 })
    expect(p).not.toBeNull()
    const box = { x: p?.x ?? 0, y: p?.y ?? 0, w: 600, h: 400 }
    expect(box.x >= 0 && box.y >= 0 && box.x + box.w <= 800 && box.y + box.h <= 900).toBe(true)
    expect(rectsOverlap(box, top, 39)).toBe(false)
    // nearest: just under the obstacle (within one search step, 400 / 8 = 50)
    expect(box.y).toBeGreaterThanOrEqual(top.y + top.h + 40)
    expect(box.y).toBeLessThanOrEqual(top.y + top.h + 40 + 50)
  })
  it('clamps a target near the edge into the area, and says null when nothing fits', () => {
    expect(findEmptySpotWithin({ w: 200, h: 200 }, { x: 790, y: 890 }, [], within)).toEqual({
      x: 600,
      y: 700,
    })
    expect(findEmptySpotWithin({ w: 900, h: 200 }, { x: 0, y: 0 }, [], within)).toBeNull()
    expect(findEmptySpotWithin({ w: 700, h: 600 }, { x: 400, y: 450 }, [top], within, { gap: 40 })).toBeNull()
  })
})

describe('frameCamera (PRI-10: frames panel "go to frame")', () => {
  const vp = { w: 1396, h: 852 }
  const ui = { top: 56, right: 0, bottom: 72, left: 0 }
  const onScreen = (c: { x: number; y: number; z: number }, p: { x: number; y: number }) => ({
    x: (p.x + c.x) * c.z,
    y: (p.y + c.y) * c.z,
  })
  it('shows the whole frame and its heading clear of the page bar and the toolbar, at most 100%', () => {
    const frame = { x: 880, y: 540, w: 800, h: 960 }
    const c = frameCamera(frame, vp, ui, { heading: 32, pad: 24 })
    if (!c) throw new Error('no camera')
    expect(c.z).toBeLessThan(1)
    const tl = onScreen(c, { x: frame.x, y: frame.y })
    const br = onScreen(c, { x: frame.x + frame.w, y: frame.y + frame.h })
    expect(tl.y - 32).toBeGreaterThanOrEqual(ui.top + 24 - 0.01) // heading below the page bar
    expect(br.y).toBeLessThanOrEqual(vp.h - ui.bottom - 24 + 0.01) // bottom above the toolbar
    expect(tl.x).toBeGreaterThanOrEqual(0)
    expect(br.x).toBeLessThanOrEqual(vp.w)
  })
  it('never zooms a small frame in past 100%, and leaves room for an open dock', () => {
    const c = frameCamera({ x: 0, y: 0, w: 200, h: 100 }, vp, ui)
    expect(c?.z).toBe(1)
    const docked = frameCamera({ x: 0, y: 0, w: 1200, h: 400 }, vp, { ...ui, left: 364 })
    if (!docked) throw new Error('no camera')
    expect(onScreen(docked, { x: 0, y: 0 }).x).toBeGreaterThanOrEqual(364 + 24 - 0.01)
  })
  it('gives up (null) on a degenerate frame or a viewport the UI fills', () => {
    expect(frameCamera({ x: 0, y: 0, w: 0, h: 10 }, vp, ui)).toBeNull()
    expect(
      frameCamera(
        { x: 0, y: 0, w: 10, h: 10 },
        { w: 100, h: 100 },
        { top: 50, right: 0, bottom: 50, left: 0 },
      ),
    ).toBeNull()
  })
})

// K2-7 (wave K, UXD-11): the board's first view is framed clear of the chrome, plus 32 px
describe('startViewCamera (K2-7)', () => {
  // a 1440 x 900 window: the canvas is what the top bar (48 px) and the rail (48 px) leave, 1392 x 852; on it the
  // board menu button (12 + 38 px) at the top and the toolbar and zoom chip (48 px, 12 px from the edge) at the
  // bottom
  const screen = { w: 1392, h: 852 }
  const insets = { top: 50, right: 0, bottom: 60, left: 0 }
  const free = {
    left: insets.left + START_VIEW_PAD,
    right: screen.w - insets.right - START_VIEW_PAD,
    top: insets.top + START_VIEW_PAD,
    bottom: screen.h - insets.bottom - START_VIEW_PAD,
  }
  const inside = (r: { x: number; y: number; w: number; h: number }, heading = 0) =>
    r.x >= free.left - 0.5 &&
    r.x + r.w <= free.right + 0.5 &&
    r.y - heading >= free.top - 0.5 &&
    r.y + r.h <= free.bottom + 0.5

  it('a wide frame (the tour) lies inside the canvas minus the chrome plus 32 px, its name included', () => {
    const frame = { x: -200, y: 40, w: 1920, h: 1080 }
    const cam = startViewCamera(frame, screen, insets, { heading: FRAME_HEADING, minZoom: 0.1 })
    expect(cam).not.toBeNull()
    const r = onScreen(frame, cam as { x: number; y: number; z: number })
    expect(inside(r, FRAME_HEADING)).toBe(true)
    // and it is centred in that free area horizontally (it fills its width)
    expect(r.x + r.w / 2).toBeCloseTo((free.left + free.right) / 2, 5)
  })

  it('tall content fits by height, inside the same area', () => {
    const tall = { x: 0, y: 0, w: 600, h: 2400 }
    const cam = startViewCamera(tall, screen, insets, { minZoom: 0.05 })
    const r = onScreen(tall, cam as { x: number; y: number; z: number })
    expect(inside(r)).toBe(true)
    expect(r.y + r.h / 2).toBeCloseTo((free.top + free.bottom) / 2, 5)
  })

  it('small content is not zoomed in past 100 % and is centred in the free area', () => {
    const small = { x: 100, y: 100, w: 200, h: 200 }
    const cam = startViewCamera(small, screen, insets) as { x: number; y: number; z: number }
    expect(cam.z).toBe(1)
    const r = onScreen(small, cam)
    expect(inside(r)).toBe(true)
  })

  it('a free area too small to show anything falls back (null) to a plain fit', () => {
    expect(startViewCamera({ x: 0, y: 0, w: 100, h: 100 }, { w: 120, h: 120 }, insets)).toBeNull()
  })
})
