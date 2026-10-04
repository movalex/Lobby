// The Input device guess under display scaling and browser zoom (wave B follow-up 3, wave D6): Chrome and Edge
// report a mouse notch in CSS pixels, so a notch that is 100 at a ratio of 1 arrives as 100 / ratio at 125%
// (80), 150% (66.67) and 200% (50). `looksLikeMouseWheel` reads `pixelRatio` (window.devicePixelRatio, which
// folds the browser zoom in); `installWheelZoom` reads it at each wheel event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasInputEvent, LobbyCanvas, Viewport } from '../../../../canvas/api/index.ts'
import {
  currentPixelRatio,
  installWheelZoom,
  isMacPlatform,
  looksLikeMouseWheel,
  plainWheelZooms,
} from './zoom.ts'

const RATIOS = [1, 1.25, 1.5, 2] as const

// The scaled-notch rule is for Windows and Linux (wave E3): these tests run as on Windows whatever machine
// they run on (Node's own navigator.platform follows the host). The macOS cases are at the end.
beforeEach(() => void vi.stubGlobal('navigator', { platform: 'Win32' }))
afterEach(() => void vi.unstubAllGlobals())

/** What Chromium reports for `n` notches of `base` px at `ratio`, as a float32 would hold it. */
const reported = (n: number, base: number, ratio: number) => Math.fround((n * base) / ratio)

