// Wave K.1 (follow-up 8): the AI popover never sits under the selection bar it opened from, never runs off a
// short viewport, and scrolls inside a max-height when its content is taller than the room (./placement.ts).
import { describe, expect, it } from 'vitest'
import { POP_EDGE, POP_GAP, POP_TOP_MIN, placeAiPopover } from './placement.ts'

const W = 312

/** The popover's box as drawn: its top, and its height capped by the max-height. */
function drawn(p: ReturnType<typeof placeAiPopover>, h: number) {
  const height = Math.min(h, p.maxHeight)
  return { left: p.left, top: p.top, bottom: p.top + height, height }
}

const overlapsAnchor = (d: { top: number; bottom: number }, at: { top: number; bottom: number }) =>
  d.top < at.bottom && at.top < d.bottom

describe('placeAiPopover (K.1)', () => {
  it('below the anchor when it fits there, at its full height', () => {
    const at = { x: 400, top: 200, bottom: 240 }
    const p = placeAiPopover({ box: { width: 1200, height: 800 }, at, w: W, h: 300 })
    expect(p.top).toBe(240 + POP_GAP)
    expect(p.maxHeight).toBeGreaterThanOrEqual(300)
    expect(p.left).toBe(400 - W / 2)
  })

  it('above it when only above has room, its bottom clear of the anchor', () => {
    const at = { x: 400, top: 700, bottom: 740 }
    const p = placeAiPopover({ box: { width: 1200, height: 800 }, at, w: W, h: 400 })
    const d = drawn(p, 400)
    expect(d.height).toBe(400)
    expect(d.bottom).toBeLessThanOrEqual(at.top - POP_GAP)
    expect(d.top).toBeGreaterThanOrEqual(POP_TOP_MIN)
  })

  it('neither side holds it: the roomier side, scrolling inside, never over the selection bar (the old clamp put it there)', () => {
    // a 600 px canvas, the bar in the middle, a popover 420 px tall: the old placement clamped it to top 168,
    // over the bar at 250-290
    const at = { x: 500, top: 250, bottom: 290 }
    const box = { width: 1000, height: 600 }
    const p = placeAiPopover({ box, at, w: W, h: 420 })
    const d = drawn(p, 420)
    expect(overlapsAnchor(d, at)).toBe(false)
    expect(d.bottom).toBeLessThanOrEqual(box.height - POP_EDGE)
    expect(d.top).toBeGreaterThanOrEqual(POP_TOP_MIN)
    expect(p.maxHeight).toBeLessThan(420) // it scrolls
  })

  it('a short viewport (a phone held sideways, a small laptop window): always inside the canvas', () => {
    for (const height of [300, 360, 420, 520])
      for (const anchorTop of [70, height / 2, height - 80]) {
        const at = { x: 300, top: anchorTop, bottom: anchorTop + 40 }
        const box = { width: 700, height }
        const p = placeAiPopover({ box, at, w: W, h: 520 })
        const d = drawn(p, 520)
        expect(d.top, `${height} ${anchorTop}`).toBeGreaterThanOrEqual(POP_TOP_MIN)
        expect(d.bottom, `${height} ${anchorTop}`).toBeLessThanOrEqual(height - POP_EDGE)
      }
  })

  it('every anchor on a desktop canvas: inside it, and off the anchor whenever there is room for 160 px', () => {
    const box = { width: 1440, height: 760 }
    for (let top = 60; top < 700; top += 20) {
      const at = { x: 720, top, bottom: top + 40 }
      for (const h of [180, 320, 460, 640]) {
        const p = placeAiPopover({ box, at, w: W, h })
        const d = drawn(p, h)
        expect(d.top).toBeGreaterThanOrEqual(POP_TOP_MIN)
        expect(d.bottom).toBeLessThanOrEqual(box.height - POP_EDGE)
        const room = Math.max(box.height - POP_EDGE - (at.bottom + POP_GAP), at.top - POP_GAP - POP_TOP_MIN)
        if (room >= 160) expect(overlapsAnchor(d, at), `top ${top} h ${h}`).toBe(false)
      }
    }
  })

  it('stays inside the canvas sideways', () => {
    expect(
      placeAiPopover({ box: { width: 800, height: 800 }, at: { x: 5, top: 100, bottom: 140 }, w: W, h: 200 })
        .left,
    ).toBe(POP_EDGE)
    expect(
      placeAiPopover({
        box: { width: 800, height: 800 },
        at: { x: 795, top: 100, bottom: 140 },
        w: W,
        h: 200,
      }).left,
    ).toBe(800 - W - POP_EDGE)
  })
})
