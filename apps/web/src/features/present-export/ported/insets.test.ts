// K3-4: present mode fits each slide below the floating timer (and hands, and the live banner) and above the
// control bar, so nothing covers slide content. The camera (presenter.ts viewportFor) and the surround's
// window (slides.ts fittedSlideRect) use the same numbers; the insets come from ./insets.ts.
import { describe, expect, it } from 'vitest'
import { fittedSlideRect } from '../slides.ts'
import {
  intersects,
  NO_TOP_CHROME,
  PRESENT_BAR_INSET,
  PRESENT_TOP_AGENDA_INSET,
  PRESENT_TOP_INSET,
  PRESENT_TOP_STACKED_INSET,
  presentInsets,
} from './insets.ts'
import { PRESENT_ZOOM_RANGE, viewportFor } from './presenter.ts'

const VIEWS = [
  { w: 1440, h: 900 },
  { w: 1280, h: 760 },
]
/** Frames of every shape a deck has: 16:9, 4:3, a tall one, a very wide one, a tiny one (max zoom). */
const FRAMES = [
  { x: 0, y: 0, w: 1600, h: 900 },
  { x: -400, y: 300, w: 800, h: 600 },
  { x: 1200, y: -50, w: 600, h: 1200 },
  { x: 0, y: 2000, w: 2400, h: 600 },
  { x: 7, y: 9, w: 10, h: 10 },
]

/** Where the frame lands on screen under camera `v` (scene → screen: (p - v) × zoom). */
const onScreen = (f: (typeof FRAMES)[number], v: { x: number; y: number; zoom: number }) => ({
  x: (f.x - v.x) * v.zoom,
  y: (f.y - v.y) * v.zoom,
  w: f.w * v.zoom,
  h: f.h * v.zoom,
})

/** The chrome as workshops.css and present-export.css draw it (a generous width for each). */
const timerRect = { x: 16, y: 16, w: 140, h: 40 }
const handsUnderTimer = { x: 16, y: 68, w: 360, h: 40 }
const barRect = (view: { w: number; h: number }) => ({
  x: view.w / 2 - 300,
  y: view.h - 20 - 46,
  w: 600,
  h: 46,
})