describe('looksLikeMouseWheel under display scaling and browser zoom', () => {
  it.each(RATIOS)('ratio %s: one notch (100 or 120 over the ratio) is a mouse, in and out', (ratio) => {
    for (const base of [100, 120]) {
      const dy = reported(1, base, ratio)
      expect(looksLikeMouseWheel({ deltaY: dy, deltaX: 0, deltaMode: 0, pixelRatio: ratio }), `${dy}`).toBe(
        true,
      )
      expect(looksLikeMouseWheel({ deltaY: -dy, deltaX: 0, deltaMode: 0, pixelRatio: ratio }), `${-dy}`).toBe(
        true,
      )
    }
  })

  it.each(RATIOS)('ratio %s: a wheel turned fast is whole notches (2, 3 and 5 at once)', (ratio) => {
    for (const base of [100, 120])
      for (const n of [2, 3, 5])
        expect(looksLikeMouseWheel({ deltaY: reported(n, base, ratio), pixelRatio: ratio })).toBe(true)
  })

  it.each(RATIOS)('ratio %s: a browser that rounds the delta to whole pixels is still a mouse', (ratio) => {
    for (const base of [100, 120])
      for (const n of [1, 2, 3])
        expect(looksLikeMouseWheel({ deltaY: Math.round((n * base) / ratio), pixelRatio: ratio })).toBe(true)
  })

  it.each(RATIOS)(
    'ratio %s: a trackpad scroll is still a pan: small or uneven steps, or a sideways part',
    (ratio) => {
      for (const dy of [1, 3.2, 4, -11, 17.5, 33.3333, 57.5, 7.25, -24.1, 88.8])
        expect(looksLikeMouseWheel({ deltaY: dy, deltaX: 0, deltaMode: 0, pixelRatio: ratio }), `${dy}`).toBe(
          false,
        )
      // a whole notch with a sideways part is a trackpad's diagonal swipe
      expect(looksLikeMouseWheel({ deltaY: reported(1, 100, ratio), deltaX: 3, pixelRatio: ratio })).toBe(
        false,
      )
      expect(looksLikeMouseWheel({ deltaY: 0, pixelRatio: ratio })).toBe(false)
      expect(looksLikeMouseWheel({ deltaY: Number.NaN, pixelRatio: ratio })).toBe(false)
    },
  )

  it.each(RATIOS)('ratio %s: lines and pages are a mouse whatever the ratio (Firefox)', (ratio) => {
    expect(looksLikeMouseWheel({ deltaY: 3, deltaMode: 1, pixelRatio: ratio })).toBe(true)
    expect(looksLikeMouseWheel({ deltaY: -1, deltaMode: 2, pixelRatio: ratio })).toBe(true)
  })

  it('the unscaled notch still counts at any ratio (a display whose scaling the browser leaves out of the delta)', () => {
    for (const ratio of RATIOS)
      for (const dy of [100, -100, 120, 200, 300, 240])
        expect(looksLikeMouseWheel({ deltaY: dy, pixelRatio: ratio }), `${dy} at ${ratio}`).toBe(true)
  })

  it('a scaled notch is a mouse only at its own ratio: 80 is a trackpad step at 1 and a notch at 1.25', () => {
    expect(looksLikeMouseWheel({ deltaY: 80, pixelRatio: 1 })).toBe(false)
    expect(looksLikeMouseWheel({ deltaY: 80 })).toBe(false)
    expect(looksLikeMouseWheel({ deltaY: 80, pixelRatio: 1.25 })).toBe(true)
    // 66.67 is a notch at 150% (and 80, the 120 notch, too), nothing at 125%
    expect(looksLikeMouseWheel({ deltaY: reported(1, 100, 1.5), pixelRatio: 1.5 })).toBe(true)
    expect(looksLikeMouseWheel({ deltaY: reported(1, 100, 1.5), pixelRatio: 1.25 })).toBe(false)
    expect(looksLikeMouseWheel({ deltaY: 50, pixelRatio: 2 })).toBe(true)
    expect(looksLikeMouseWheel({ deltaY: 50, pixelRatio: 1.5 })).toBe(false)
    expect(looksLikeMouseWheel({ deltaY: 60, pixelRatio: 2 })).toBe(true)
  })

  it('at a ratio of 1 (or none) it is the rule it was: whole hundreds, or 120s, and nothing near them', () => {
    for (const pixelRatio of [undefined, 1, 1.0001]) {
      for (const dy of [100, -100, 200, -300, 120, 240])
        expect(looksLikeMouseWheel({ deltaY: dy, ...(pixelRatio ? { pixelRatio } : {}) })).toBe(true)
      for (const dy of [1, 4, -11, 33.3333, 57.5, 99, 150, 101, 80, 66.67, 50])
        expect(looksLikeMouseWheel({ deltaY: dy, ...(pixelRatio ? { pixelRatio } : {}) }), `${dy}`).toBe(
          false,
        )
    }
  })

  it('a ratio that is not a sensible number is read as 1', () => {
    for (const pixelRatio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.01, 99]) {
      expect(looksLikeMouseWheel({ deltaY: 80, pixelRatio }), `${pixelRatio}`).toBe(false)
      expect(looksLikeMouseWheel({ deltaY: 100, pixelRatio }), `${pixelRatio}`).toBe(true)
    }
  })

  it('the preference still decides when it is not auto, whatever the ratio', () => {
    const swipe = { deltaY: 7, deltaX: 2, deltaMode: 0, pixelRatio: 1.5 }
    const notch = { deltaY: reported(1, 100, 1.5), deltaX: 0, deltaMode: 0, pixelRatio: 1.5 }
    expect(plainWheelZooms('auto', notch)).toBe(true)
    expect(plainWheelZooms('auto', swipe)).toBe(false)
    expect(plainWheelZooms('mouse', swipe)).toBe(true)
    expect(plainWheelZooms('trackpad', notch)).toBe(false)
  })
})

describe('currentPixelRatio', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is the page’s devicePixelRatio, and 1 when there is none or it is nonsense', () => {
    expect(currentPixelRatio()).toBe(1)
    for (const r of RATIOS) {
      vi.stubGlobal('devicePixelRatio', r)
      expect(currentPixelRatio()).toBe(r)
    }
    // browser zoom is in it (a 125% display at 110% zoom)
    vi.stubGlobal('devicePixelRatio', 1.375)
    expect(currentPixelRatio()).toBe(1.375)
    for (const bad of [0, -2, Number.NaN, '2', null, 400]) {
      vi.stubGlobal('devicePixelRatio', bad)
      expect(currentPixelRatio()).toBe(1)
    }
  })
})

