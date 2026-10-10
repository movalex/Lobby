// OWNER: W5 (wave M, S3 / M5-5; a stub landed by the wave M foundation). Privacy-safe usage counters.
//
// countUsage(event) counts one use of a feature, by a fixed event name (@draftroom/contracts usage.ts
// USAGE_EVENTS: the type allows nothing else, and scripts/usage-events.test.ts checks every call site's literal).
// No id, text or time is ever counted, only the event's name.
//
// The stub counts in memory and never sends. W5 adds the transport: a flush every USAGE_FLUSH_MS while the tab is
// visible and on pagehide (sendBeacon POST /api/usage, same origin), takeUsageBatch() for its body, dropped
// silently on a 404 (an api without the route). It never throws: a counter must not break the feature it counts.

import {
  isUsageEvent,
  USAGE_BATCH_MAX_KEYS,
  USAGE_COUNT_CAP,
  type UsageBatch,
  type UsageEvent,
} from '@draftroom/contracts'

const counts = new Map<UsageEvent, number>()

/**
 * Counts one use. Capped at USAGE_COUNT_CAP per event and USAGE_BATCH_MAX_KEYS events until the next batch is taken
 * (a further new event waits for the next batch: it is dropped, never queued without bound).
 */
export function countUsage(event: UsageEvent): void {
  try {
    if (!isUsageEvent(event)) return
    const n = counts.get(event)
    if (n === undefined) {
      if (counts.size >= USAGE_BATCH_MAX_KEYS) return
      counts.set(event, 1)
    } else if (n < USAGE_COUNT_CAP) counts.set(event, n + 1)
  } catch {
    // never let counting break a feature
  }
}

/** What has been counted since the last batch was taken (tests, and W5's transport). */
export function pendingUsage(): Readonly<Partial<Record<UsageEvent, number>>> {
  return Object.fromEntries(counts)
}

/** The counts so far as one POST /api/usage body, and a fresh start; null when nothing was counted. */
export function takeUsageBatch(): UsageBatch | null {
  if (counts.size === 0) return null
  const events = Object.fromEntries(counts) as UsageBatch['events']
  counts.clear()
  return { events }
}

/** Tests only. */
export function resetUsageForTests(): void {
  counts.clear()
}
