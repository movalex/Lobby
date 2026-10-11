// N1-4 (wave N): the board page's frames for a chunked cold open, and the elements in view that go first.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { arrow, note, rect } from '../testing/elements.ts'
import { animationFrames, idsInView } from './chunk-frames.ts'

describe('idsInView', () => {
  it('takes the live elements whose box meets the view (a line by its points), never a tombstone', () => {
    const els = [
      rect('in', 'a0', { x: 10, y: 10 }),
      rect('edge', 'a1', { x: 195, y: 195, width: 50, height: 50 }),
      rect('out', 'a2', { x: 500, y: 500 }),
      note('gone', 'a3', { x: 0, y: 0, isDeleted: true }),
      arrow('reach', 'a4', {
        x: -300,
        y: 20,
        width: 320,
        points: [
          [0, 0],
          [320, 0],
        ],
      }),
      arrow('back', 'a5', {
        x: 400,
        y: 50,
        width: 300,
        points: [
          [0, 0],
          [-300, 0],
        ],
      }),
    ]
    expect([...idsInView(els, { x: 0, y: 0, width: 200, height: 200 })].sort()).toEqual([
      'back',
      'edge',
      'in',
      'reach',
    ])
  })
})

describe('animationFrames', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('runs each chunk once, at the next animation frame or after 100 ms in a tab that does not paint; cancel stops it', () => {
    vi.useFakeTimers()
    const frames: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const s = animationFrames(() => new Set())
    expect(s.threshold).toBe(2_000)
    expect(s.size).toBe(1_000)
    let ran = 0
    s.frame(() => ran++)
    frames.shift()?.()
    vi.advanceTimersByTime(200)
    expect(ran).toBe(1)
    // a hidden tab: no frame comes, the timer does
    s.frame(() => ran++)
    vi.advanceTimersByTime(100)
    expect(ran).toBe(2)
    for (const f of frames.splice(0)) f()
    expect(ran).toBe(2)
    const h = s.frame(() => ran++)
    s.cancel(h)
    for (const f of frames.splice(0)) f()
    vi.advanceTimersByTime(200)
    expect(ran).toBe(2)
  })
})
