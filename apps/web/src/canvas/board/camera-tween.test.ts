// CR 3b-9 (wave 5, 2C): Lobby's camera tween lets the engine reuse its element bitmaps while the zoom
// moves, and draws them sharp at the end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Viewport } from '../api/lobby-canvas.ts'

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

const { CameraTween } = await import('./handles.ts')

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
