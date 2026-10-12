// Wave N.1 (wave N follow-up 5, "one clock"): the api's measure of the sync server's clock (src/sync-clock.ts), which
// the visit times are stored on. NTP-style: offset = sync - (sent + received) / 2; a slow round trip is not used; of
// the kept samples the shortest round trip wins; a failure keeps what is known; unknown means the api's own clock.
import { describe, expect, it } from 'vitest'
import { createSyncClock, SYNC_CLOCK } from '../src/sync-clock.ts'

/** A clock the test moves, and a sync read that moves it by `rtt` and answers `skew` ms ahead of it. */
function world() {
  let t = 1_800_000_000_000
  const now = () => new Date(t)
  const logs: string[] = []
  const answers: { skew: number; rtt: number; fail?: boolean }[] = []
  const read = async () => {
    const a = answers.shift() ?? { skew: 0, rtt: 0 }
    t += a.rtt / 2
    const at = t + a.skew
    t += a.rtt / 2
    if (a.fail) throw new Error('sync unreachable')
    return at
  }
  return {
    now,
    logs,
    answers,
    advance: (ms: number) => {
      t += ms
    },
    clock: createSyncClock({ read, now, log: (m) => logs.push(m) }),
  }
}

describe('createSyncClock', () => {
  it('unknown at first: the api’s own clock; one measurement gives the offset, then the sync’s time', async () => {
    const w = world()
    expect(w.clock.offsetMs()).toBeNull()
    expect(w.clock.now().getTime()).toBe(w.now().getTime())
    w.answers.push({ skew: 4_000, rtt: 20 })
    expect(await w.clock.measure()).toBe(4_000)
    expect(w.clock.now().getTime()).toBe(w.now().getTime() + 4_000)
    expect(w.logs).toEqual(["[clock] the sync's clock is +4000 ms from the api's"])
    // a sync behind the api: a negative offset
    const v = world()
    v.answers.push({ skew: -2_500, rtt: 10 })
    expect(await v.clock.measure()).toBe(-2_500)
    expect(v.clock.now().getTime()).toBe(v.now().getTime() - 2_500)
  })

  it('a round trip over the limit is not used; of the kept samples the shortest round trip wins', async () => {
    const w = world()
    w.answers.push({ skew: 9_000, rtt: SYNC_CLOCK.maxRttMs + 1 })
    expect(await w.clock.measure()).toBeNull()
    w.answers.push({ skew: 100, rtt: 400 }, { skew: 120, rtt: 6 }, { skew: 300, rtt: 300 })
    await w.clock.measure()
    await w.clock.measure()
    await w.clock.measure()
    expect(w.clock.offsetMs()).toBe(120)
    // the shortest one ages out after SYNC_CLOCK.keep newer samples
    for (let i = 0; i < SYNC_CLOCK.keep; i++) {
      w.answers.push({ skew: 150, rtt: 50 })
      await w.clock.measure()
    }
    expect(w.clock.offsetMs()).toBe(150)
  })

  it('a failed read keeps the offset in use; a large move is logged (the offset only)', async () => {
    const w = world()
    w.answers.push({ skew: 50, rtt: 2 })
    await w.clock.measure()
    w.answers.push({ skew: 0, rtt: 2, fail: true })
    expect(await w.clock.measure()).toBe(50)
    for (let i = 0; i < SYNC_CLOCK.keep; i++) {
      w.answers.push({ skew: 3_050, rtt: 1 })
      await w.clock.measure()
    }
    expect(w.clock.offsetMs()).toBe(3_050)
    expect(w.logs.at(-1)).toBe("[clock] the sync's clock moved: now +3050 ms from the api's")
    const line = /^\[clock\] the sync's clock (is|moved: now) [+-]\d+ ms from the api's$/
    for (const l of w.logs) expect(l).toMatch(line)
  })

  it('without a read (a sync client without the route) it is the api’s clock, and start does nothing', async () => {
    let t = 5_000
    const clock = createSyncClock({ read: undefined, now: () => new Date(t) })
    clock.start()
    expect(await clock.measure()).toBeNull()
    t = 9_000
    expect(clock.now().getTime()).toBe(9_000)
    clock.stop()
  })

  it('start measures at once and again on its schedule (faster while unknown); stop ends it', async () => {
    let reads = 0
    let up = false
    const clock = createSyncClock({
      read: async () => {
        reads++
        if (!up) throw new Error('down')
        return Date.now() + 1_000
      },
      now: () => new Date(),
      schedule: { intervalMs: 200, retryMs: 20 },
    })
    clock.start()
    clock.start() // idempotent
    await new Promise((r) => setTimeout(r, 120))
    expect(reads).toBeGreaterThan(2) // retried while unknown
    up = true
    await new Promise((r) => setTimeout(r, 80))
    expect(clock.offsetMs()).not.toBeNull()
    const known = reads
    await new Promise((r) => setTimeout(r, 100))
    expect(reads - known).toBeLessThanOrEqual(1) // the slower schedule once known
    clock.stop()
    const stopped = reads
    await new Promise((r) => setTimeout(r, 300))
    expect(reads).toBe(stopped)
  })
})
