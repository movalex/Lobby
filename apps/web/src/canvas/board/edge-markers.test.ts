// W5-32: the edge markers' geometry (canvas/board/edge-markers.ts): who gets one, where it sits on the
// canvas's edge, which way it points, the cap and the spread of chips that would overlap.
import { describe, expect, it } from 'vitest'
import {
  EDGE_CHIP_RADIUS,
  EDGE_MARGINS,
  type EdgeMarkerPeer,
  edgeMarkers,
  MAX_EDGE_MARKERS,
} from './edge-markers.ts'

// A 1000 x 600 canvas showing the scene rectangle (0,0)-(1000,600) at zoom 1.
const SIZE = { w: 1000, h: 600 }
const VIEWPORT = { x: 0, y: 0, width: 1000, height: 600 }
const toOverlay = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })

const peer = (sid: string, x: number, y: number): EdgeMarkerPeer => ({
  sid,
  point: { x, y },
  view: { x: x - 400, y: y - 250, width: 800, height: 500 },
})

const R = EDGE_CHIP_RADIUS
const M = EDGE_MARGINS

describe('who gets a marker', () => {
  it('nobody whose pointer is on screen', () => {
    expect(
      edgeMarkers([peer('a', 500, 300), peer('b', 1, 1), peer('c', 999, 599)], VIEWPORT, SIZE, toOverlay),
    ).toEqual([])
  })

  it('a person whose pointer is off screen, on the side they are on, pointing at them', () => {
    const [m, ...rest] = edgeMarkers([peer('a', 3000, 300)], VIEWPORT, SIZE, toOverlay)
    expect(rest).toEqual([])
    expect(m?.sid).toBe('a')
    expect(m?.side).toBe('right')
    expect(m?.x).toBeCloseTo(SIZE.w - M.right - R)
    expect(Math.abs(m?.angle ?? 1)).toBeLessThan(0.2)
    expect(m?.target).toEqual({ x: 3000, y: 300 })
  })

  it('the four sides', () => {
    const sides = edgeMarkers(
      [peer('l', -2000, 300), peer('r', 4000, 300), peer('t', 500, -2000), peer('b', 500, 3000)],
      VIEWPORT,
      SIZE,
      toOverlay,
    )
    const bySid = Object.fromEntries(sides.map((s) => [s.sid, s]))
    expect(bySid.l?.side).toBe('left')
    expect(bySid.l?.x).toBeCloseTo(M.left + R)
    expect(bySid.r?.side).toBe('right')
    expect(bySid.t?.side).toBe('top')
    expect(bySid.t?.y).toBeCloseTo(M.top + R)
    expect(bySid.b?.side).toBe('bottom')
    // the bottom keeps clear of the toolbar
    expect(bySid.b?.y).toBeCloseTo(SIZE.h - M.bottom - R)
    // an arrow's angle: right 0, down π/2, left π, up -π/2
    expect(bySid.b?.angle).toBeCloseTo(Math.PI / 2, 1)
    expect(bySid.t?.angle).toBeCloseTo(-Math.PI / 2, 1)
    expect(Math.abs(bySid.l?.angle ?? 0)).toBeCloseTo(Math.PI, 1)
  })

  it('a diagonal person sits in the corner region, still inside the canvas', () => {
    const [m] = edgeMarkers([peer('a', 5000, 4000)], VIEWPORT, SIZE, toOverlay)
    expect(m?.x).toBeGreaterThanOrEqual(M.left + R)
    expect(m?.x).toBeLessThanOrEqual(SIZE.w - M.right - R)
    expect(m?.y).toBeGreaterThanOrEqual(M.top + R)
    expect(m?.y).toBeLessThanOrEqual(SIZE.h - M.bottom - R)
    expect(m?.angle).toBeGreaterThan(0)
    expect(m?.angle).toBeLessThan(Math.PI / 2)
  })

  it('no pointer: the middle of their view, but only when that view does not overlap this one', () => {
    const away: EdgeMarkerPeer = { sid: 'a', point: null, view: { x: 2000, y: 0, width: 800, height: 500 } }
    const [m] = edgeMarkers([away], VIEWPORT, SIZE, toOverlay)
    expect(m?.side).toBe('right')
    expect(m?.target).toEqual({ x: 2400, y: 250 })
    // their view overlaps ours: they are here, with no pointer on the board
    const here: EdgeMarkerPeer = { sid: 'b', point: null, view: { x: 800, y: 100, width: 800, height: 500 } }
    expect(edgeMarkers([here], VIEWPORT, SIZE, toOverlay)).toEqual([])
  })

  it('a peer the room does not stream (no pointer, no view) has none', () => {
    expect(edgeMarkers([{ sid: 'a', point: null, view: null }], VIEWPORT, SIZE, toOverlay)).toEqual([])
  })

  it('a pointer off screen counts even when their view overlaps ours (the pointer is where they work)', () => {
    const p: EdgeMarkerPeer = {
      sid: 'a',
      point: { x: 1500, y: 300 },
      view: { x: 800, y: 0, width: 1200, height: 800 },
    }
    expect(edgeMarkers([p], VIEWPORT, SIZE, toOverlay)).toHaveLength(1)
  })

  it('goes through the camera: a zoomed canvas decides by where the point lands on screen', () => {
    // 2x: the canvas shows the scene (0,0)-(500,300); (800, 100) is off screen, (400, 100) is not
    const zoomed = { x: 0, y: 0, width: 500, height: 300 }
    const at2 = (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 })
    const out = edgeMarkers([peer('far', 800, 100), peer('near', 400, 100)], zoomed, SIZE, at2)
    expect(out.map((m) => m.sid)).toEqual(['far'])
  })

  it('a canvas with no size yet has none', () => {
    expect(edgeMarkers([peer('a', 3000, 300)], VIEWPORT, { w: 0, h: 0 }, toOverlay)).toEqual([])
  })

  it('ignores a target that is not a number', () => {
    const bad: EdgeMarkerPeer = { sid: 'a', point: { x: Number.NaN, y: 1 }, view: null }
    expect(edgeMarkers([bad], VIEWPORT, SIZE, toOverlay)).toEqual([])
  })
})

