// The wheel on Lobby's camera (zoom.ts): the Input device preference (W5-33, CR-W5-3A-4), over a small
// in-memory canvas with the engine's camera arithmetic (scene = camera + canvas pixel / zoom).
import { describe, expect, it } from 'vitest'
import type {
  CanvasInputEvent,
  LobbyCanvas,
  Viewport,
  WheelPreference,
} from '../../../../canvas/api/index.ts'
import {
  ENGINE_MAX_ZOOM,
  installWheelZoom,
  looksLikeMouseWheel,
  plainWheelZooms,
  wheelZoomStep,
} from './zoom.ts'

describe('the Input device guess (auto)', () => {
  it('a mouse wheel notch is a zoom: whole hundreds on one axis, or lines and pages', () => {
    for (const dy of [100, -100, 200, -300, 120, 240]) expect(looksLikeMouseWheel({ deltaY: dy })).toBe(true)
    expect(looksLikeMouseWheel({ deltaY: 3, deltaMode: 1 })).toBe(true)
    expect(looksLikeMouseWheel({ deltaY: -1, deltaMode: 2 })).toBe(true)
  })

  it('a trackpad scroll is a pan: small or uneven pixel steps, or a sideways part', () => {
    for (const dy of [1, 4, -11, 33.3333, 57.5, 99, 150, 101]) {
      expect(looksLikeMouseWheel({ deltaY: dy, deltaX: 0, deltaMode: 0 })).toBe(false)
    }
    expect(looksLikeMouseWheel({ deltaY: 100, deltaX: 4 })).toBe(false)
    expect(looksLikeMouseWheel({ deltaY: 0 })).toBe(false)
    expect(looksLikeMouseWheel({})).toBe(false)
    expect(looksLikeMouseWheel({ deltaY: Number.NaN })).toBe(false)
  })

  it('the preference decides when it is not auto', () => {
    const notch = { deltaY: 100, deltaX: 0, deltaMode: 0 }
    const swipe = { deltaY: 7, deltaX: 2, deltaMode: 0 }
    expect(plainWheelZooms('auto', notch)).toBe(true)
    expect(plainWheelZooms('auto', swipe)).toBe(false)
    expect(plainWheelZooms('mouse', notch)).toBe(true)
    expect(plainWheelZooms('mouse', swipe)).toBe(true)
    expect(plainWheelZooms('trackpad', notch)).toBe(false)
    expect(plainWheelZooms('trackpad', swipe)).toBe(false)
  })
})

describe('wheelZoomStep (a plain wheel that zooms)', () => {
  const limits = { min: 0.05 }
  it('is 10% of the zoom a notch, at any zoom, in and out', () => {
    expect(wheelZoomStep(1, { deltaY: 100, deltaMode: 0 }, limits)).toBeCloseTo(0.9)
    expect(wheelZoomStep(1, { deltaY: -100, deltaMode: 0 }, limits)).toBeCloseTo(1.1)
    expect(wheelZoomStep(0.5, { deltaY: -100, deltaMode: 0 }, limits)).toBeCloseTo(0.55)
    expect(wheelZoomStep(4, { deltaY: 100, deltaMode: 0 }, limits)).toBeCloseTo(3.6)
    // the engine's most per event: a fast turn is no more than a notch, a lines wheel steps by lines
    expect(wheelZoomStep(1, { deltaY: 500, deltaMode: 0 }, limits)).toBeCloseTo(0.9)
    expect(wheelZoomStep(1, { deltaY: 3, deltaMode: 1 }, limits)).toBeCloseTo(0.9)
  })

  it('out stops at the whole-board fit and never zooms in; in stops at the engine top', () => {
    expect(wheelZoomStep(0.051, { deltaY: 100, deltaMode: 0 }, limits)).toBe(0.05)
    expect(wheelZoomStep(0.05, { deltaY: 100, deltaMode: 0 }, limits)).toBe(0.05)
    // below the floor already (the board shrank): an out notch stays put
    expect(wheelZoomStep(0.03, { deltaY: 100, deltaMode: 0 }, limits)).toBe(0.03)
    expect(wheelZoomStep(29.5, { deltaY: -100, deltaMode: 0 }, limits)).toBe(ENGINE_MAX_ZOOM)
    expect(wheelZoomStep(ENGINE_MAX_ZOOM, { deltaY: -100, deltaMode: 0 }, limits)).toBe(ENGINE_MAX_ZOOM)
  })

  it('is nothing for no delta', () => {
    expect(wheelZoomStep(1, { deltaY: 0, deltaMode: 0 }, limits)).toBeNull()
    expect(wheelZoomStep(1, { deltaY: Number.NaN, deltaMode: 0 }, limits)).toBeNull()
    expect(wheelZoomStep(0, { deltaY: 100, deltaMode: 0 }, limits)).toBeNull()
  })
})

// ---- installWheelZoom over a small canvas --------------------------------------------------------------------

interface Fake {
  readonly canvas: LobbyCanvas
  /** the camera */
  readonly cam: { x: number; y: number; zoom: number }
  /** every camera `viewport.set` was given */
  readonly sets: { x: number; y: number; zoom: number }[]
  emit(e: unknown): { handled: boolean }
  setWheel(w: WheelPreference): void
}