// ---- installWheelZoom reads the ratio at each wheel event -----------------------------------------------

/** A canvas 1000 x 600 px at the page origin, with the Input device on `auto`. */
function fakeCanvas() {
  const cam = { x: 0, y: 0, zoom: 1 }
  const listeners: ((e: CanvasInputEvent) => void)[] = []
  const canvas = {
    on(event: string, fn: (e: CanvasInputEvent) => void) {
      if (event === 'input') listeners.push(fn)
      return () => void listeners.splice(listeners.indexOf(fn), 1)
    },
    viewport: {
      get: (): Viewport => ({ ...cam, width: 1000 / cam.zoom, height: 600 / cam.zoom }),
      set: (v: { x: number; y: number; zoom: number }) => void Object.assign(cam, v),
      limits: () => ({ min: 0.05, max: 8, steps: [], fit: 0.05 }),
    },
    screenToScene: (p: { x: number; y: number }) => ({
      x: cam.x + p.x / cam.zoom,
      y: cam.y + p.y / cam.zoom,
    }),
    settings: { get: () => ({ grid: false, snap: false, focusMode: false, wheel: 'auto' as const }) },
  } as unknown as LobbyCanvas
  const wheel = (deltaY: number, deltaX = 0) => {
    let handled = false
    const ev = {
      type: 'wheel',
      screen: { x: 400, y: 200 },
      deltaX,
      deltaY,
      deltaMode: 0,
      shift: false,
      alt: false,
      ctrl: false,
      meta: false,
      handled() {
        handled = true
      },
    } as CanvasInputEvent
    for (const l of [...listeners]) l(ev)
    return handled
  }
  return { canvas, cam, wheel }
}

describe('installWheelZoom with the Input device on auto, per display ratio', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(RATIOS)('ratio %s: a mouse notch zooms 10% and a trackpad step pans, as at 100%', (ratio) => {
    vi.stubGlobal('devicePixelRatio', ratio)
    const f = fakeCanvas()
    installWheelZoom(f.canvas)
    // the trackpad's: the engine pans (not taken, the camera untouched)
    expect(f.wheel(7.5, 2)).toBe(false)
    expect(f.wheel(33.3333)).toBe(false)
    expect(f.cam.zoom).toBe(1)
    // the mouse's: one notch out, as Chromium reports it at this ratio
    expect(f.wheel(reported(1, 100, ratio))).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.9)
  })

  it('the same 80 px step pans at 100% and zooms at 125%: the ratio is read at the event, not once', () => {
    const f = fakeCanvas()
    installWheelZoom(f.canvas)
    vi.stubGlobal('devicePixelRatio', 1)
    expect(f.wheel(80)).toBe(false)
    expect(f.cam.zoom).toBe(1)
    // the person turns the browser zoom up to 125%: from the next notch it is a mouse
    vi.stubGlobal('devicePixelRatio', 1.25)
    expect(f.wheel(80)).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.9)
    // and back: a plain 80 is a trackpad again
    vi.stubGlobal('devicePixelRatio', 1)
    expect(f.wheel(80)).toBe(false)
    expect(f.cam.zoom).toBeCloseTo(0.9)
  })

  it('a canvas in a page with no devicePixelRatio (a unit test) guesses as at 100%', () => {
    const f = fakeCanvas()
    installWheelZoom(f.canvas)
    expect(f.wheel(80)).toBe(false)
    expect(f.wheel(100)).toBe(true)
  })
})

// ---- macOS: only the unscaled notches count (wave E3, D6-1) ---------------------------------------------

