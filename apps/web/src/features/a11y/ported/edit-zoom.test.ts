// K5-1: on a phone, editing a note zooms the LOCAL camera to a readable size above the keyboard, and puts it
// back afterwards unless the person moved it. A fake canvas: only `viewport.set` may be called (no element
// is ever written: every writing member throws).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bounds, Viewport } from '../../../canvas/api/index.ts'
import {
  type Camera,
  EDIT_MARGIN_PX,
  EDIT_TOP_PX,
  type EditZoomCanvas,
  type EditZoomEnv,
  editCamera,
  installEditZoom,
  READABLE_ZOOM,
  RESTORE_DELAY_MS,
  sameCamera,
} from './edit-zoom.ts'

const PHONE = { width: 375, height: 764 }
const NOTE: Bounds = { x: 0, y: 0, width: 200, height: 200 }

function fakeCanvas(init: {
  camera: Camera
  screen?: { width: number; height: number }
  bounds?: Record<string, Bounds>
}) {
  const screen = init.screen ?? PHONE
  let cam = { ...init.camera }
  let editing: string | null = null
  let moving = false
  const listeners = new Set<(id: string | null) => void>()
  const sets: { v: Partial<Camera>; animate: unknown }[] = []
  const writes: string[] = []
  const boundsOf = init.bounds ?? { n1: NOTE }
  const view = (): Viewport => ({
    x: cam.x,
    y: cam.y,
    width: screen.width / cam.zoom,
    height: screen.height / cam.zoom,
    zoom: cam.zoom,
  })
  const canvas: EditZoomCanvas & Record<string, unknown> = {
    on: ((event: string, fn: (id: string | null) => void) => {
      if (event !== 'editingChanged') throw new Error(`unexpected listener ${event}`)
      listeners.add(fn)
      return () => listeners.delete(fn)
    }) as EditZoomCanvas['on'],
    editingId: () => editing,
    bounds: (id: string) => boundsOf[id] ?? null,
    viewport: {
      get: view,
      set: (v, opts) => {
        sets.push({ v: { ...v }, animate: opts?.animate })
        cam = { x: v.x ?? cam.x, y: v.y ?? cam.y, zoom: v.zoom ?? cam.zoom }
      },
      screenRect: () => ({ x: 0, y: 48, ...screen }),
      limits: () => ({ min: 0.05, max: 30, steps: [], fit: 0.1 }),
      moving: () => moving,
      stop: () => {
        moving = false
      },
    },
    // what edit-zoom must never touch: a write of any kind
    transact: () => void writes.push('transact'),
    select: () => void writes.push('select'),
    setTool: () => void writes.push('setTool'),
  }
  return {
    canvas,
    sets,
    writes,
    edit(id: string | null) {
      editing = id
      for (const fn of listeners) fn(id)
    },
    pan(dx: number, dy: number) {
      cam = { ...cam, x: cam.x + dx, y: cam.y + dy }
    },
    setMoving(m: boolean) {
      moving = m
    },
    camera: () => ({ ...cam }),
    listeners: () => listeners.size,
  }
}

function env(over: Partial<EditZoomEnv> = {}): EditZoomEnv {
  return {
    coarse: () => true,
    animate: () => false,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...over,
  }
}

/** Where `b` lands on screen (canvas px) under `cam` on a `screen`-sized canvas. */
function onScreen(b: Bounds, cam: Camera) {
  return {
    left: (b.x - cam.x) * cam.zoom,
    top: (b.y - cam.y) * cam.zoom,
    width: b.width * cam.zoom,
    height: b.height * cam.zoom,
    cx: (b.x + b.width / 2 - cam.x) * cam.zoom,
    cy: (b.y + b.height / 2 - cam.y) * cam.zoom,
  }
}

