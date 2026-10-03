// Wave B follow-up 4 (wave D6): edge chips stay clear of the phone sheet and the floating selection bar.
// The chips' geometry already keeps clear of whatever `avoid` lists (edge-markers.test.ts); what these two
// were missing was a way to say where they are: they live in layer slots (a full-size or zero-height strip
// with a box floating inside), so chrome.tsx now measures what floats in them (`floatingCovers`).
import { describe, expect, it } from 'vitest'
import {
  type AvoidRect,
  type CoverNode,
  EDGE_MARGINS,
  type EdgeMarkerPeer,
  edgeMarkers,
  floatingCovers,
  MIN_COVER_PX,
} from './edge-markers.ts'

const node = (over: Partial<CoverNode> & Pick<CoverNode, 'x' | 'y' | 'w' | 'h'>): CoverNode => ({
  hidden: false,
  floating: true,
  children: [],
  ...over,
})

describe('floatingCovers: what floats inside a layer slot', () => {
  const origin = { x: 100, y: 50 }

  it('is every visible floating box, relative to the overlay', () => {
    const bar = node({ x: 400, y: 300, w: 240, h: 38 })
    expect(floatingCovers([bar], origin)).toEqual([{ x: 300, y: 250, w: 240, h: 38 }])
    expect(floatingCovers([], origin)).toEqual([])
  })

  it('looks through a container that is not itself a box on the canvas (the phone sheet’s zero-height root)', () => {
    const toggle = node({ x: 430, y: 770, w: 48, h: 48 })
    const sheet = node({ x: 100, y: 400, w: 390, h: 440 })
    // `position: relative`, full width, no height: not a box to avoid, its children are
    const root = node({ x: 100, y: 844, w: 390, h: 0, floating: false, children: [toggle, sheet] })
    expect(floatingCovers([root], origin)).toEqual([
      { x: 330, y: 720, w: 48, h: 48 },
      { x: 0, y: 350, w: 390, h: 440 },
    ])
  })

  it('counts a floating box inside another (a popover in the bar), and skips what is not floating', () => {
    const popover = node({ x: 420, y: 340, w: 200, h: 90 })
    const button = node({ x: 410, y: 303, w: 36, h: 32, floating: false })
    const bar = node({ x: 400, y: 300, w: 240, h: 38, children: [button, popover] })
    expect(floatingCovers([bar], origin)).toEqual([
      { x: 300, y: 250, w: 240, h: 38 },
      { x: 320, y: 290, w: 200, h: 90 },
    ])
  })

  it('skips what is hidden, and everything inside it', () => {
    const inner = node({ x: 400, y: 300, w: 100, h: 40 })
    expect(
      floatingCovers([node({ x: 400, y: 300, w: 240, h: 38, hidden: true, children: [inner] })], origin),
    ).toEqual([])
    // a visible box with a hidden child: the box only
    const out = floatingCovers(
      [node({ x: 400, y: 300, w: 240, h: 38, children: [{ ...inner, hidden: true }] })],
      origin,
    )
    expect(out).toHaveLength(1)
  })

  it('skips a box too small to cover a chip (the visually hidden live region) and one that is not a number', () => {
    expect(floatingCovers([node({ x: 10, y: 10, w: 1, h: 1 })], origin)).toEqual([])
    expect(floatingCovers([node({ x: 10, y: 10, w: MIN_COVER_PX - 1, h: 40 })], origin)).toEqual([])
    expect(floatingCovers([node({ x: 10, y: 10, w: MIN_COVER_PX, h: MIN_COVER_PX })], origin)).toHaveLength(1)
    expect(floatingCovers([node({ x: Number.NaN, y: 10, w: 40, h: 40 })], origin)).toEqual([])
  })
})

// ---- a phone: 390 x 844, a finger-sized chip (radius 31), the board's controls as the page lays them out -------

const PHONE = { w: 390, h: 844 }
const VIEW = { x: 0, y: 0, width: PHONE.w, height: PHONE.h }
const toOverlay = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })
const R = 31
/** the board menu beside the dock's fold button (chrome.tsx cornerControls, 600 px and less) */
const MENU: AvoidRect = { x: 0, y: 0, w: 100, h: 56 }
/** the "Board actions" button: 48 px, 12 px from the right, 76 px from the bottom (a11y.css .dr-a11y-sheet__toggle) */
const TOGGLE: AvoidRect = { x: PHONE.w - 12 - 48, y: PHONE.h - 76 - 48, w: 48, h: 48 }
/** the open sheet: the full width, here 506 px (60% of the screen) high, from the bottom */
const SHEET: AvoidRect = { x: 0, y: PHONE.h - 506, w: PHONE.w, h: 506 }

const peer = (sid: string, x: number, y: number): EdgeMarkerPeer => ({
  sid,
  point: { x, y },
  view: { x: x - 200, y: y - 400, width: 400, height: 800 },
})
const clearance = (m: { x: number; y: number }, a: AvoidRect) =>
  Math.hypot(Math.max(a.x - m.x, 0, m.x - (a.x + a.w)), Math.max(a.y - m.y, 0, m.y - (a.y + a.h)))
