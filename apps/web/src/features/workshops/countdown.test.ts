import type { WorkshopTimer } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  crossedZero,
  describeClock,
  formatClock,
  parseDurationInput,
  TIMES_UP_ALERT_MS,
  timerDisplayPhase,
  timerPhase,
  timerRemainingMs,
} from './countdown.ts'

const SERVER_T0 = Date.parse('2026-09-26T10:00:00.000Z')
const running = (endsInMs: number): WorkshopTimer => ({
  status: 'running',
  durationMs: 300_000,
  remainingMs: 300_000,
  endsAt: new Date(SERVER_T0 + endsInMs).toISOString(),
  startedAt: new Date(SERVER_T0).toISOString(),
  startedBy: 'usr_facilitator0001',
  updatedAt: new Date(SERVER_T0).toISOString(),
})

describe('countdown from server timestamps', () => {
  it('uses endsAt and the server clock offset, not the local clock alone', () => {
    const t = running(300_000)
    // This browser's clock is 7 s behind the server: local 09:59:53 == server 10:00:00.
    const offset = 7_000
    const localAtServerT0 = SERVER_T0 - offset
    expect(timerRemainingMs(t, localAtServerT0, offset)).toBe(300_000)
    expect(timerRemainingMs(t, localAtServerT0 + 90_000, offset)).toBe(210_000)
    // Without the offset the display would be 7 s off.
    expect(timerRemainingMs(t, localAtServerT0 + 90_000, 0)).toBe(217_000)
  })

  it('never shows more than the server said was left (an offset error cannot turn 5:00 into 5:01)', () => {
    const t = running(300_000)
    // A browser whose offset estimate is 800 ms too high, right at the start.
    expect(timerRemainingMs(t, SERVER_T0, 800)).toBe(300_000 - 800)
    // ...and one 800 ms too low: clamped to the 300 000 ms the server reported, not 300 800.
    expect(timerRemainingMs(t, SERVER_T0, -800)).toBe(300_000)
    expect(formatClock(timerRemainingMs(t, SERVER_T0 + 10, -800))).toBe('5:00')
    // After "+1 min" the server reports the new time left, and that is the new upper bound.
    const added = { ...running(360_000), remainingMs: 360_000 }
    expect(timerRemainingMs(added, SERVER_T0, 0)).toBe(360_000)
  })

  it('late joiners and clients with different clocks agree to the millisecond', () => {
    const t = running(300_000)
    const serverNow = SERVER_T0 + 123_456
    const clients = [
      { localNow: serverNow - 30_000, offset: 30_000 }, // 30 s slow
      { localNow: serverNow + 4_200, offset: -4_200 }, // 4.2 s fast
      { localNow: serverNow, offset: 0 },
    ]
    const shown = clients.map((c) => timerRemainingMs(t, c.localNow, c.offset))
    expect(new Set(shown)).toEqual(new Set([300_000 - 123_456]))
  })

  it('no drift: the value depends only on the current time, however irregular the ticks', () => {
    const t = running(60_000)
    const ticks = [0, 250, 251, 900, 5_000, 5_001, 59_999, 60_000, 61_000]
    for (const dt of ticks) expect(timerRemainingMs(t, SERVER_T0 + dt, 0)).toBe(Math.max(0, 60_000 - dt))
  })

  it('paused/stopped/finished show their fixed values; a running timer at zero is finished', () => {
    const base = running(60_000)
    expect(timerRemainingMs({ ...base, status: 'paused', endsAt: null, remainingMs: 42_000 }, 0, 0)).toBe(
      42_000,
    )
    expect(timerRemainingMs({ ...base, status: 'stopped', endsAt: null }, 0, 0)).toBe(300_000)
    expect(timerRemainingMs({ ...base, status: 'finished', remainingMs: 0 }, 0, 0)).toBe(0)
    expect(timerPhase(base, SERVER_T0 + 59_999, 0)).toBe('running')
    expect(timerPhase(base, SERVER_T0 + 60_000, 0)).toBe('finished')
    expect(timerPhase(null, 0, 0)).toBe('idle')
  })

  it('the end alert fires only on a live transition from running to finished', () => {
    expect(crossedZero({ phase: 'running', endsAt: 'x' }, 'finished')).toBe(true)
    expect(crossedZero(null, 'finished')).toBe(false) // opened the board after it ended
    expect(crossedZero({ phase: 'paused', endsAt: null }, 'finished')).toBe(false)
    expect(crossedZero({ phase: 'running', endsAt: 'x' }, 'stopped')).toBe(false) // stopped early
  })
})

