// The sync server's clock, as this api measures it (wave N.1, wave N follow-up 5: "one clock").
//
// The sync stamps every element it stores (`updated`, `customData.lobbyServer.createdAt`, a tombstone's `updated`),
// and "Since your last visit" (features/visits) compares those stamps with the person's visit time, which this api
// stores. Two machines' clocks differ, by milliseconds with NTP and by seconds when one drifts, so at the boundary an
// edit made just after someone left could read as seen, or one they saw as new. One clock decides both: the sync's,
// which stamps every element. The api asks for it (GET <sync>/internal/clock, the internal secret) and keeps the
// offset of its own clock to it, NTP-style: `offset = sync - (sent + received) / 2`, an error of at most half the
// round trip. A sample whose round trip is over SYNC_CLOCK.maxRttMs is not used, and of the last few the one with the
// shortest round trip is, among those that are still recent and agree with the newest (wave N.1 review: with no age
// bound, a short-round-trip sample from before a clock step kept the old offset for up to five intervals, 25 min). A
// sample older than SYNC_CLOCK.maxAgeIntervals intervals before the newest is dropped, and so is one whose error bound
// (half its round trip) does not overlap the newest's: one of the clocks moved since, so the newest's offset is
// followed at once. Asked every SYNC_CLOCK.retryMs until it is known (an older sync answers 404, an unreachable one
// nothing: the api's own clock is used meanwhile, as before), then every SYNC_CLOCK.intervalMs.
//
// Only the visit times use it. Logs carry the offset in ms, never an id or a visit time.

/** The measurement's settings (frozen: a test passes its own `schedule` instead). */
export const SYNC_CLOCK = Object.freeze({
  /** a sample whose round trip took longer than this is not used (its error is up to half of it) */
  maxRttMs: 1_000,
  /** once known, how often the offset is measured again */
  intervalMs: 5 * 60_000,
  /** until it is known (and after a failed measurement), how soon it is asked again */
  retryMs: 30_000,
  /** the samples kept; the one with the shortest round trip is used */
  keep: 5,
  /** a sample taken more than this many intervals before the newest is dropped */
  maxAgeIntervals: 2,
  /** an offset that moves by more than this between used samples is logged */
  logChangeMs: 1_000,
})

export interface SyncClock {
  /** The sync's time now as far as this api knows it: its own clock plus the offset (none while not known). */
  now(): Date
  /** The offset in use (sync minus api, ms), or null while it is not known. */
  offsetMs(): number | null
  /** Measures once now; resolves with the offset in use afterwards (null: still not known). Never rejects. */
  measure(): Promise<number | null>
  /** Starts the timer (measures at once, then on its own); idempotent. */
  start(): void
  stop(): void
}

interface Sample {
  readonly offset: number
  readonly rtt: number
  /** when it was taken (the api's clock, ms) */
  readonly at: number
}

/** What the readings' whole milliseconds add to two samples' error bounds (the sync's, and the api's two). */
const ROUNDING_MS = 2

/** Whether two samples' offsets agree within their error bounds (half of each round trip). */
const agree = (a: Sample, b: Sample) => Math.abs(a.offset - b.offset) <= (a.rtt + b.rtt) / 2 + ROUNDING_MS

export function createSyncClock(opts: {
  /** the sync's time (ms); absent: never known (the api's own clock) */
  read: (() => Promise<number>) | undefined
  now: () => Date
  log?: (message: string) => void
  /** the timer's delays (tests); default SYNC_CLOCK */
  schedule?: { intervalMs: number; retryMs: number }
}): SyncClock {
  const { read, now, log } = opts
  const intervalMs = opts.schedule?.intervalMs ?? SYNC_CLOCK.intervalMs
  const retryMs = opts.schedule?.retryMs ?? SYNC_CLOCK.retryMs
  const maxAgeMs = SYNC_CLOCK.maxAgeIntervals * intervalMs
  const samples: Sample[] = []
  let offset: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let running: Promise<number | null> | null = null

  const use = () => {
    const newest = samples.at(-1)
    if (!newest) return
    // the newest always counts; an older sample only while recent and agreeing with it (else a clock moved since)
    const kept = samples.filter((s) => s === newest || (newest.at - s.at <= maxAgeMs && agree(s, newest)))
    samples.splice(0, samples.length, ...kept)
    let best = newest
    for (const s of samples) if (s.rtt < best.rtt) best = s
    const next = Math.round(best.offset)
    if (offset === null) log?.(`[clock] the sync's clock is ${next >= 0 ? '+' : ''}${next} ms from the api's`)
    else if (Math.abs(next - offset) > SYNC_CLOCK.logChangeMs)
      log?.(`[clock] the sync's clock moved: now ${next >= 0 ? '+' : ''}${next} ms from the api's`)
    offset = next
  }

  const once = async (): Promise<number | null> => {
    if (!read) return offset
    const sent = now().getTime()
    let sync: number
    try {
      sync = await read()
    } catch {
      return offset // an older sync (404) or an unreachable one: the offset in use stays
    }
    const received = now().getTime()
    const rtt = received - sent
    if (!Number.isFinite(sync) || rtt < 0 || rtt > SYNC_CLOCK.maxRttMs) return offset
    samples.push({ offset: sync - (sent + received) / 2, rtt, at: received })
    while (samples.length > SYNC_CLOCK.keep) samples.shift()
    use()
    return offset
  }

  const measure = () => {
    running ??= once().finally(() => {
      running = null
    })
    return running
  }

  const loop = () => {
    timer = null
    void measure().then(() => {
      if (!started) return
      timer = setTimeout(loop, offset === null ? retryMs : intervalMs)
      timer.unref?.()
    })
  }

  return {
    now: () => (offset === null ? now() : new Date(now().getTime() + offset)),
    offsetMs: () => offset,
    measure,
    start() {
      if (started || !read) return
      started = true
      loop()
    },
    stop() {
      started = false
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
