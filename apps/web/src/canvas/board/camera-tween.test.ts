// CR 3b-9 (wave 5, 2C): Lobby's camera tween lets the engine reuse its element bitmaps while the zoom
// moves, and draws them sharp at the end. W5-21: no move animates under `prefers-reduced-motion: reduce`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAMERA_ANIMATION_MS, type Viewport } from '../api/lobby-canvas.ts'

let frames: (() => void)[] = []
let now = 0
beforeEach(() => {
  frames = []
  now = 0
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => {
    frames.push(f)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
  vi.stubGlobal('performance', { now: () => now })
})
afterEach(() => vi.unstubAllGlobals())

const { CameraTween, durationOf } = await import('./handles.ts')

function run(ms: number) {
  while (frames.length) {
    now += 16
    const f = frames.shift() as () => void
    f()
    if (now > ms + 100) break
  }
}

describe('CameraTween and shouldCacheIgnoreZoom (CR 3b-9)', () => {
  it('a zooming tween turns the zoom cache on for its frames and off on the last one', () => {
    let v: Viewport = { x: 0, y: 0, width: 1000, height: 800, zoom: 1 }
    const cache: boolean[] = []
    const t = new CameraTween(
      (p) => {
        v = { ...v, ...p }
      },
      () => v,
      (on) => cache.push(on),
    )
    t.run({ x: 0, y: 0, zoom: 0.5 }, 200)
    expect(cache).toEqual([true])
    run(200)
    expect(cache).toEqual([true, false])
    expect(v.zoom).toBeCloseTo(0.5)
  })

  it('a pan (same zoom) leaves the cache alone; a stopped zoom turns it off', () => {
    let v: Viewport = { x: 0, y: 0, width: 1000, height: 800, zoom: 1 }
    const cache: boolean[] = []
    const t = new CameraTween(
      (p) => {
        v = { ...v, ...p }
      },
      () => v,
      (on) => cache.push(on),
    )
    t.run({ x: 300, y: 0, zoom: 1 }, 200)
    run(200)
    expect(cache).toEqual([])
    t.run({ x: 0, y: 0, zoom: 2 }, 200)
    t.stop()
    expect(cache).toEqual([true, false])
  })
})

/** A `matchMedia` that answers the reduced-motion query with `reduce` and every other query with false. */
const stubMatchMedia = (reduce: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
    })),
  )

describe('durationOf and prefers-reduced-motion (W5-21)', () => {
  it('animates as asked where there is no media query (Node) or the person did not ask for less motion', () => {
    expect(durationOf({ animate: true })).toBe(CAMERA_ANIMATION_MS)
    expect(durationOf({ animate: { durationMs: 200 } })).toBe(200)
    stubMatchMedia(false)
    expect(durationOf({ animate: true })).toBe(CAMERA_ANIMATION_MS)
    expect(durationOf({ animate: { durationMs: 200 } })).toBe(200)
  })

  it('is immediate (null) for every move when reduced motion is on, whoever asked for the animation', () => {
    stubMatchMedia(true)
    expect(durationOf({ animate: true })).toBeNull()
    expect(durationOf({ animate: { durationMs: 480 } })).toBeNull()
    expect(durationOf({ animate: true, force: true })).toBeNull()
  })

  it('stays immediate for moves that never animated', () => {
    expect(durationOf(undefined)).toBeNull()
    expect(durationOf({})).toBeNull()
    expect(durationOf({ animate: false })).toBeNull()
    stubMatchMedia(true)
    expect(durationOf({ animate: false })).toBeNull()
  })

  it('reads the preference at the time of the move, not once', () => {
    stubMatchMedia(true)
    expect(durationOf({ animate: true })).toBeNull()
    stubMatchMedia(false)
    expect(durationOf({ animate: true })).toBe(CAMERA_ANIMATION_MS)
  })
})
