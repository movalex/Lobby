// L6-2 (wave L): the long press of the compass chips (./long-press.ts), on a fake timer.
import { describe, expect, it } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, LongPress } from './long-press.ts'

function fakeTimers() {
  const pending = new Map<number, () => void>()
  let seq = 0
  return {
    timers: {
      set: (fn: () => void) => {
        pending.set(++seq, fn)
        return seq
      },
      clear: (h: unknown) => void pending.delete(h as number),
    },
    fireAll: () => {
      for (const [k, fn] of [...pending]) {
        pending.delete(k)
        fn()
      }
    },
    pending: () => pending.size,
  }
}

describe('LongPress', () => {
  it('a press held past the time fires once for its key, and the click after it is swallowed', () => {
    const t = fakeTimers()
    const fired: string[] = []
    const lp = new LongPress<string>((k) => fired.push(k), LONG_PRESS_MS, t.timers)
    lp.down('bob', 10, 10)
    t.fireAll()
    expect(fired).toEqual(['bob'])
    lp.up()
    expect(lp.takeClick()).toBe(true)
    expect(lp.takeClick()).toBe(false)
  })

  it('a short press is a click: nothing fires and the click goes through', () => {
    const t = fakeTimers()
    const fired: string[] = []
    const lp = new LongPress<string>((k) => fired.push(k), LONG_PRESS_MS, t.timers)
    lp.down('bob', 10, 10)
    lp.up()
    t.fireAll()
    expect(fired).toEqual([])
    expect(lp.takeClick()).toBe(false)
  })

  it('moving past the slop cancels it; a small wobble does not', () => {
    const t = fakeTimers()
    const fired: string[] = []
    const lp = new LongPress<string>((k) => fired.push(k), LONG_PRESS_MS, t.timers)
    lp.down('a', 0, 0)
    lp.move(LONG_PRESS_SLOP_PX - 2, 0)
    expect(t.pending()).toBe(1)
    lp.move(LONG_PRESS_SLOP_PX + 5, 0)
    expect(t.pending()).toBe(0)
    t.fireAll()
    expect(fired).toEqual([])
    // a new press starts over
    lp.down('b', 0, 0)
    t.fireAll()
    expect(fired).toEqual(['b'])
  })
})
