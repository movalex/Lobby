import { describe, expect, it } from 'vitest'
import { lobbyDarkColor } from '../../canvas/engine/theme.ts'
import {
  CAMERA_MOVING_TIMEOUT_MS,
  fontDefaultPatch,
  MAX_SHAPES_PER_PAGE,
  snapDefaultPatch,
  startToolFor,
} from './defaults.ts'
import { relativeLuminance } from './palette.ts'
import { DEFAULT_SHAPE_FILL, shapeFillPatch } from './ported/defaults.ts'
import { fillNameOf } from './ported/style-vocabulary.ts'

describe('alignment guides default (MAK-02)', () => {
  it('turns snapping on when the user never chose', () => {
    expect(snapDefaultPatch({})).toEqual({ isSnapMode: true })
    expect(snapDefaultPatch({ isSnapMode: null })).toEqual({ isSnapMode: true })
  })
  it('respects an explicit choice, on or off', () => {
    expect(snapDefaultPatch({ isSnapMode: false })).toBeNull()
    expect(snapDefaultPatch({ isSnapMode: true })).toBeNull()
  })
})

describe('sans by default (RETRO-21a)', () => {
  it('sets sans when no font was ever chosen', () => {
    expect(fontDefaultPatch({})).toBe('sans')
    expect(fontDefaultPatch(undefined)).toBe('sans')
    expect(fontDefaultPatch({ 'tldraw:color': 'blue' })).toBe('sans')
  })
  it('never overrides an explicit choice (handwriting included)', () => {
    expect(fontDefaultPatch({ 'tldraw:font': 'draw' })).toBeNull()
    expect(fontDefaultPatch({ 'tldraw:font': 'serif' })).toBeNull()
    expect(fontDefaultPatch({ 'tldraw:font': 'sans' })).toBeNull()
  })
})

describe('camera "moving" window (PERF-04)', () => {
  it('outlasts one slow frame (tldraw default 64 ms) without delaying the sharp re-render much', () => {
    expect(CAMERA_MOVING_TIMEOUT_MS).toBeGreaterThanOrEqual(250)
    expect(CAMERA_MOVING_TIMEOUT_MS).toBeLessThanOrEqual(300)
  })
})

describe('start tool on touch devices (PRI-13)', () => {
  it('read-only people on a coarse pointer start on the Hand tool; everyone else keeps select', () => {
    expect(startToolFor({ coarsePointer: true, readonly: true })).toBe('hand')
    expect(startToolFor({ coarsePointer: true, readonly: false })).toBeNull()
    expect(startToolFor({ coarsePointer: false, readonly: true })).toBeNull()
    expect(startToolFor({ coarsePointer: false, readonly: false })).toBeNull()
  })
})

describe('shape cap (PRF-02)', () => {
  it('allows a 5,000-object board plus a 500-note paste', () => {
    expect(MAX_SHAPES_PER_PAGE).toBeGreaterThanOrEqual(10_000)
    expect(4000 + 500).toBeLessThanOrEqual(MAX_SHAPES_PER_PAGE)
  })
})

// K2-3 (wave K, UXD-12): shapes default to a solid, theme-safe light fill so they can be dragged by their middle
describe('shape fill default (K2-3)', () => {
  const none = { backgroundColor: 'transparent', fillStyle: 'solid' }

  it('rectangles, ellipses, diamonds (and the polygons) get a solid light fill when none is set', () => {
    for (const t of ['rectangle', 'ellipse', 'diamond', 'triangle', 'hexagon']) {
      expect(shapeFillPatch(t, none, false), t).toEqual(DEFAULT_SHAPE_FILL)
      expect(shapeFillPatch(t, {}, false), t).toEqual(DEFAULT_SHAPE_FILL)
    }
    expect(DEFAULT_SHAPE_FILL.fillStyle).toBe('solid')
    // light: the canvas's own colour family, a near white
    expect(relativeLuminance(DEFAULT_SHAPE_FILL.backgroundColor)).toBeGreaterThan(0.9)
    // the style panel reads it as one of its four fills (not "None")
    expect(fillNameOf(DEFAULT_SHAPE_FILL.backgroundColor, DEFAULT_SHAPE_FILL.fillStyle)).toBe('semi')
  })

  it('is theme-safe: dark mode draws it in a designed dark shade, not a white box', () => {
    const dark = lobbyDarkColor(DEFAULT_SHAPE_FILL.backgroundColor)
    expect(dark).not.toBeNull()
    expect(relativeLuminance(dark as string)).toBeLessThan(0.05)
  })

  it('connectors, lines and the pen keep no fill: the default is taken off when they are picked', () => {
    for (const t of ['arrow', 'line', 'freedraw', 'highlight']) {
      expect(shapeFillPatch(t, none, false), t).toBeNull()
      expect(shapeFillPatch(t, DEFAULT_SHAPE_FILL, false), t).toEqual({ backgroundColor: 'transparent' })
    }
  })

  it('never overrides a fill: one already set, or a pick the person made (Fill: None included)', () => {
    expect(shapeFillPatch('rectangle', { backgroundColor: '#dce1f8', fillStyle: 'solid' }, false)).toBeNull()
    expect(shapeFillPatch('rectangle', none, true)).toBeNull()
    expect(shapeFillPatch('arrow', DEFAULT_SHAPE_FILL, true)).toBeNull()
    // a fill of the person's own on a connector tool stays
    expect(shapeFillPatch('line', { backgroundColor: '#dce1f8', fillStyle: 'solid' }, false)).toBeNull()
  })

  it('other tools change nothing', () => {
    for (const t of ['select', 'hand', 'note', 'text', 'frame', 'eraser', null])
      expect(shapeFillPatch(t, none, false), String(t)).toBeNull()
  })
})
