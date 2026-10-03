// CR 3b-10 (W5-19): the board input layer's two-finger touch pinch tracker (pure: the DOM wiring is
// BoardInput's, driven by e2e/excalidraw/input-touch-wheel.spec.ts).
import { describe, expect, it } from 'vitest'
import { TouchPinchTracker } from './input.ts'

describe('TouchPinchTracker', () => {
  it('one finger is no pinch', () => {
    const t = new TouchPinchTracker()
    expect(t.down(1, 100, 100)).toBeNull()
    expect(t.move(1, 120, 100)).toBeNull()
    expect(t.up(1)).toBeNull()
    expect(t.active).toBe(false)
  })

  it('the second finger starts it at scale 1 with the middle of the two; moves give the spread and the middle', () => {
    const t = new TouchPinchTracker()
    t.down(1, 100, 100)
    expect(t.down(2, 200, 100)).toEqual({
      phase: 'start',
      scale: 1,
      centre: { x: 150, y: 100 },
      start: { x: 150, y: 100 },
    })
    expect(t.active).toBe(true)
    // the fingers spread to twice the distance: the second moves out
    expect(t.move(2, 300, 100)).toEqual({
      phase: 'move',
      scale: 2,
      centre: { x: 200, y: 100 },
      start: { x: 150, y: 100 },
    })
    // both close to a quarter of the start distance, the middle moved down
    t.move(1, 140, 160)
    const s = t.move(2, 165, 160)
    expect(s?.scale).toBeCloseTo(0.25)
    expect(s?.centre).toEqual({ x: 152.5, y: 160 })
    expect(s?.start).toEqual({ x: 150, y: 100 })
  })

  it('a finger lifting ends it; the one left is no pinch', () => {
    const t = new TouchPinchTracker()
    t.down(1, 0, 0)
    t.down(2, 100, 0)
    expect(t.up(2)?.phase).toBe('end')
    expect(t.active).toBe(false)
    expect(t.move(1, 10, 10)).toBeNull()
    expect(t.up(1)).toBeNull()
  })

  it('a third finger ends it for good, as in the engine: two again after it is not a new pinch', () => {
    const t = new TouchPinchTracker()
    t.down(1, 0, 0)
    t.down(2, 100, 0)
    expect(t.down(3, 50, 80)?.phase).toBe('end')
    expect(t.move(1, 5, 5)).toBeNull()
    expect(t.up(3)).toBeNull()
    expect(t.active).toBe(false)
    expect(t.move(2, 120, 0)).toBeNull()
    // lifting both and touching twice again starts a new one
    t.up(1)
    t.up(2)
    t.down(4, 0, 0)
    expect(t.down(5, 40, 0)?.phase).toBe('start')
  })

  it('a finger it never saw moving or lifting changes nothing', () => {
    const t = new TouchPinchTracker()
    t.down(1, 0, 0)
    t.down(2, 100, 0)
    expect(t.move(9, 1, 1)).toBeNull()
    expect(t.up(9)).toBeNull()
    expect(t.active).toBe(true)
  })

  it('two fingers on one spot never divide by nothing', () => {
    const t = new TouchPinchTracker()
    t.down(1, 50, 50)
    expect(t.down(2, 50, 50)?.scale).toBe(1)
    const s = t.move(2, 60, 50)
    expect(Number.isFinite(s?.scale)).toBe(true)
  })

  it('reset (the window lost focus) ends an active pinch once and forgets the fingers', () => {
    const t = new TouchPinchTracker()
    expect(t.reset()).toBeNull()
    t.down(1, 0, 0)
    t.down(2, 100, 0)
    expect(t.reset()?.phase).toBe('end')
    expect(t.reset()).toBeNull()
    // the old fingers lifting later is nothing, and two new ones pinch
    expect(t.up(1)).toBeNull()
    t.down(3, 0, 0)
    expect(t.down(4, 10, 0)?.phase).toBe('start')
  })
})
