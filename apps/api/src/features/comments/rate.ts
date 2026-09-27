// Per-user write budget for comment mutations (abuse guard; in-process, like the event hub).
// Keyed by the signed-in user rather than the client IP: every dev/e2e browser shares one proxy IP.

export interface WriteLimiter {
  /** Records one write; false when the user is over budget for the current window. */
  take(userId: string): boolean
}

export function createWriteLimiter(opts: { max: number; windowMs: number; now: () => Date }): WriteLimiter {
  const hits = new Map<string, number[]>()
  let sweeps = 0
  return {
    take(userId) {
      const now = opts.now().getTime()
      const since = now - opts.windowMs
      const recent = (hits.get(userId) ?? []).filter((t) => t > since)
      if (recent.length >= opts.max) {
        hits.set(userId, recent)
        return false
      }
      recent.push(now)
      hits.set(userId, recent)
      // Occasionally drop idle users so the map cannot grow without bound.
      if (++sweeps % 500 === 0) {
        for (const [id, list] of hits) if (!list.some((t) => t > since)) hits.delete(id)
      }
      return true
    },
  }
}