const apart = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
  Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))
const place = (peers: EdgeMarkerPeer[], avoid: AvoidRect[]) =>
  edgeMarkers(peers, VIEW, PHONE, toOverlay, { avoid, chipRadius: R })

describe('the phone sheet’s button', () => {
  // a person to the lower right on the diagonal of the chips' box: their chip's place is its bottom right corner, where the button is
  const corner = peer('br', 1195, 2664)

  it('is where a chip for a person in the lower right would sit: without it, the chip is under the button', () => {
    const [plain] = place([corner], [MENU])
    expect(plain && clearance(plain, TOGGLE)).toBeLessThan(R)
  })

  it('a chip for them sits clear of it, on the canvas edge, with the same side word', () => {
    const [m] = place([corner], [MENU, TOGGLE])
    expect(m && clearance(m, TOGGLE)).toBeGreaterThanOrEqual(R - 1e-6)
    expect(m?.x).toBeGreaterThanOrEqual(EDGE_MARGINS.left + R - 1e-6)
    expect(m?.x).toBeLessThanOrEqual(PHONE.w - EDGE_MARGINS.right - R + 1e-6)
    expect(m?.y).toBeLessThanOrEqual(PHONE.h - EDGE_MARGINS.bottom - R + 1e-6)
    expect(m?.side === 'bottom' || m?.side === 'right').toBe(true)
  })

  it('chips elsewhere are where they were', () => {
    const peers = [peer('l', -5000, 400), peer('t', 200, -5000)]
    expect(place(peers, [MENU, TOGGLE])).toEqual(place(peers, [MENU]))
  })
})

describe('the open phone sheet', () => {
  it('no chip is under it, whichever way the person is', () => {
    const peers = [
      peer('l', -5000, 700),
      peer('r', 5000, 700),
      peer('b', 200, 6000),
      peer('bl', -4000, 4000),
      peer('br', 6000, 5000),
      peer('t', 200, -5000),
    ]
    const out = place(peers, [MENU, TOGGLE, SHEET])
    expect(out).toHaveLength(peers.length)
    for (const m of out) {
      expect(clearance(m, SHEET), `${m.sid} under the sheet`).toBeGreaterThanOrEqual(R - 1e-6)
      expect(clearance(m, TOGGLE), `${m.sid} under the button`).toBeGreaterThanOrEqual(R - 1e-6)
      expect(m.x).toBeGreaterThanOrEqual(EDGE_MARGINS.left + R - 1e-6)
      expect(m.x).toBeLessThanOrEqual(PHONE.w - EDGE_MARGINS.right - R + 1e-6)
      expect(m.y).toBeGreaterThanOrEqual(EDGE_MARGINS.top + R - 1e-6)
    }
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(apart(out[i], out[j]), `${out[i]?.sid} and ${out[j]?.sid}`).toBeGreaterThanOrEqual(2 * R)
  })

  it('a chip for someone below stays above the sheet rather than under it', () => {
    const [plain] = place([peer('b', 200, 6000)], [MENU])
    const [m] = place([peer('b', 200, 6000)], [MENU, TOGGLE, SHEET])
    expect(plain && clearance(plain, SHEET)).toBeLessThan(R)
    expect(m && clearance(m, SHEET)).toBeGreaterThanOrEqual(R - 1e-6)
    expect(m?.y).toBeLessThanOrEqual(SHEET.y - R + 1e-6)
  })
})

describe('the floating selection bar', () => {
  // under a selection near the right edge: a bar 240 x 38 whose right end is at the canvas edge
  const BAR: AvoidRect = { x: PHONE.w - 240 - 4, y: 420, w: 240, h: 38 }

  it('a chip for a person to the right, level with it, moves clear of it along the edge', () => {
    const right = peer('r', 6000, 436)
    const [plain] = place([right], [MENU])
    expect(plain && clearance(plain, BAR)).toBeLessThan(R)
    const [m] = place([right], [MENU, BAR])
    expect(m && clearance(m, BAR)).toBeGreaterThanOrEqual(R - 1e-6)
    expect(m?.side).toBe('right')
    expect(m?.x).toBeCloseTo(PHONE.w - EDGE_MARGINS.right - R)
  })

  it('a bar in the middle of the canvas, touching no edge a chip could be on, moves nothing', () => {
    const middle: AvoidRect = { x: 60, y: 300, w: 200, h: 38 }
    const peers = [peer('r', 6000, 436), peer('l', -5000, 300), peer('t', 200, -5000), peer('b', 200, 6000)]
    expect(place(peers, [MENU, middle])).toEqual(place(peers, [MENU]))
  })

  it('a bar and the phone sheet’s button together: nobody under either', () => {
    const peers = Array.from({ length: 5 }, (_, i) => peer(`p${i}`, 6000, 300 + i * 120))
    const out = place(peers, [MENU, TOGGLE, BAR])
    for (const m of out) {
      expect(clearance(m, BAR)).toBeGreaterThanOrEqual(R - 1e-6)
      expect(clearance(m, TOGGLE)).toBeGreaterThanOrEqual(R - 1e-6)
    }
  })
})