describe('present mode keeps the chrome off the slide (K3-4)', () => {
  it('insets: about 64 px on top while a timer is live, about 80 px at the bottom for the bar', () => {
    const view = { w: 1440, h: 900 }
    expect(presentInsets(view, { ...NO_TOP_CHROME, timer: true }, true)).toEqual({
      top: PRESENT_TOP_INSET,
      right: 0,
      bottom: PRESENT_BAR_INSET,
      left: 0,
    })
    expect(PRESENT_TOP_INSET).toBe(64)
    expect(PRESENT_BAR_INSET).toBe(80)
    // nothing at the top: the slide may use the full height above the bar
    expect(presentInsets(view, NO_TOP_CHROME, true)).toEqual({ top: 0, right: 0, bottom: 80, left: 0 })
    // raised hands alone, or the live banner, take one row; the timer with hands under it, two
    expect(presentInsets(view, { ...NO_TOP_CHROME, hands: true }, true).top).toBe(64)
    expect(presentInsets(view, { ...NO_TOP_CHROME, banner: true }, true).top).toBe(64)
    expect(presentInsets(view, { timer: true, hands: true, banner: false }, true).top).toBe(
      PRESENT_TOP_STACKED_INSET,
    )
    // no slides, no bar
    expect(presentInsets(view, NO_TOP_CHROME, false)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })

  it('a short view (a phone held sideways) never gives more than 40 % of its height to insets', () => {
    const i = presentInsets({ w: 844, h: 300 }, { timer: true, hands: true, banner: true }, true)
    expect(i.top + i.bottom).toBeLessThanOrEqual(120)
    expect(i.top).toBeGreaterThan(i.bottom) // the stacked top keeps the larger share
  })

  for (const view of VIEWS)
    it(`at ${view.w}×${view.h}: every frame fits between the insets, clear of the timer and the bar`, () => {
      for (const top of [
        { ...NO_TOP_CHROME, timer: true },
        { timer: true, hands: true, banner: false },
        NO_TOP_CHROME,
      ]) {
        const insets = presentInsets(view, top, true)
        for (const f of FRAMES) {
          const v = viewportFor(f, view, insets, PRESENT_ZOOM_RANGE)
          const r = onScreen(f, v)
          const eps = 1e-6
          expect(r.x, `${f.w}×${f.h} left`).toBeGreaterThanOrEqual(-eps)
          expect(r.x + r.w, `${f.w}×${f.h} right`).toBeLessThanOrEqual(view.w + eps)
          expect(r.y, `${f.w}×${f.h} top`).toBeGreaterThanOrEqual(insets.top - eps)
          expect(r.y + r.h, `${f.w}×${f.h} bottom`).toBeLessThanOrEqual(view.h - insets.bottom + eps)
          if (top.timer) expect(intersects(r, timerRect), `${f.w}×${f.h} under the timer`).toBe(false)
          if (top.timer && top.hands)
            expect(intersects(r, handsUnderTimer), `${f.w}×${f.h} under the hands`).toBe(false)
          expect(intersects(r, barRect(view)), `${f.w}×${f.h} under the bar`).toBe(false)
          // the surround's window is the same rectangle
          const hole = fittedSlideRect(f, view, PRESENT_ZOOM_RANGE, insets)
          expect(hole.x).toBeCloseTo(r.x, 6)
          expect(hole.y).toBeCloseTo(r.y, 6)
          expect(hole.w).toBeCloseTo(r.w, 6)
          expect(hole.h).toBeCloseTo(r.h, 6)
        }
      }
    })

  it('the slide is centred in what the insets leave, and as large as fits there', () => {
    const view = { w: 1280, h: 760 }
    const insets = presentInsets(view, { ...NO_TOP_CHROME, timer: true }, true)
    const f = { x: 0, y: 0, w: 1600, h: 900 }
    const r = onScreen(f, viewportFor(f, view, insets, PRESENT_ZOOM_RANGE))
    const room = { w: view.w, h: view.h - insets.top - insets.bottom }
    // fills the room on one side
    expect(Math.max(r.w / room.w, r.h / room.h)).toBeCloseTo(1, 6)
    // centred in it on both
    expect(r.x + r.w / 2).toBeCloseTo(view.w / 2, 6)
    expect(r.y + r.h / 2).toBeCloseTo(insets.top + room.h / 2, 6)
  })

  it('a single number is still an even inset (stepping out of a live presentation)', () => {
    const view = { w: 1000, h: 800 }
    const f = { x: 0, y: 0, w: 500, h: 500 }
    const r = onScreen(f, viewportFor(f, view, 32, PRESENT_ZOOM_RANGE))
    expect(r.h).toBeCloseTo(800 - 64, 6)
    expect(r.y).toBeCloseTo(32, 6)
    expect(r.x + r.w / 2).toBeCloseTo(500, 6)
  })
})

describe('the run of show’s strip under the live banner (L5-1)', () => {
  const view = { w: 1440, h: 900 }
  it('takes one more row at the top, only under a banner; everything else is as it was', () => {
    expect(presentInsets(view, { ...NO_TOP_CHROME, banner: true }, true).top).toBe(PRESENT_TOP_INSET)
    expect(presentInsets(view, { ...NO_TOP_CHROME, banner: true, agenda: true }, true)).toEqual({
      top: PRESENT_TOP_AGENDA_INSET,
      right: 0,
      bottom: PRESENT_BAR_INSET,
      left: 0,
    })
    // no banner, no strip; and `agenda: false` is the same as leaving it out
    expect(presentInsets(view, { ...NO_TOP_CHROME, agenda: true }, true).top).toBe(0)
    expect(presentInsets(view, { ...NO_TOP_CHROME, banner: true, agenda: false }, true)).toEqual(
      presentInsets(view, { ...NO_TOP_CHROME, banner: true }, true),
    )
    // the timer with the hands under it is the taller stack at the left: the larger of the two wins
    expect(presentInsets(view, { timer: true, hands: true, banner: true, agenda: true }, true).top).toBe(
      Math.max(PRESENT_TOP_STACKED_INSET, PRESENT_TOP_AGENDA_INSET),
    )
  })

  it('keeps the slide a usable size on a short view (the shared limit still applies)', () => {
    const phone = { w: 800, h: 360 }
    const i = presentInsets(phone, { ...NO_TOP_CHROME, banner: true, agenda: true }, true)
    expect(i.top + i.bottom).toBeLessThanOrEqual(Math.floor(phone.h * 0.4))
  })
})
