// Reactions (FAC-08): relayed to the board as events, never stored. The only state is two
// sliding-window rate limits kept in memory: per person (REACTION_RATE_MAX per
// REACTION_RATE_WINDOW_MS, across boards) and per board (REACTIONS_PER_BOARD_MAX per window, so a
// large room's applause cannot flood every open stream).

/** Relayed reactions per board per REACTION_RATE_WINDOW_MS, whoever sends them (then 429). */
export const REACTIONS_PER_BOARD_MAX = 100

/**
 * At most `max` takes per key within any `windowMs` (a sliding window over the last `max` accepted
 * timestamps). Refused takes do not count. Bounded: past `maxKeys` keys the oldest-inserted is
 * forgotten (which can only let that key through early, never block anyone).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private readonly maxKeys: number

  constructor(max: number, windowMs: number, maxKeys = 10_000) {
    this.max = max
    this.windowMs = windowMs
    this.maxKeys = maxKeys
  }

  /** Records a take at `atMs` if the key is under its limit; returns whether it was allowed. */
  take(key: string, atMs: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => atMs - t < this.windowMs)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(atMs)
    // Re-insert so the Map's order is least-recently-used first.
    this.hits.delete(key)
    this.hits.set(key, list)
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value
      if (oldest === undefined) break
      this.hits.delete(oldest)
    }
    return true
  }

  /** How long until `key` may take again (0 = now). */
  retryAfterMs(key: string, atMs: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => atMs - t < this.windowMs)
    if (list.length < this.max) return 0
    const first = list[0] ?? atMs
    return Math.max(0, first + this.windowMs - atMs)
  }
}
