// PRESENT-LIVE late joiner (the 1-in-5 flake of present-live.spec.ts "late joiner and reloads"): the board's first
// view and a live presentation both place the camera in the first moments after a board opens. A follower who
// reloads (or a late joiner who presses Join at once) is following within milliseconds of the first view, and the
// first view's hold, which re-applies the first frame on every canvas resize "until the person moves the camera",
// took the follower's slide camera for its own and put the first frame back over the presenter's slide ("dave
// stays on the first frame"). Presenting runs in focus mode, which also resizes the canvas (the dock and top bar
// go): the first view now stands down for as long as a presentation owns the camera, in either order.
//
// Deterministic: the whole timeline of the flake is replayed with fake timers and a canvas that logs its camera.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../../canvas/api/index.ts'
import { applyStartView } from './start-view.ts'

const BOARD = 'b-3k9x0q2m7a'
const USER = 'usr_dave'

/** The address bar and both storages, as the start view reads them (an ordinary visit to the board). */
function fakePage() {
  const store = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    }
  }
  const href = `http://lobby.test/b/${BOARD}`
  vi.stubGlobal('window', {
    location: { href },
    history: { state: null, replaceState: () => {} },
  })
  vi.stubGlobal('sessionStorage', store())
  vi.stubGlobal('localStorage', store())
  // animation frames by hand: the order of a frame and the events around it is the whole point of the flake
  const queue = new Map<number, () => void>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    queue.set(++next, fn)
    return next
  })
  vi.stubGlobal('cancelAnimationFrame', (h: number) => void queue.delete(h))
  return {
    /** The next animation frame: what was waiting for it runs. */
    frame() {
      const due = [...queue.values()]
      queue.clear()
      for (const fn of due) fn()
    },
  }
}

interface Camera {
  x: number
  y: number
  zoom: number
}

/**
 * A board of three wide frames on a 1000 x 600 canvas: too big to read whole, so the first view is the first
 * frame. It logs every camera it is given; `focusMode` and a `resize` are what a presentation causes.
 */
function fakeBoard() {
  const frames = [
    { id: 'f1', name: 'Welcome', x: 0, y: 0, width: 800, height: 450 },
    { id: 'f2', name: 'Roadmap', x: 1200, y: 0, width: 800, height: 450 },
    { id: 'f3', name: 'Next steps', x: 2400, y: 600, width: 640, height: 480 },
  ].map((f) => ({ ...f, type: 'frame', angle: 0, isDeleted: false, locked: false }))
  let camera: Camera = { x: 0, y: 0, zoom: 1 }
  /** the camera the engine has rendered: a camera just set is read back only after its next frame */
  let rendered: Camera = camera
  let lag = false
  let focusMode = false
  const log: Camera[] = []
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>()
  const place = (c: Camera) => {
    camera = c
    log.push(c)
  }
  const canvas = {
    items: () => frames,
    get: (id: string) => frames.find((f) => f.id === id) ?? null,
    bounds: (id: string) => {
      const f = frames.find((x) => x.id === id)
      return f ? { x: f.x, y: f.y, width: f.width, height: f.height } : null
    },
    boundsOf: () => null,
    isHidden: () => false,
    readOnly: () => false,
    selection: [] as string[],
    select: () => {},
    on: (name: string, fn: (...a: unknown[]) => void) => {
      const set = listeners.get(name) ?? new Set<(...a: unknown[]) => void>()
      listeners.set(name, set)
      set.add(fn)
      return () => void set.delete(fn)
    },
    doc: { get: () => null },
    settings: { get: () => ({ grid: false, snap: false, focusMode }) },
    viewport: {
      get: () => {
        const c = lag ? rendered : camera
        return { x: c.x, y: c.y, width: 1000 / c.zoom, height: 600 / c.zoom, zoom: c.zoom }
      },
      set: (v: Partial<Camera>) => place({ ...camera, ...v }),
      // the fit or frame zoom of the first view: wherever it is, it is "the first view's camera"
      zoomTo: (b: { x: number; y: number }) => place({ x: b.x - 100, y: b.y - 75, zoom: 1 }),
      limits: () => ({ min: 0.1, max: 30 }),
    },
  }
  return {
    canvas: canvas as unknown as LobbyCanvas,
    log,
    camera: () => camera,
    /** From now on `viewport.get()` is one frame behind `viewport.set`, until `render()`. */
    lagBehind() {
      lag = true
    },
    render() {
      rendered = camera
    },
    /** What present mode does at its start: focus mode, then the slide's camera (PresentOverlay's layout effect). */
    present(slide: Camera) {
      focusMode = true
      place(slide)
    },
    /** The board page's dock and top bar go in focus mode: the canvas changes size. */
    resize() {
      for (const l of [...(listeners.get('resize') ?? [])]) l({ x: 0, y: 0, width: 1280, height: 672 })
    },
  }
}