describe('formatting and input', () => {
  it('formats m:ss / h:mm:ss, rounding up so 0:00 means time is up', () => {
    expect(formatClock(300_000)).toBe('5:00')
    expect(formatClock(299_001)).toBe('5:00')
    expect(formatClock(299_000)).toBe('4:59')
    expect(formatClock(9_000)).toBe('0:09')
    expect(formatClock(1)).toBe('0:01')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(3_723_000)).toBe('1:02:03')
    expect(describeClock(65_000)).toBe('1 minute 5 seconds')
    expect(describeClock(0)).toBe('0 seconds')
  })

  it('parses typed durations', () => {
    expect(parseDurationInput('5')).toBe(300_000)
    expect(parseDurationInput(' 2.5 ')).toBe(150_000)
    expect(parseDurationInput('5:30')).toBe(330_000)
    expect(parseDurationInput('1:05:00')).toBe(3_900_000)
    expect(parseDurationInput('90s')).toBe(90_000)
    expect(parseDurationInput('1h30m')).toBe(5_400_000)
    expect(parseDurationInput('2m')).toBe(120_000)
    for (const bad of ['', 'abc', '0', '5:75', '25h', '-1', '0s']) expect(parseDurationInput(bad)).toBeNull()
  })
})

describe("time's up, then quiet (RETRO-12)", () => {
  const finished = (endedMsAfterT0: number | null): WorkshopTimer => ({
    ...running(0),
    status: 'finished',
    remainingMs: 0,
    endsAt: endedMsAfterT0 === null ? null : new Date(SERVER_T0 + endedMsAfterT0).toISOString(),
  })

  it('shows "finished" for the alert, then goes back to the plain pill ("ended")', () => {
    const t = running(60_000)
    expect(timerDisplayPhase(t, SERVER_T0 + 59_000, 0)).toBe('running')
    // Reached zero here, before the server says so.
    expect(timerDisplayPhase(t, SERVER_T0 + 60_000, 0)).toBe('finished')
    expect(timerDisplayPhase(t, SERVER_T0 + 60_000 + TIMES_UP_ALERT_MS - 1, 0)).toBe('finished')
    expect(timerDisplayPhase(t, SERVER_T0 + 60_000 + TIMES_UP_ALERT_MS, 0)).toBe('ended')
    // The server's finished state reads the same; the raw phase stays "finished" (Reset is offered).
    expect(timerDisplayPhase(finished(60_000), SERVER_T0 + 65_000, 0)).toBe('finished')
    expect(timerDisplayPhase(finished(60_000), SERVER_T0 + 75_000, 0)).toBe('ended')
    expect(timerPhase(finished(60_000), SERVER_T0 + 75_000, 0)).toBe('finished')
  })

  it('a late joiner (on the server clock) never sees the alert, and paused/stopped are untouched', () => {
    // This browser is 20 s behind the server: the timer ended 11 s ago on the server's clock.
    expect(timerDisplayPhase(finished(0), SERVER_T0 + 11_000 - 20_000, 20_000)).toBe('ended')
    expect(timerDisplayPhase(finished(null), SERVER_T0, 0)).toBe('ended')
    expect(timerDisplayPhase({ ...running(0), status: 'paused' }, SERVER_T0 + 999_999, 0)).toBe('paused')
    expect(timerDisplayPhase({ ...running(0), status: 'stopped' }, SERVER_T0, 0)).toBe('stopped')
    expect(timerDisplayPhase(null, SERVER_T0, 0)).toBe('idle')
  })
})
