// The wheel and the touch pinch on Lobby's camera (zoom.ts): the Input device preference (W5-33,
// CR-W5-3A-4) and the two-finger pinch below Excalidraw's 0.1 (CR 3b-10, W5-19), over a small in-memory
// canvas with the engine's camera arithmetic (scene = camera + canvas pixel / zoom).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  pinchBelowEngineFloor,
  pinchCamera,
  pinchTakenByLobby,
  pinchZoom,
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

describe('the touch pinch arithmetic', () => {
  it('the engine keeps a pinch that stays at 0.1 or above; Lobby takes one that started below it or goes below', () => {
    const fits = { min: 0.02 }
    expect(pinchBelowEngineFloor(1, 0.5)).toBe(false)
    expect(pinchBelowEngineFloor(0.2, 2)).toBe(false)
    expect(pinchBelowEngineFloor(0.2, 0.6)).toBe(false)
    expect(pinchBelowEngineFloor(0.2, 0.4)).toBe(true)
    expect(pinchBelowEngineFloor(0.1, 0.99)).toBe(true)
    expect(pinchBelowEngineFloor(0.1, 1)).toBe(false)
    // from below 0.1 any scale: the engine would snap it up to 0.1 on its first move
    expect(pinchBelowEngineFloor(0.05, 1)).toBe(true)
    expect(pinchBelowEngineFloor(0.05, 3)).toBe(true)
    expect(pinchTakenByLobby(0.2, 0.3, fits)).toBe(true)
    expect(pinchTakenByLobby(0.05, 1.5, fits)).toBe(true)
    expect(pinchTakenByLobby(0.5, 0.9, fits)).toBe(false)
    // a board that fits at 0.1 has nothing below it to show: the engine's own clamp is right
    expect(pinchTakenByLobby(0.2, 0.3, { min: 0.1 })).toBe(false)
    expect(pinchTakenByLobby(0.2, 0.3, { min: 0.5 })).toBe(false)
    // but one that is already below 0.1 is Lobby's whatever the board
    expect(pinchTakenByLobby(0.05, 1.2, { min: 0.1 })).toBe(true)
    for (const bad of [0, -1, Number.NaN]) expect(pinchTakenByLobby(bad, 1, fits)).toBe(false)
    expect(pinchTakenByLobby(0.2, 0, fits)).toBe(false)
    expect(pinchTakenByLobby(0.2, Number.NaN, fits)).toBe(false)
  })

  it('the zoom is start x scale within the limits, and never zooms in on an out gesture', () => {
    const fits = { min: 0.02 }
    expect(pinchZoom(0.5, 0.2, fits)).toBeCloseTo(0.1)
    expect(pinchZoom(0.5, 0.05, fits)).toBeCloseTo(0.025)
    expect(pinchZoom(0.5, 0.01, fits)).toBe(0.02)
    expect(pinchZoom(0.05, 1.5, fits)).toBeCloseTo(0.075)
    // below the floor already: out stays where it was, in goes up
    expect(pinchZoom(0.01, 0.5, fits)).toBe(0.01)
    expect(pinchZoom(0.01, 3, fits)).toBeCloseTo(0.03)
    expect(pinchZoom(10, 10, fits)).toBe(ENGINE_MAX_ZOOM)
    expect(pinchZoom(40, 1, fits)).toBe(40)
  })

  it('the camera keeps the scene point under the fingers where they are', () => {
    // scene point (500, 300) under canvas pixel (200, 100) at zoom 0.04 -> camera (500 - 200/0.04, 300 - 100/0.04)
    const to = pinchCamera({ x: 500, y: 300 }, { x: 200, y: 100 }, 0.04)
    expect(to).toEqual({ x: -4500, y: -2200, zoom: 0.04 })
    // and the point is under the pixel again on that camera
    expect(to.x + 200 / to.zoom).toBeCloseTo(500)
    expect(to.y + 100 / to.zoom).toBeCloseTo(300)
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

describe('installWheelZoom: the two-finger touch pinch (CR 3b-10)', () => {
  const pinch = (
    phase: 'start' | 'move' | 'end',
    scale: number,
    centre: { x: number; y: number },
    start = { x: 500, y: 300 },
  ) => ({ type: 'pinch', screen: centre, touch: { phase, scale, startScreen: start } })
  const MID = { x: 500, y: 300 }
  const sceneUnder = (f: Fake, p: { x: number; y: number }) => f.canvas.screenToScene(p)

  it('leaves a pinch that stays at or above 0.1 to the engine, move after move', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.02 })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1, MID))
    for (const scale of [0.9, 0.5, 0.2, 0.11])
      expect(f.emit(pinch('move', scale, MID)).handled, `scale ${scale}`).toBe(false)
    expect(f.sets).toEqual([])
    f.emit(pinch('end', 0.11, MID))
  })

  it('takes the move that goes below 0.1 and every one after it, down to the whole-board fit', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.02 })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1, MID))
    // the engine pinched to 0.2 (it is what the camera holds when Lobby takes over)
    expect(f.emit(pinch('move', 0.2, MID)).handled).toBe(false)
    f.cam.zoom = 0.2
    expect(f.emit(pinch('move', 0.05, MID)).handled).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.05)
    expect(f.emit(pinch('move', 0.01, MID)).handled).toBe(true)
    // the fit: 0.02, not the engine's 0.1 and not 0.01
    expect(f.cam.zoom).toBe(0.02)
    // and back out past 0.1 the gesture is still Lobby's (the engine's pan state is stale by now)
    expect(f.emit(pinch('move', 0.4, MID)).handled).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.4)
    f.emit(pinch('end', 0.4, MID))
  })

  it('the point between the fingers stays between them, and the pan of the fingers moves the board', () => {
    const f = fakeCanvas({ zoom: 0.1, fit: 0.02 })
    f.cam.x = -3000
    f.cam.y = -1500
    installWheelZoom(f.canvas)
    const under = sceneUnder(f, MID)
    f.emit(pinch('start', 1, MID))
    // spread to 0.4x: below 0.1 at once (0.04), the fingers' middle unmoved
    expect(f.emit(pinch('move', 0.4, MID)).handled).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.04)
    const stay = sceneUnder(f, MID)
    expect(stay.x).toBeCloseTo(under.x, 4)
    expect(stay.y).toBeCloseTo(under.y, 4)
    // the middle of the fingers drags 80 px right and 30 px down: the scene point goes with it
    const moved = { x: MID.x + 80, y: MID.y + 30 }
    expect(f.emit(pinch('move', 0.4, moved)).handled).toBe(true)
    const follow = sceneUnder(f, moved)
    expect(follow.x).toBeCloseTo(under.x, 4)
    expect(follow.y).toBeCloseTo(under.y, 4)
  })

  it('a pinch that starts below 0.1 is Lobby’s from its first move: it does not snap up to 0.1', () => {
    const f = fakeCanvas({ zoom: 0.05, fit: 0.02 })
    installWheelZoom(f.canvas)
    const under = sceneUnder(f, MID)
    f.emit(pinch('start', 1, MID))
    expect(f.emit(pinch('move', 1.2, MID)).handled).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.06)
    expect(f.emit(pinch('move', 3, MID)).handled).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.15)
    const stay = sceneUnder(f, MID)
    expect(stay.x).toBeCloseTo(under.x, 4)
    expect(stay.y).toBeCloseTo(under.y, 4)
  })

  it('a pinch out below the floor of a board that shrank stays put (it never zooms in)', () => {
    const f = fakeCanvas({ zoom: 0.03, fit: 0.05 })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1, MID))
    expect(f.emit(pinch('move', 0.5, MID)).handled).toBe(true)
    expect(f.cam.zoom).toBe(0.03)
  })

  it('a board that fits at 0.1 has nothing below it: the engine keeps the pinch', () => {
    const f = fakeCanvas({ zoom: 0.3, fit: 0.1 })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1, MID))
    expect(f.emit(pinch('move', 0.1, MID)).handled).toBe(false)
    expect(f.sets).toEqual([])
  })

  it('each pinch starts fresh: the end lets the engine have the next one that stays above 0.1', () => {
    const f = fakeCanvas({ zoom: 1, fit: 0.02 })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1, MID))
    f.cam.zoom = 0.2
    f.emit(pinch('move', 0.2, MID))
    expect(f.emit(pinch('move', 0.05, MID)).handled).toBe(true)
    f.emit(pinch('end', 0.05, MID))
    f.cam.zoom = 1
    f.sets.length = 0
    f.emit(pinch('start', 1, MID))
    expect(f.emit(pinch('move', 0.5, MID)).handled).toBe(false)
    expect(f.sets).toEqual([])
  })

  it('moves with no start (a listener installed mid-gesture) are the engine’s', () => {
    const f = fakeCanvas({ zoom: 0.05, fit: 0.02 })
    installWheelZoom(f.canvas)
    expect(f.emit(pinch('move', 2, MID)).handled).toBe(false)
    expect(f.sets).toEqual([])
  })
})

