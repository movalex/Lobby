// The sync server's clock, as this api measures it (wave N.1, wave N follow-up 5: "one clock").
//
// The sync stamps every element it stores (`updated`, `customData.lobbyServer.createdAt`, a tombstone's `updated`),
// and "Since your last visit" (features/visits) compares those stamps with the person's visit time, which this api
// stores. Two machines' clocks differ, by milliseconds with NTP and by seconds when one drifts, so at the boundary an
// edit made just after someone left could read as seen, or one they saw as new. One clock decides both: the sync's,
// which stamps every element. The api asks for it (GET <sync>/internal/clock, the internal secret) and keeps the
// offset of its own clock to it, NTP-style: `offset = sync - (sent + received) / 2`, an error of at most half the
// round trip. A sample whose round trip is over SYNC_CLOCK.maxRttMs is not used, and of the last few the one with the
// shortest round trip is. Asked every SYNC_CLOCK.retryMs until it is known (an older sync answers 404, an unreachable
// one nothing: the api's own clock is used meanwhile, as before), then every SYNC_CLOCK.intervalMs.
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
}

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
  const samples: Sample[] = []
  let offset: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let running: Promise<number | null> | null = null

  const use = () => {
    let best: Sample | null = null
    for (const s of samples) if (!best || s.rtt < best.rtt) best = s
    if (!best) return
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
    samples.push({ offset: sync - (sent + received) / 2, rtt })
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
