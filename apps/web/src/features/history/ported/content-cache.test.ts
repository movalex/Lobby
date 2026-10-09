// The scrubber's content cache and rest (wave L, L7-1; ./content-cache.ts): at most 8 contents in memory, one
// request per checkpoint however many ticks want it, and only the tick the scrubber rested on is asked for.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentCache, debounced, SCRUB_CACHE_ENTRIES, SCRUB_DEBOUNCE_MS } from './content-cache.ts'

describe('ContentCache', () => {
  it('keeps the 8 most recently used, asks once for what several want, forgets a failure', async () => {
    const asked: string[] = []
    let fail = false
    const cache = new ContentCache(async (id: string) => {
      asked.push(id)
      if (fail) throw new Error('nope')
      return { id }
    })
    const [a, b] = await Promise.all([cache.get('c0'), cache.get('c0')])
    expect(a).toBe(b)
    expect(asked).toEqual(['c0'])
    for (let i = 1; i <= SCRUB_CACHE_ENTRIES; i++) await cache.get(`c${i}`)
    expect(cache.size).toBe(SCRUB_CACHE_ENTRIES)
    expect(cache.has('c0')).toBe(false) // the oldest went
    cache.peek('c1') // used again: c2 is now the oldest
    await cache.get('c9')
    expect(cache.has('c1')).toBe(true)
    expect(cache.has('c2')).toBe(false)
    expect(cache.fetches).toBe(10)
    fail = true
    await expect(cache.get('bad')).rejects.toThrow('nope')
    fail = false
    await expect(cache.get('bad')).resolves.toEqual({ id: 'bad' })
  })
})

describe('debounced', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('runs once with the last value after the rest; flush runs now, cancel drops it', () => {
    const got: number[] = []
    const d = debounced((n: number) => got.push(n))
    for (let i = 0; i < 10; i++) {
      d.call(i)
      vi.advanceTimersByTime(SCRUB_DEBOUNCE_MS - 10)
    }
    expect(got).toEqual([])
    vi.advanceTimersByTime(10)
    expect(got).toEqual([9])
    d.call(42)
    d.flush()
    expect(got).toEqual([9, 42])
    d.call(7)
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(got).toEqual([9, 42])
  })
})
