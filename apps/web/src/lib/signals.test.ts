import { describe, expect, it, vi } from 'vitest'
import { atom, computed, react, source, subscribeValue, transact, untracked } from './signals.ts'

describe('signals', () => {
  it('atoms hold values and skip equal writes', () => {
    const a = atom('a', 1)
    const seen: number[] = []
    const stop = react('r', () => seen.push(a.get()))
    a.set(1)
    a.set(2)
    a.update((v) => v + 1)
    stop()
    a.set(9)
    expect(seen).toEqual([1, 2, 3])
  })

  it('computed values are cached and recompute only when a dependency changed', () => {
    const a = atom('a', 1)
    const b = atom('b', 10)
    const fn = vi.fn(() => a.get() * 2)
    const c = computed('c', fn)
    expect(c.get()).toBe(2)
    expect(c.get()).toBe(2)
    expect(fn).toHaveBeenCalledTimes(1)
    b.set(11)
    expect(c.get()).toBe(2)
    expect(fn).toHaveBeenCalledTimes(1)
    a.set(2)
    expect(c.get()).toBe(4)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('an unobserved computed returns the same reference until a dependency changes', () => {
    const a = atom('a', [1, 2, 3])
    const c = computed('c', () => a.get().filter((x) => x > 1))
    const first = c.get()
    expect(c.get()).toBe(first)
    a.set([4])
    expect(c.get()).toEqual([4])
  })

  it('effects run once per batch and not when a computed keeps its value', () => {
    const a = atom('a', 1)
    const b = atom('b', 1)
    const parity = computed('parity', () => a.get() % 2)
    const runs: string[] = []
    const stop = react('r', () => runs.push(`${parity.get()}/${b.get()}`))
    a.set(3) // parity unchanged: no run
    transact(() => {
      a.set(4)
      b.set(2)
    })
    stop()
    expect(runs).toEqual(['1/1', '0/2'])
  })

  it('an effect that writes settles, and a runaway loop is reported', () => {
    const a = atom('a', 0)
    const b = atom('b', 0)
    const stop = react('copy', () => b.set(a.get() + 1))
    a.set(5)
    expect(b.get()).toBe(6)
    stop()
    const c = atom('c', 0)
    expect(() => react('loop', () => c.set(c.get() + 1))).toThrow(/did not settle/)
  })

  it('sources make adapter reads reactive', () => {
    let external = 'x'
    const s = source('doc')
    const read = () => {
      s.track()
      return external
    }
    const seen: string[] = []
    const stop = react('r', () => seen.push(read()))
    external = 'y'
    s.bump()
    stop()
    expect(seen).toEqual(['x', 'y'])
  })

  it('untracked reads record nothing', () => {
    const a = atom('a', 1)
    const seen: number[] = []
    const stop = react('r', () => seen.push(untracked(() => a.get())))
    a.set(2)
    stop()
    expect(seen).toEqual([1])
  })

  it('subscribeValue reports changes after the first value, and stops', () => {
    const a = atom('a', 1)
    const c = computed('c', () => a.get() > 1)
    const onChange = vi.fn()
    const stop = subscribeValue(c, onChange)
    a.set(2)
    a.set(3) // still true: no call
    a.set(0)
    stop()
    a.set(5)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('a computed no one observes any more is released by its dependencies', () => {
    const a = atom('a', 1)
    const c = computed('c', () => a.get())
    const stop = subscribeValue(c, () => {})
    stop()
    // released: a write reaches no derivation (the internal observer set is empty)
    const observers = (a as unknown as { observers: Set<unknown> }).observers
    expect(observers.size).toBe(0)
    a.set(2)
    expect(c.get()).toBe(2)
  })
})
