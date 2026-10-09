// L6-1 (wave L): the presence pointer listener (./pointer.ts) hands over, with each sample taken while the
// button is down, the points the pointer passed since the previous sample (each move's coalesced points too):
// the shared laser's trail between two 20 Hz messages. Nothing is kept while the button is up, and a sample's
// own point is not repeated in its trail.
import { describe, expect, it } from 'vitest'
import { attachPresencePointer, MAX_BETWEEN_SAMPLES, type PresenceSample } from './pointer.ts'

type Handler = (e: unknown) => void

function fakeWrapper() {
  const handlers = new Map<string, Handler>()
  const wrapper = {
    firstElementChild: null,
    addEventListener: (type: string, h: Handler) => handlers.set(type, h),
    removeEventListener: (type: string) => handlers.delete(type),
  }
  const fire = (type: string, x: number, coalesced?: number[]) =>
    handlers.get(type)?.({
      isPrimary: true,
      pointerType: 'mouse',
      clientX: x,
      clientY: 0,
      target: wrapper,
      ...(coalesced
        ? { getCoalescedEvents: () => coalesced.map((cx) => ({ clientX: cx, clientY: 0 })) }
        : {}),
    })
  return { wrapper: wrapper as unknown as HTMLElement, fire, handlers }
}

function attach() {
  let t = 0
  const samples: PresenceSample[] = []
  const w = fakeWrapper()
  const off = attachPresencePointer(w.wrapper, {
    toScene: (x, y) => ({ x: x / 2, y }),
    onSample: (s) => samples.push(s),
    now: () => t,
  })
  return { ...w, samples, off, at: (ms: number) => (t = ms) }
}

describe('the presence pointer’s in-between points (the laser trail)', () => {
  it('while the button is down, the moves between two samples ride with the next one, without its own point', async () => {
    const p = attach()
    p.at(0)
    p.fire('pointerdown', 0)
    // within the 50 ms throttle: kept, not sent
    p.at(10)
    p.fire('pointermove', 20, [10, 20])
    p.at(20)
    p.fire('pointermove', 40, [30, 40])
    p.at(60)
    p.fire('pointermove', 60, [50, 60]) // past the throttle: sent now
    const last = p.samples.at(-1)
    expect(last?.source).toBe('pointermove')
    expect(last?.pointer).toEqual({ x: 30, y: 0 })
    expect(last?.trail?.map((q) => q.x)).toEqual([5, 10, 15, 20, 25])
    p.off()
  })

  it('nothing is kept while the button is up; the down sample starts afresh', () => {
    const p = attach()
    p.at(0)
    p.fire('pointermove', 0)
    p.at(10)
    p.fire('pointermove', 10, [5, 10])
    p.at(100)
    p.fire('pointermove', 20, [15, 20])
    expect(p.samples.every((s) => !s.trail)).toBe(true)
    p.at(200)
    p.fire('pointerdown', 30)
    expect(p.samples.at(-1)).toMatchObject({ source: 'pointerdown', button: 'down' })
    expect(p.samples.at(-1)?.trail).toBeUndefined()
    p.off()
  })

  it('a long burst is thinned to the cap, the first and last points kept', () => {
    const p = attach()
    p.at(0)
    p.fire('pointerdown', 0)
    p.at(1)
    const many = Array.from({ length: 100 }, (_, i) => i * 2)
    p.fire('pointermove', 198, many)
    p.at(100)
    p.fire('pointermove', 400, [400])
    const trail = p.samples.at(-1)?.trail ?? []
    expect(trail.length).toBeLessThanOrEqual(MAX_BETWEEN_SAMPLES)
    expect(trail[0]).toEqual({ x: 0, y: 0 })
    // the newest points survive the thinning (the path's end is where the pointer went)
    expect(trail.at(-1)?.x).toBeGreaterThanOrEqual(95)
    const xs = trail.map((q) => q.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    p.off()
  })
})
