// The scrubber's content cache and rest (wave L, L7-1; ./content-cache.ts): at most 8 contents in memory, one
// request per checkpoint however many ticks want it, and only the tick the scrubber rested on is asked for; the
// neighbour ahead after a longer rest, never after a 429, and a refreshed timeline never drops a waiting load.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContentCache,
  PREFETCH_IDLE_MS,
  SCRUB_CACHE_ENTRIES,
  SCRUB_DEBOUNCE_MS,
  ScrubLoader,
} from './content-cache.ts'

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

class RateLimited extends Error {}

/** A loader over ticks t0..t9 whose content route answers `{ id }`, or 429 for the ids in `refuse`. */
function world(opts: { refuse?: Set<string> } = {}) {
  const asked: string[] = []
  const shown: string[] = []
  const failed: string[] = []
  let ticks: readonly string[] = Array.from({ length: 10 }, (_, i) => `t${i}`)
  const cache = new ContentCache(async (id: string) => {
    asked.push(id)
    if (opts.refuse?.has(id)) throw new RateLimited(id)
    return { id }
  })
  const loader = new ScrubLoader({
    cache,
    ticks: () => ticks,
    onReady: (id) => shown.push(id),
    onError: (id) => failed.push(id),
    isRateLimited: (e) => e instanceof RateLimited,
  })
  return {
    asked,
    shown,
    failed,
    cache,
    loader,
    setTicks: (next: readonly string[]) => {
      ticks = next
    },
  }
}
/** Lets the content requests' promises settle (fake timers do not run them). */
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('ScrubLoader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks for the tick the scrubber rests on only; the first one at once; from memory with no request', async () => {
    const w = world()
    w.loader.show('t9', { now: true })
    await settle()
    expect(w.asked).toEqual(['t9'])
    expect(w.shown).toEqual(['t9'])
    // a quick scrub: nothing until the rest
    for (let i = 8; i >= 2; i--) {
      w.loader.show(`t${i}`, { direction: -1 })
      await vi.advanceTimersByTimeAsync(SCRUB_DEBOUNCE_MS - 10)
    }
    expect(w.asked).toEqual(['t9'])
    await vi.advanceTimersByTimeAsync(10)
    expect(w.asked).toEqual(['t9', 't2'])
    expect(w.shown).toEqual(['t9', 't2'])
    // back to one in memory: shown at once, no request
    w.loader.show('t9', { direction: 1 })
    expect(w.shown).toEqual(['t9', 't2', 't9'])
    expect(w.asked).toEqual(['t9', 't2'])
  })

  it('a refreshed timeline (a checkpoint saved meanwhile) never drops the load waiting for the rest', async () => {
    const w = world()
    w.loader.show('t9', { now: true })
    await settle()
    w.loader.show('t8', { direction: -1 })
    await vi.advanceTimersByTimeAsync(SCRUB_DEBOUNCE_MS / 2)
    // the panel refetched the list on a checkpoint event: one more tick at the end
    w.setTicks([...Array.from({ length: 10 }, (_, i) => `t${i}`), 't10'])
    await vi.advanceTimersByTimeAsync(SCRUB_DEBOUNCE_MS)
    expect(w.shown).toEqual(['t9', 't8'])
  })

  it('asks ahead only after the longer rest, the way the scrubber moves, once the tick shown is here', async () => {
    const w = world()
    w.loader.show('t5', { now: true })
    await settle()
    // resting longer than the debounce but shorter than the idle: nothing asked ahead
    w.loader.show('t4', { direction: -1 })
    await vi.advanceTimersByTimeAsync(SCRUB_DEBOUNCE_MS + 50)
    expect(w.asked).toEqual(['t5', 't4'])
    w.loader.show('t3', { direction: -1 })
    await vi.advanceTimersByTimeAsync(SCRUB_DEBOUNCE_MS + 50)
    expect(w.asked).toEqual(['t5', 't4', 't3'])
    // a longer rest: the next older one, once
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS)
    expect(w.asked).toEqual(['t5', 't4', 't3', 't2'])
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS * 3)
    expect(w.asked).toEqual(['t5', 't4', 't3', 't2'])
    // stepping onto it costs nothing; resting there asks for the next one
    w.loader.show('t2', { direction: -1 })
    expect(w.shown.at(-1)).toBe('t2')
    expect(w.asked).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS)
    expect(w.asked).toEqual(['t5', 't4', 't3', 't2', 't1'])
    // a slow walk through 30 rests spends one request per tick, never two
    const slow = world()
    slow.setTicks(Array.from({ length: 31 }, (_, i) => `s${i}`))
    slow.loader.show('s0', { now: true })
    await settle()
    for (let i = 1; i <= 30; i++) {
      slow.loader.show(`s${i}`, { direction: 1 })
      await vi.advanceTimersByTimeAsync(SCRUB_DEBOUNCE_MS + 100)
    }
    expect(slow.asked).toHaveLength(31)
  })

  it('after a 429 asks nothing ahead any more; the refused tick says so and is asked again on "Try again"', async () => {
    const refuse = new Set(['t3'])
    const w = world({ refuse })
    w.loader.show('t4', { now: true, direction: -1 })
    await settle()
    // the longer rest on t4 asks for t3 ahead: refused (429)
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS)
    expect(w.asked).toEqual(['t4', 't3'])
    expect(w.loader.aheadStopped).toBe(true)
    // the scrubber goes there: asked for (a failure is not kept), refused, shown as refused
    w.loader.show('t3', { direction: -1 })
    await vi.advanceTimersByTimeAsync(SCRUB_DEBOUNCE_MS)
    expect(w.failed).toEqual(['t3'])
    // nothing asked ahead after a 429, however long the rest
    w.loader.show('t6', { direction: 1, now: true })
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS * 5)
    expect(w.asked).toEqual(['t4', 't3', 't3', 't6'])
    // "Try again" once the minute passed
    refuse.clear()
    w.loader.show('t3', { now: true })
    await settle()
    expect(w.shown.at(-1)).toBe('t3')
  })

  it('stop: a load that lands after the dialog closed is not shown, and nothing more is asked for', async () => {
    const w = world()
    w.loader.show('t1', { now: true })
    w.loader.stop()
    await vi.advanceTimersByTimeAsync(PREFETCH_IDLE_MS * 2)
    expect(w.shown).toEqual([])
    expect(w.asked).toEqual(['t1'])
  })
})