describe('the cap and the spread', () => {
  it('draws at most MAX_EDGE_MARKERS, the nearest people first', () => {
    const peers = Array.from({ length: 25 }, (_, i) =>
      peer(`p${String(i).padStart(2, '0')}`, 2000 + i * 300, 300),
    )
    const out = edgeMarkers(peers, VIEWPORT, SIZE, toOverlay)
    expect(out).toHaveLength(MAX_EDGE_MARKERS)
    expect(new Set(out.map((m) => m.sid))).toEqual(
      new Set(peers.slice(0, MAX_EDGE_MARKERS).map((p) => p.sid)),
    )
  })

  it('a smaller cap', () => {
    const peers = Array.from({ length: 5 }, (_, i) => peer(`p${i}`, 2000 + i * 300, 300))
    expect(edgeMarkers(peers, VIEWPORT, SIZE, toOverlay, { max: 2 })).toHaveLength(2)
  })

  it('chips that would land on one another along a side are spread apart, inside the side', () => {
    const peers = Array.from({ length: 6 }, (_, i) => peer(`p${i}`, 3000 + i, 300 + i))
    const out = edgeMarkers(peers, VIEWPORT, SIZE, toOverlay)
    expect(out.every((m) => m.side === 'right')).toBe(true)
    const ys = out.map((m) => m.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++)
      expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(2 * R)
    expect(ys[0]).toBeGreaterThanOrEqual(M.top + R)
    expect(ys[ys.length - 1]).toBeLessThanOrEqual(SIZE.h - M.bottom - R)
    // the order along the side is kept (the first of them is still the highest)
    expect([...out].sort((a, b) => a.y - b.y).map((m) => m.sid)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])
  })

  it('chips at the end of a side are pulled back inside it, not pushed off the canvas', () => {
    const peers = Array.from({ length: 4 }, (_, i) => peer(`p${i}`, 3000, 5000 + i))
    const out = edgeMarkers(peers, VIEWPORT, SIZE, toOverlay)
    for (const m of out) {
      expect(m.x).toBeLessThanOrEqual(SIZE.w - M.right - R + 1e-9)
      expect(m.y).toBeLessThanOrEqual(SIZE.h - M.bottom - R + 1e-9)
    }
  })

  it('a canvas too small for the margins puts the chip in its middle instead of outside it', () => {
    const tiny = { w: 60, h: 60 }
    const [m] = edgeMarkers([peer('a', 500, 30)], { x: 0, y: 0, width: 60, height: 60 }, tiny, toOverlay)
    expect(m?.x).toBeGreaterThanOrEqual(0)
    expect(m?.x).toBeLessThanOrEqual(60)
    expect(m?.y).toBeGreaterThanOrEqual(0)
    expect(m?.y).toBeLessThanOrEqual(60)
  })

  it('a chip is never placed under a control: it moves on along its side, past it', () => {
    // the board menu in the top left corner covers (0,0)-(56,56)
    const avoid = [{ x: 0, y: 0, w: 56, h: 56 }]
    const [placed] = edgeMarkers([peer('t', -4200, -1990)], VIEWPORT, SIZE, toOverlay, { avoid })
    const [plain] = edgeMarkers([peer('t', -4200, -1990)], VIEWPORT, SIZE, toOverlay)
    // without the control the chip is in the corner; with it, clear of it and still on its edge
    expect(plain && plain.x < 56 && plain.y < 56).toBe(true)
    expect(placed && (placed.x - R >= 56 || placed.y - R >= 56)).toBe(true)
    expect(placed?.side === 'left' || placed?.side === 'top').toBe(true)
    // a chip elsewhere is where it was
    const [far] = edgeMarkers([peer('r', 4000, 300)], VIEWPORT, SIZE, toOverlay, { avoid })
    const [farPlain] = edgeMarkers([peer('r', 4000, 300)], VIEWPORT, SIZE, toOverlay)
    expect(far).toEqual(farPlain)
  })
})