const ctx = (canvas: LobbyCanvas) => ({ canvas }) as unknown as CanvasFeatureContext
const opts = (holds: (() => void)[]) => ({
  boardId: BOARD,
  userId: USER,
  canEdit: true,
  hold: (d: () => void) => void holds.push(d),
})

const SLIDE_TWO: Camera = { x: 1200, y: 0, zoom: 1.6 }

describe('the first view and a presentation that starts at once', () => {
  let page: ReturnType<typeof fakePage>
  beforeEach(() => {
    vi.useFakeTimers()
    page = fakePage()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('without a presentation, the first view shows the first frame and the hold keeps it through a resize', async () => {
    const b = fakeBoard()
    const holds: (() => void)[] = []
    const done = applyStartView(ctx(b.canvas), opts(holds))
    await vi.advanceTimersByTimeAsync(200)
    expect(await done).toBe('first-frame')
    const first = b.camera()
    // K2-7: the first frame centred in the free canvas under its name (placement.ts startViewCamera: 32 px of
    // room, the frame name's 26 px above it), at 100 %
    expect(first).toEqual({ x: -100, y: -88, zoom: 1 })
    page.frame()
    // the dock rail appears and the canvas resizes: the first view is put back, once per resize
    const before = b.log.length
    b.resize()
    expect(b.log.length).toBe(before + 1)
    expect(b.camera()).toEqual(first)
    for (const d of holds) d()
  })

  it('a follower who starts right after the first view keeps the presenter’s slide through the resize its focus mode causes', async () => {
    const b = fakeBoard()
    const holds: (() => void)[] = []
    const done = applyStartView(ctx(b.canvas), opts(holds))
    // the board settles (150 ms without a change) and the first view is placed; its hold has not read the
    // camera yet (it does at the next frame)
    await vi.advanceTimersByTimeAsync(200)
    expect(await done).toBe('first-frame')
    // the live presentation arrives in that frame (the flake's timeline: the first view at 649 ms, the
    // presenter's slide at 663 ms, the hold applying the first frame again at 671 ms)
    b.present(SLIDE_TWO)
    page.frame()
    b.resize()
    page.frame()
    b.resize()
    expect(b.camera()).toEqual(SLIDE_TWO)
    for (const d of holds) d()
  })

  it('a presentation that is on before the first view is decided keeps its camera: the first view is "kept"', async () => {
    const b = fakeBoard()
    const holds: (() => void)[] = []
    // the engine reads a camera a frame late, so the camera the first view reads can still be the one from before
    b.lagBehind()
    const done = applyStartView(ctx(b.canvas), opts(holds))
    // the presentation starts while the board is still filling in
    b.present(SLIDE_TWO)
    b.log.length = 0
    await vi.advanceTimersByTimeAsync(200)
    expect(await done).toBe('kept')
    expect(b.log).toEqual([])
    expect(holds).toEqual([])
  })
})