/** A whole-board fit on a phone: about 0.42, the note in the middle of the canvas. */
const FIT: Camera = { x: -347, y: -809, zoom: 0.42 }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('editCamera', () => {
  it('a phone at fit zoom: the note centred across, in the upper third, at zoom max(current, 1)', () => {
    const cam = editCamera({
      view: { ...FIT, width: 0, height: 0 },
      screen: PHONE,
      bounds: NOTE,
      coarse: true,
    })
    expect(cam).not.toBeNull()
    if (!cam) return
    expect(cam.zoom).toBe(READABLE_ZOOM)
    const s = onScreen(NOTE, cam)
    expect(s.cx).toBeCloseTo(PHONE.width / 2, 6)
    // its centre in the upper third, its top below the board menu's corner, all of it above the keyboard line
    expect(s.cy).toBeLessThanOrEqual(PHONE.height / 3)
    expect(s.cy).toBeGreaterThanOrEqual(PHONE.height / 6 - 1e-6)
    expect(s.top).toBeGreaterThanOrEqual(EDIT_TOP_PX - 1e-6)
    expect(s.top + s.height).toBeLessThanOrEqual(PHONE.height * 0.45 + 1e-6)
  })

  it('a zoom already above 1 is kept (never zooms out to edit)', () => {
    const view = { x: -100, y: -300, width: 0, height: 0, zoom: 1.6 }
    // the note reaches into the bottom of the canvas
    const cam = editCamera({
      view,
      screen: PHONE,
      bounds: { x: 0, y: 0, width: 120, height: 120 },
      coarse: true,
    })
    expect(cam?.zoom).toBe(1.6)
  })

  it('a readable zoom with the note in the bottom 55 %: moved up, at max(current, 1)', () => {
    const view = { x: -80, y: -500, width: 0, height: 0, zoom: 0.9 }
    // the note's top at 450 px of 764: in the bottom 55 %
    const cam = editCamera({ view, screen: PHONE, bounds: NOTE, coarse: true })
    expect(cam?.zoom).toBe(READABLE_ZOOM)
    const s = onScreen(NOTE, cam as Camera)
    expect(s.cy).toBeLessThanOrEqual(PHONE.height / 3)
    expect(s.top).toBeGreaterThanOrEqual(EDIT_TOP_PX - 1e-6)
  })

  it('a readable zoom with the note above the keyboard line: no move', () => {
    const view = { x: -80, y: -40, width: 0, height: 0, zoom: 1 }
    expect(editCamera({ view, screen: PHONE, bounds: NOTE, coarse: true })).toBeNull()
  })

  it('a fine pointer on a canvas narrower than 600 px counts as a phone; on a wide canvas nothing moves', () => {
    const view = { ...FIT, width: 0, height: 0 }
    expect(
      editCamera({ view, screen: { width: 560, height: 700 }, bounds: NOTE, coarse: false }),
    ).not.toBeNull()
    expect(editCamera({ view, screen: { width: 1280, height: 800 }, bounds: NOTE, coarse: false })).toBeNull()
    // a tablet in portrait (a finger, 768 px): it zooms too
    expect(
      editCamera({ view, screen: { width: 768, height: 960 }, bounds: NOTE, coarse: true }),
    ).not.toBeNull()
  })

  it('an element too big for the screen at 1 gets the zoom that fits it above the keyboard line (never below the current)', () => {
    const big = { x: 0, y: 0, width: 900, height: 600 }
    const cam = editCamera({
      view: { ...FIT, width: 0, height: 0, zoom: 0.2 },
      screen: PHONE,
      bounds: big,
      coarse: true,
    })
    expect(cam).not.toBeNull()
    const z = (cam as Camera).zoom
    expect(z).toBeLessThan(1)
    expect(z).toBeGreaterThan(0.2)
    expect(big.width * z).toBeLessThanOrEqual(PHONE.width - 2 * EDIT_MARGIN_PX + 1e-6)
  })

  it('stays inside the zoom limits', () => {
    const cam = editCamera({
      view: { ...FIT, width: 0, height: 0 },
      screen: PHONE,
      bounds: NOTE,
      coarse: true,
      limits: { min: 0.1, max: 0.5 },
    })
    expect(cam?.zoom).toBe(0.5)
  })

  it('a note off screen (an edit opened from a list) is brought in even at a readable zoom', () => {
    const view = { x: 2000, y: 2000, width: 0, height: 0, zoom: 1 }
    expect(editCamera({ view, screen: PHONE, bounds: NOTE, coarse: true })).not.toBeNull()
  })
})

