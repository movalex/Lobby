// L6-2 (wave L): the presence compass (./compass.ts) on a 1000 x 600 canvas: who gets a chip, on which edge or
// corner, people in view and the zoom, an idle peer by its view centre, chips that would collide merged into
// "+N", and at most MAX_COMPASS_CHIPS chips with everyone in one of them.
import { describe, expect, it } from 'vitest'
import { EDGE_CHIP_RADIUS, EDGE_MARGINS, type EdgeMarkerPeer } from '../board/edge-markers.ts'
import { compass, MAX_COMPASS_CHIPS } from './compass.ts'

const SIZE = { w: 1000, h: 600 }
const VIEW = { x: 0, y: 0, width: 1000, height: 600 }
const at =
  (zoom = 1, ox = 0, oy = 0) =>
  (p: { x: number; y: number }) => ({ x: (p.x - ox) * zoom, y: (p.y - oy) * zoom })
const peer = (sid: string, x: number, y: number): EdgeMarkerPeer => ({
  sid,
  point: { x, y },
  view: { x: x - 400, y: y - 250, width: 800, height: 500 },
})
const R = EDGE_CHIP_RADIUS
const M = EDGE_MARGINS

describe('the compass: who and where', () => {
  it('a peer in view gets no chip', () => {
    expect(compass([peer('a', 500, 300), peer('b', 2, 2)], VIEW, SIZE, at())).toEqual([])
  })

  it('each edge: the chip on the side the peer is on, clamped inside the canvas, pointing at them', () => {
    const chips = compass(
      [peer('l', -3000, 300), peer('r', 4000, 300), peer('t', 500, -3000), peer('b', 500, 4000)],
      VIEW,
      SIZE,
      at(),
    )
    const by = Object.fromEntries(chips.map((c) => [c.sid, c]))
    expect(by.l).toMatchObject({ side: 'left', sids: ['l'] })
    expect(by.l?.x).toBeCloseTo(M.left + R)
    expect(by.r).toMatchObject({ side: 'right' })
    expect(by.r?.x).toBeCloseTo(SIZE.w - M.right - R)
    expect(by.t).toMatchObject({ side: 'top' })
    expect(by.t?.y).toBeCloseTo(M.top + R)
    expect(by.b).toMatchObject({ side: 'bottom' })
    expect(by.b?.y).toBeCloseTo(SIZE.h - M.bottom - R)
    expect(by.r?.target).toEqual({ x: 4000, y: 300 })
    expect(by.b?.angle).toBeCloseTo(Math.PI / 2, 1)
  })

  it('each corner: a diagonal peer sits in that corner, still on the canvas', () => {
    const corners = compass(
      [peer('tl', -5000, -5000), peer('tr', 6000, -5000), peer('bl', -5000, 6000), peer('br', 6000, 6000)],
      VIEW,
      SIZE,
      at(),
    )
    expect(corners).toHaveLength(4)
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(M.left + R - 0.01)
      expect(c.x).toBeLessThanOrEqual(SIZE.w - M.right - R + 0.01)
      expect(c.y).toBeGreaterThanOrEqual(M.top + R - 0.01)
      expect(c.y).toBeLessThanOrEqual(SIZE.h - M.bottom - R + 0.01)
      const left = c.sid.endsWith('l')
      const top = c.sid.startsWith('t')
      expect(c.x < SIZE.w / 2, c.sid).toBe(left)
      expect(c.y < SIZE.h / 2, c.sid).toBe(top)
    }
  })

  it('zoom changes who is off screen and where the chip points', () => {
    const p = [peer('a', 1500, 300)]
    // at zoom 1 the point (1500, 300) is off to the right
    expect(compass(p, VIEW, SIZE, at(1))[0]?.side).toBe('right')
    // zoomed out to 0.5 the same canvas shows (0,0)-(2000,1200): it is in view
    expect(compass(p, { x: 0, y: 0, width: 2000, height: 1200 }, SIZE, at(0.5))).toEqual([])
    // zoomed in at 4 on (0,0)-(250,150): off to the right, and a point below is now off the bottom
    const zoomed = compass(
      [peer('a', 1500, 300), peer('b', 100, 400)],
      { x: 0, y: 0, width: 250, height: 150 },
      SIZE,
      at(4),
    )
    expect(Object.fromEntries(zoomed.map((c) => [c.sid, c.side]))).toEqual({ a: 'right', b: 'bottom' })
  })

  it('an idle peer (no pointer) is placed by its view centre, when that view does not overlap this one', () => {
    const idle = (sid: string, x: number, y: number): EdgeMarkerPeer => ({
      sid,
      point: null,
      view: { x, y, width: 400, height: 200 },
    })
    const [c] = compass([idle('i', 5000, 200)], VIEW, SIZE, at())
    expect(c?.target).toEqual({ x: 5200, y: 300 })
    expect(c?.side).toBe('right')
    // a view that overlaps this one is "here"
    expect(compass([idle('near', 900, 0)], VIEW, SIZE, at())).toEqual([])
    // no pointer and no view: nothing to point at
    expect(compass([{ sid: 'x', point: null, view: null }], VIEW, SIZE, at())).toEqual([])
  })
})

describe('the compass: merging into "+N" and the cap', () => {
  it('peers whose chips would collide are one chip, the nearest person first, with the others in sids', () => {
    const chips = compass(
      [peer('near', 3000, 300), peer('far', 9000, 310), peer('other', -3000, 300)],
      VIEW,
      SIZE,
      at(),
    )
    expect(chips).toHaveLength(2)
    const right = chips.find((c) => c.side === 'right')
    expect(right?.sid).toBe('near')
    expect(right?.sids).toEqual(['near', 'far'])
    expect(right?.target).toEqual({ x: 3000, y: 300 })
    expect(chips.find((c) => c.side === 'left')?.sids).toEqual(['other'])
  })

  it('people in clearly different directions keep their own chips', () => {
    const chips = compass(
      [peer('a', 3000, -2000), peer('b', 3000, 300), peer('c', 3000, 2600)],
      VIEW,
      SIZE,
      at(),
    )
    expect(chips.map((c) => c.sids.length)).toEqual([1, 1, 1])
  })

  it(`at most ${MAX_COMPASS_CHIPS} chips; everyone off screen is in one of them`, () => {
    const crowd: EdgeMarkerPeer[] = []
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * 2 * Math.PI
      crowd.push(peer(`p${i}`, 500 + Math.cos(a) * 5000, 300 + Math.sin(a) * 5000))
    }
    const chips = compass(crowd, VIEW, SIZE, at())
    expect(chips.length).toBe(MAX_COMPASS_CHIPS)
    const all = chips.flatMap((c) => c.sids)
    expect(new Set(all).size).toBe(40)
    for (const c of chips) expect(c.sids[0]).toBe(c.sid)
    // a smaller cap
    expect(compass(crowd, VIEW, SIZE, at(), { max: 3 })).toHaveLength(3)
  })

  it('a canvas with no size has no chips', () => {
    expect(compass([peer('a', 5000, 0)], VIEW, { w: 0, h: 0 }, at())).toEqual([])
  })
})
