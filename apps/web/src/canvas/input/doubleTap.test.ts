import { describe, expect, it } from 'vitest'
import { DOUBLE_TAP_POSITION_THRESHOLD, DoubleTapMirror, TAP_TWICE_TIMEOUT } from './doubleTap.ts'

const one = (time: number, x: number, y: number) => ({ time, touches: [{ clientX: x, clientY: y }] })
const two = (time: number) => ({
  time,
  touches: [
    { clientX: 10, clientY: 10 },
    { clientX: 200, clientY: 200 },
  ],
})

describe('DoubleTapMirror (mirrors App.onTouchStart, index.js:43477-43517)', () => {
  it("uses Excalidraw's thresholds", () => {
    expect(TAP_TWICE_TIMEOUT).toBe(300)
    expect(DOUBLE_TAP_POSITION_THRESHOLD).toBe(35)
  })

  it('reports the second one-finger tap within 300 ms and 35 px', () => {
    const m = new DoubleTapMirror()
    expect(m.onTouchStart(one(0, 100, 100)).kind).toBe('pass')
    expect(m.onTouchStart(one(200, 120, 110))).toEqual({ kind: 'double', clientX: 120, clientY: 110 })
  })

  it('passes a second tap after the timeout (Excalidraw reset its state) and starts a new pair', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(one(300, 100, 100)).kind).toBe('pass')
    expect(m.onTouchStart(one(450, 101, 101)).kind).toBe('double')
  })

  it('passes a far second tap and ends the pair (didTapTwice = false)', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(one(100, 100 + 36, 100)).kind).toBe('pass')
    // Excalidraw: that tap ended the pair, so the next one is a FIRST tap again.
    expect(m.onTouchStart(one(150, 136, 100)).kind).toBe('pass')
    expect(m.onTouchStart(one(200, 136, 100)).kind).toBe('double')
  })

  it('lets pinch and pan (two fingers) through without ending the pair', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(two(50)).kind).toBe('pass')
    expect(m.onTouchStart(one(100, 100, 100)).kind).toBe('double')
  })

  it('after a swallowed double, a third quick tap near the first pairs again (Excalidraw state did not advance)', () => {
    const m = new DoubleTapMirror()
    m.onTouchStart(one(0, 100, 100))
    expect(m.onTouchStart(one(100, 100, 100)).kind).toBe('double')
    expect(m.onTouchStart(one(200, 100, 100)).kind).toBe('double')
    expect(m.onTouchStart(one(301, 100, 100)).kind).toBe('pass')
  })

  it('a two-finger first touch records no position, so a following tap cannot pair', () => {
    const m = new DoubleTapMirror()
    expect(m.onTouchStart(two(0)).kind).toBe('pass')
    expect(m.onTouchStart(one(50, 10, 10)).kind).toBe('pass')
  })
})