describe('installEditZoom', () => {
  it('when the editor opens on a phone at fit zoom it calls viewport.set once with that camera, and writes nothing', () => {
    const f = fakeCanvas({ camera: FIT })
    installEditZoom(f.canvas, env())
    f.edit('n1')
    expect(f.sets).toHaveLength(1)
    const target = f.sets[0]?.v as Camera
    expect(target.zoom).toBe(1)
    expect(onScreen(NOTE, target).cx).toBeCloseTo(PHONE.width / 2, 6)
    expect(f.writes).toEqual([])
  })

  it('when the editor closes the camera goes back to where it was (after RESTORE_DELAY_MS)', () => {
    const f = fakeCanvas({ camera: FIT })
    installEditZoom(f.canvas, env())
    f.edit('n1')
    f.edit(null)
    expect(f.sets).toHaveLength(1)
    vi.advanceTimersByTime(RESTORE_DELAY_MS)
    expect(f.sets).toHaveLength(2)
    expect(f.camera()).toEqual(FIT)
    expect(f.writes).toEqual([])
  })

  it('unless the person panned or pinched meanwhile: then the camera stays where they put it', () => {
    const f = fakeCanvas({ camera: FIT })
    installEditZoom(f.canvas, env())
    f.edit('n1')
    f.pan(40, 0)
    const panned = f.camera()
    f.edit(null)
    vi.advanceTimersByTime(RESTORE_DELAY_MS * 4)
    expect(f.sets).toHaveLength(1)
    expect(f.camera()).toEqual(panned)
  })

  it('a pan of a pixel or two (a finger resting) still counts as not moved', () => {
    expect(sameCamera({ x: 10.004, y: 20, zoom: 1 }, { x: 10, y: 20, zoom: 1 })).toBe(true)
    expect(sameCamera({ x: 13, y: 20, zoom: 1 }, { x: 10, y: 20, zoom: 1 })).toBe(false)
    expect(sameCamera({ x: 10, y: 20, zoom: 1.1 }, { x: 10, y: 20, zoom: 1 })).toBe(false)
  })

  it('a close while its own move is still animating goes back too (the animation is stopped)', () => {
    const f = fakeCanvas({ camera: FIT })
    installEditZoom(f.canvas, env())
    f.edit('n1')
    f.pan(80, 80) // mid-animation, not where it ends
    f.setMoving(true)
    f.edit(null)
    vi.advanceTimersByTime(RESTORE_DELAY_MS)
    expect(f.camera()).toEqual(FIT)
  })

  it('a second edit right after the first: no trip back in between, and the end goes back to before the first', () => {
    const second = { x: 300, y: 900, width: 200, height: 200 }
    const f = fakeCanvas({ camera: FIT, bounds: { n1: NOTE, n2: second } })
    installEditZoom(f.canvas, env())
    f.edit('n1')
    f.edit(null)
    f.edit('n2') // before the restore fired
    vi.advanceTimersByTime(RESTORE_DELAY_MS * 2)
    expect(f.sets).toHaveLength(2)
    expect(onScreen(second, f.camera()).cx).toBeCloseTo(PHONE.width / 2, 6)
    f.edit(null)
    vi.advanceTimersByTime(RESTORE_DELAY_MS)
    expect(f.camera()).toEqual(FIT)
  })

  it('never on a desktop (a fine pointer on a wide canvas), and not when the zoom is readable and the note high', () => {
    const desk = fakeCanvas({ camera: FIT, screen: { width: 1280, height: 800 } })
    installEditZoom(desk.canvas, env({ coarse: () => false }))
    desk.edit('n1')
    desk.edit(null)
    vi.advanceTimersByTime(RESTORE_DELAY_MS)
    expect(desk.sets).toEqual([])

    const high = fakeCanvas({ camera: { x: -80, y: -40, zoom: 1 } })
    installEditZoom(high.canvas, env())
    high.edit('n1')
    high.edit(null)
    vi.advanceTimersByTime(RESTORE_DELAY_MS)
    expect(high.sets).toEqual([])
  })

  it('animates unless the person asks for less motion', () => {
    const f = fakeCanvas({ camera: FIT })
    installEditZoom(f.canvas, env({ animate: () => true }))
    f.edit('n1')
    expect(f.sets[0]?.animate).toBe(true)
    const g = fakeCanvas({ camera: FIT })
    installEditZoom(g.canvas, env({ animate: () => false }))
    g.edit('n1')
    expect(g.sets[0]?.animate).toBe(false)
  })

  it('an element without bounds (deleted meanwhile) moves nothing', () => {
    const f = fakeCanvas({ camera: FIT })
    installEditZoom(f.canvas, env())
    f.edit('gone')
    expect(f.sets).toEqual([])
  })

  it('the uninstaller stops listening and cancels a pending return', () => {
    const f = fakeCanvas({ camera: FIT })
    const off = installEditZoom(f.canvas, env())
    f.edit('n1')
    f.edit(null)
    off()
    vi.advanceTimersByTime(RESTORE_DELAY_MS * 2)
    expect(f.sets).toHaveLength(1)
    expect(f.listeners()).toBe(0)
  })
})