/** A canvas 1000 x 600 px at the page origin; `fit` is the whole-board fit (`limits().min`). */
function fakeCanvas(opts: { zoom: number; fit: number; wheel?: WheelPreference }): Fake {
  const cam = { x: 0, y: 0, zoom: opts.zoom }
  const sets: Fake['sets'] = []
  let wheel: WheelPreference = opts.wheel ?? 'auto'
  const listeners: ((e: CanvasInputEvent) => void)[] = []
  const canvas = {
    on(event: string, fn: (e: CanvasInputEvent) => void) {
      if (event === 'input') listeners.push(fn)
      return () => void listeners.splice(listeners.indexOf(fn), 1)
    },
    viewport: {
      get: (): Viewport => ({ ...cam, width: 1000 / cam.zoom, height: 600 / cam.zoom }),
      set(v: { x: number; y: number; zoom: number }) {
        sets.push({ ...v })
        Object.assign(cam, v)
      },
      limits: () => ({ min: opts.fit, max: 8, steps: [], fit: opts.fit }),
    },
    screenToScene: (p: { x: number; y: number }) => ({
      x: cam.x + p.x / cam.zoom,
      y: cam.y + p.y / cam.zoom,
    }),
    settings: { get: () => ({ grid: false, snap: false, focusMode: false, wheel }) },
  } as unknown as LobbyCanvas
  return {
    canvas,
    cam,
    sets,
    setWheel: (w) => {
      wheel = w
    },
    emit(e) {
      let handled = false
      const ev = {
        shift: false,
        alt: false,
        ctrl: false,
        meta: false,
        ...(e as object),
        handled() {
          handled = true
        },
      } as CanvasInputEvent
      for (const l of [...listeners]) l(ev)
      return { handled }
    },
  }
}

const wheel = (deltaY: number, at = { x: 400, y: 200 }, more: object = {}) => ({
  type: 'wheel',
  screen: at,
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  ...more,
})

describe('installWheelZoom: the plain wheel and the Input device preference (W5-33)', () => {
  const sceneUnder = (f: Fake, p: { x: number; y: number }) => f.canvas.screenToScene(p)

  it('mouse: a plain wheel zooms around the pointer, whatever its notches look like; the engine does not see it', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.05, wheel: 'mouse' })
    installWheelZoom(f.canvas)
    const at = { x: 400, y: 200 }
    const before = sceneUnder(f, at)
    // a trackpad-sized step zooms too: the preference says so
    expect(f.emit(wheel(7, at, { deltaX: 3 })).handled).toBe(true)
    expect(f.cam.zoom).toBeLessThan(1)
    expect(f.emit(wheel(-100, at)).handled).toBe(true)
    const after = sceneUnder(f, at)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('mouse: a notch is 10% at any zoom, in and out (the engine adds 0.1)', () => {
    const f = fakeCanvas({ zoom: 4, fit: 0.05, wheel: 'mouse' })
    installWheelZoom(f.canvas)
    f.emit(wheel(100))
    expect(f.cam.zoom).toBeCloseTo(3.6)
    const g = fakeCanvas({ zoom: 0.5, fit: 0.05, wheel: 'mouse' })
    installWheelZoom(g.canvas)
    g.emit(wheel(-100))
    expect(g.cam.zoom).toBeCloseTo(0.55)
  })

  it('trackpad: a plain wheel is the engine’s pan (not taken, no camera move)', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.05, wheel: 'trackpad' })
    installWheelZoom(f.canvas)
    expect(f.emit(wheel(100)).handled).toBe(false)
    expect(f.emit(wheel(-300)).handled).toBe(false)
    expect(f.sets).toEqual([])
  })

  it('auto: a mouse notch zooms and a trackpad scroll pans', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.05, wheel: 'auto' })
    installWheelZoom(f.canvas)
    expect(f.emit(wheel(11, { x: 1, y: 1 }, { deltaX: 2 })).handled).toBe(false)
    expect(f.emit(wheel(33.3333)).handled).toBe(false)
    expect(f.sets).toEqual([])
    expect(f.emit(wheel(100)).handled).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.9)
  })

  it('reads the preference at each event: a change in Preferences applies to the next wheel', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.05, wheel: 'trackpad' })
    installWheelZoom(f.canvas)
    expect(f.emit(wheel(100)).handled).toBe(false)
    f.setWheel('mouse')
    expect(f.emit(wheel(100)).handled).toBe(true)
    f.setWheel('trackpad')
    expect(f.emit(wheel(100)).handled).toBe(false)
  })

  it('Shift + wheel pans sideways and Ctrl/Cmd + wheel is the zoom wheel, as before, with any preference', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.05, wheel: 'mouse' })
    installWheelZoom(f.canvas)
    // sideways pan: the engine's
    expect(f.emit(wheel(100, undefined, { shift: true })).handled).toBe(false)
    // Ctrl + wheel at 1: the engine's own zoom still (it is above 0.1)
    expect(f.emit(wheel(100, undefined, { ctrl: true })).handled).toBe(false)
    expect(f.emit(wheel(100, undefined, { meta: true })).handled).toBe(false)
    expect(f.sets).toEqual([])
    // Ctrl + wheel below 0.1 is Lobby's, as before
    const g = fakeCanvas({ zoom: 0.08, fit: 0.02, wheel: 'trackpad' })
    installWheelZoom(g.canvas)
    expect(g.emit(wheel(100, undefined, { ctrl: true })).handled).toBe(true)
    expect(g.cam.zoom).toBeCloseTo(0.072)
  })

  it('a canvas with no settings (a unit test’s) leaves a plain wheel to the engine', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.05 })
    ;(f.canvas as unknown as { settings: unknown }).settings = {
      get: () => {
        throw new Error('no settings')
      },
    }
    installWheelZoom(f.canvas)
    expect(f.emit(wheel(100)).handled).toBe(false)
  })

  it('the unsubscribe stops it', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.05, wheel: 'mouse' })
    const off = installWheelZoom(f.canvas)
    off()
    expect(f.emit(wheel(100)).handled).toBe(false)
  })
})