describe('on macOS the scaled notch is not a mouse', () => {
  const MAC = { mac: true } as const

  it.each(RATIOS)('ratio %s: 100 / ratio and 120 / ratio are a trackpad’s steps, not a mouse', (ratio) => {
    if (ratio === 1) return // unscaled: there is no scaled notch (it is 100 or 120 itself)
    // one notch of 100 or 120 as Chromium reports it at this ratio (2 or 3 of them can add up to an unscaled
    // notch, which still counts: below)
    for (const base of [100, 120])
      expect(
        looksLikeMouseWheel({ deltaY: reported(1, base, ratio), pixelRatio: ratio, ...MAC }),
        `${base} at ${ratio}`,
      ).toBe(false)
    // the small whole steps a Retina trackpad can make, which a scaled notch would swallow
    for (const dy of [50, 60, 80, 66.67])
      expect(looksLikeMouseWheel({ deltaY: dy, pixelRatio: ratio, ...MAC }), `${dy} at ${ratio}`).toBe(false)
  })

  it.each(RATIOS)(
    'ratio %s: the unscaled notches still count (the rule before the ratio was read)',
    (ratio) => {
      for (const dy of [100, -100, 120, 200, 300, 240])
        expect(looksLikeMouseWheel({ deltaY: dy, pixelRatio: ratio, ...MAC }), `${dy} at ${ratio}`).toBe(true)
      // and lines or pages, as on Firefox
      expect(looksLikeMouseWheel({ deltaY: 3, deltaMode: 1, pixelRatio: ratio, ...MAC })).toBe(true)
      expect(looksLikeMouseWheel({ deltaY: -1, deltaMode: 2, pixelRatio: ratio, ...MAC })).toBe(true)
    },
  )

  it('the same 50 px step is a mouse notch at 200% off macOS and a trackpad step on a Mac', () => {
    expect(looksLikeMouseWheel({ deltaY: 50, pixelRatio: 2, mac: false })).toBe(true)
    expect(looksLikeMouseWheel({ deltaY: 50, pixelRatio: 2, mac: true })).toBe(false)
    expect(looksLikeMouseWheel({ deltaY: 80, pixelRatio: 1.25, mac: false })).toBe(true)
    expect(looksLikeMouseWheel({ deltaY: 80, pixelRatio: 1.25, mac: true })).toBe(false)
  })

  it('reads the platform from the browser when the event does not say', () => {
    const notch = { deltaY: 50, pixelRatio: 2 }
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(isMacPlatform()).toBe(false)
    expect(looksLikeMouseWheel(notch)).toBe(true)
    for (const platform of ['MacIntel', 'MacARM', 'iPad', 'iPhone']) {
      vi.stubGlobal('navigator', { platform })
      expect(isMacPlatform(), platform).toBe(true)
      expect(looksLikeMouseWheel(notch), platform).toBe(false)
    }
    // Chromium's client hints say it too (and win a platform string that was reduced to something else)
    vi.stubGlobal('navigator', { platform: '', userAgentData: { platform: 'macOS' } })
    expect(isMacPlatform()).toBe(true)
    expect(looksLikeMouseWheel(notch)).toBe(false)
    for (const nav of [
      { platform: 'Linux x86_64' },
      { platform: 'Win32', userAgentData: { platform: 'Windows' } },
      {},
    ]) {
      vi.stubGlobal('navigator', nav)
      expect(isMacPlatform()).toBe(false)
      expect(looksLikeMouseWheel(notch)).toBe(true)
    }
    vi.stubGlobal('navigator', undefined)
    expect(isMacPlatform()).toBe(false)
  })

  it('installWheelZoom on a Mac at 200% pans a 50 px step and still zooms a 100 px notch', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    vi.stubGlobal('devicePixelRatio', 2)
    const f = fakeCanvas()
    installWheelZoom(f.canvas)
    expect(f.wheel(50)).toBe(false) // a trackpad's step: the engine pans
    expect(f.wheel(60)).toBe(false)
    expect(f.cam.zoom).toBe(1)
    expect(f.wheel(100)).toBe(true) // an unscaled notch: a mouse
    expect(f.cam.zoom).toBeCloseTo(0.9)
  })
})
