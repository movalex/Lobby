// OWNER: W5 (wave M, S3 / M5-5). Privacy-safe usage counters.
//
// countUsage(event) counts one use of a feature, by a fixed event name (@draftroom/contracts usage.ts
// USAGE_EVENTS: the type allows nothing else, and scripts/usage-events.test.ts checks every call site's literal).
// No id, text or time is ever counted, only the event's name.
//
// The transport (started by the first count, once per tab):
//   - every USAGE_FLUSH_MS while the tab is visible, the counts so far go to POST /api/usage (same origin, JSON,
//     the session cookie) and start again. Nothing is sent while the tab is hidden, except:
//   - on pagehide (the tab closing, navigating away, going into the back/forward cache), what is left goes in a
//     request that outlives the page: sendBeacon with a JSON body, or a keepalive fetch where the beacon is
//     refused. Same origin, so the CSP's connect-src 'self' covers it.
//   - a 404 (an api from before wave M) turns the transport off for the tab: later batches are dropped silently.
//     A 429 (another tab of the same session sent one this minute), a server error or no answer puts the counts
//     back for the next flush (still capped). Any other refusal drops the batch.
// It never throws: a counter must not break the feature it counts.

import {
  isUsageEvent,
  USAGE_BATCH_MAX_KEYS,
  USAGE_COUNT_CAP,
  USAGE_FLUSH_MS,
  USAGE_ROUTE,
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
    add(event, 1)
    ensureTransport()
  } catch {
    // never let counting break a feature
  }
}

function add(event: UsageEvent, n: number): void {
  const had = counts.get(event)
  if (had === undefined) {
    if (counts.size >= USAGE_BATCH_MAX_KEYS) return
    counts.set(event, Math.min(USAGE_COUNT_CAP, n))
  } else counts.set(event, Math.min(USAGE_COUNT_CAP, had + n))
}

/** What has been counted since the last batch was taken (tests, and the transport). */
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

/** A batch that could not be delivered goes back (added to what was counted since, capped as always). */
function putBack(batch: UsageBatch): void {
  for (const [event, n] of Object.entries(batch.events)) if (isUsageEvent(event)) add(event, n)
}

// ---- the transport (M5-5) --------------------------------------------------------------------------------------

export interface UsageTransportDeps {
  fetch: typeof fetch
  doc: Pick<Document, 'visibilityState'>
  /** where 'pagehide' is heard (the window) */
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>
  /** navigator.sendBeacon, bound (absent: the keepalive fetch only) */
  beacon?: (url: string, data: Blob) => boolean
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  intervalMs?: number
}

interface Transport {
  stop(): void
  /** the periodic flush (tests): sends only while the tab is visible */
  tick(): Promise<void>
}

let transport: Transport | null = null
/** An api without the route (404): nothing more is sent from this tab. */
let off = false

const jsonHeaders = { 'content-type': 'application/json', accept: 'application/json' }

/**
 * Starts the transport with these deps (tests; the page's own starts with the first count). Replaces one already
 * running. Returns the stop.
 */
export function startUsageTransport(deps: UsageTransportDeps): () => void {
  transport?.stop()
  const setIv = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearIv = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  let inflight = false

  const tick = async () => {
    if (inflight || deps.doc.visibilityState !== 'visible') return
    const batch = takeUsageBatch()
    if (!batch) return
    if (off) return // dropped: the api has no such route
    inflight = true
    try {
      const res = await deps.fetch(USAGE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: jsonHeaders,
        body: JSON.stringify(batch),
      })
      if (res.status === 404) off = true
      else if (res.status === 429 || res.status >= 500) putBack(batch)
    } catch {
      putBack(batch) // no answer: next time
    } finally {
      inflight = false
    }
  }

  const onPageHide = () => {
    try {
      const batch = takeUsageBatch()
      if (!batch || off) return
      const body = JSON.stringify(batch)
      let sent = false
      try {
        sent = deps.beacon?.(USAGE_ROUTE, new Blob([body], { type: 'application/json' })) === true
      } catch {
        sent = false // a browser that refuses a JSON beacon: the keepalive fetch below
      }
      if (sent) return
      void deps
        .fetch(USAGE_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: jsonHeaders,
          body,
          keepalive: true,
        })
        .catch(() => {})
    } catch {
      // never
    }
  }

  const handle = setIv(() => void tick(), deps.intervalMs ?? USAGE_FLUSH_MS)
  deps.win.addEventListener('pagehide', onPageHide)
  const t: Transport = {
    tick,
    stop() {
      clearIv(handle)
      deps.win.removeEventListener('pagehide', onPageHide)
      if (transport === t) transport = null
    },
  }
  transport = t
  return () => t.stop()
}

/** The page's own transport, on the first count (nothing in a test or worker without a window). */
function ensureTransport(): void {
  if (transport) return
  const g = globalThis as {
    window?: Window
    document?: Document
    navigator?: Navigator
    fetch?: typeof fetch
  }
  if (!g.window || !g.document || typeof g.fetch !== 'function') return
  const nav = g.navigator
  startUsageTransport({
    fetch: (...a) => (g.fetch as typeof fetch)(...a),
    doc: g.document,
    win: g.window,
    ...(nav && typeof nav.sendBeacon === 'function' ? { beacon: (u, d) => nav.sendBeacon(u, d) } : {}),
  })
}

/** Tests only: the counts, the transport and the 404 latch. */
export function resetUsageForTests(): void {
  counts.clear()
  transport?.stop()
  transport = null
  off = false
}
