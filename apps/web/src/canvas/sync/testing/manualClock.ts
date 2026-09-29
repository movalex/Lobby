/**
 * A deterministic clock and timer queue for the engine core's tests and the protocol fake: `setTimer`,
 * `clearTimer` and `now` as `EngineCoreOptions` takes them, and `run` to advance virtual time.
 *
 * NODE-SAFE (CONTRACTS.md).
 */
export interface ManualClock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** runs every timer due within `ms` of now (0: only what is due now), in due order, then advances */
  advance(ms: number): void
  /** runs timers until none is left (or `limit` rounds), advancing time to each */
  runAll(limit?: number): void
  pending(): number
}

export function createManualClock(start = 1_700_000_000_000): ManualClock {
  let t = start
  let nextId = 1
  const timers = new Map<number, { due: number; fn: () => void; order: number }>()
  let order = 0
  const due = (until: number) => {
    let best: [number, { due: number; fn: () => void; order: number }] | null = null
    for (const e of timers)
      if (
        e[1].due <= until &&
        (!best || e[1].due < best[1].due || (e[1].due === best[1].due && e[1].order < best[1].order))
      )
        best = e
    return best
  }
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { due: t + Math.max(0, ms), fn, order: order++ })
      return id
    },
    clearTimer(handle) {
      timers.delete(handle as number)
    },
    advance(ms) {
      const until = t + ms
      for (;;) {
        const next = due(until)
        if (!next) break
        timers.delete(next[0])
        t = Math.max(t, next[1].due)
        next[1].fn()
      }
      t = until
    },
    runAll(limit = 100_000) {
      for (let i = 0; i < limit; i++) {
        const next = due(Number.POSITIVE_INFINITY)
        if (!next) return
        timers.delete(next[0])
        t = Math.max(t, next[1].due)
        next[1].fn()
      }
      throw new Error('manual clock: timers never settle')
    },
    pending: () => timers.size,
  }
}