describe('installWheelZoom: the engine’s late pinch update (CR 3b-10)', () => {
  // The engine applies its own last pinch move a flush after Lobby's first camera (its pinch calls
  // `translate` inside a state updater), so what it left is put back on the next frames.
  const frames: (() => void)[] = []
  const realRaf = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame
  const flush = () => {
    const run = frames.splice(0)
    for (const f of run) f()
  }
  beforeEach(() => {
    frames.length = 0
    globalThis.requestAnimationFrame = ((f: () => void) => frames.push(f)) as never
    globalThis.cancelAnimationFrame = ((id: number) => {
      frames[id - 1] = () => {}
    }) as never
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
    globalThis.cancelAnimationFrame = realCancel
  })
  const MID = { x: 500, y: 300 }
  const pinch = (phase: 'start' | 'move' | 'end', scale: number) => ({
    type: 'pinch',
    screen: MID,
    touch: { phase, scale, startScreen: MID },
  })

  it('puts the camera back when the engine lands its update over it, and stops after two frames', () => {
    const f = fakeCanvas({ zoom: 0.5, fit: 0.02 })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1))
    f.emit(pinch('move', 0.3))
    expect(f.emit(pinch('move', 0.18)).handled).toBe(true)
    expect(f.cam.zoom).toBeCloseTo(0.09)
    const held = { ...f.cam }
    const sets = f.sets.length
    // the engine's late update for the move before: zoom 0.111
    Object.assign(f.cam, { x: 10, y: 20, zoom: 0.111 })
    flush()
    expect(f.sets.length).toBe(sets + 1)
    expect(f.cam).toEqual(held)
    // landed and stayed: nothing more to do, and the check ends
    flush()
    expect(f.sets.length).toBe(sets + 1)
    flush()
    expect(frames).toEqual([])
  })

  it('leaves a camera that is already where Lobby put it alone', () => {
    const f = fakeCanvas({ zoom: 0.5, fit: 0.02 })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1))
    f.emit(pinch('move', 0.18))
    const sets = f.sets.length
    flush()
    flush()
    expect(f.sets.length).toBe(sets)
  })

  it('lets go when the person moves the camera another way (a wheel, a new pinch)', () => {
    const f = fakeCanvas({ zoom: 0.5, fit: 0.02, wheel: 'mouse' })
    installWheelZoom(f.canvas)
    f.emit(pinch('start', 1))
    f.emit(pinch('move', 0.18))
    f.emit(wheel(100))
    const zoom = f.cam.zoom
    const sets = f.sets.length
    flush()
    flush()
    expect(f.sets.length).toBe(sets)
    expect(f.cam.zoom).toBe(zoom)
  })

  it('the unsubscribe cancels it', () => {
    const f = fakeCanvas({ zoom: 0.5, fit: 0.02 })
    const off = installWheelZoom(f.canvas)
    f.emit(pinch('start', 1))
    f.emit(pinch('move', 0.18))
    off()
    const sets = f.sets.length
    Object.assign(f.cam, { zoom: 0.111 })
    flush()
    expect(f.sets.length).toBe(sets)
  })
})
