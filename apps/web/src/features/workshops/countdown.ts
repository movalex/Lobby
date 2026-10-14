// Timer display math. The server owns the timer and sends its END timestamp; the browser only ever
// computes `endsAt - serverNow`, where serverNow = Date.now() + the clock offset the event stream
// measured. No local counter accumulates, so there is no drift and late joiners agree (FAC-03).

import type { WorkshopTimer } from '@draftroom/contracts'

export type TimerPhase = 'idle' | 'running' | 'paused' | 'stopped' | 'finished'

/**
 * Milliseconds left right now, on the server's clock. A running timer never shows more than the
 * `remainingMs` the server sent (what was left when it answered; time has only passed since), so a
 * clock-offset error can never make a 5:00 timer read 5:01.
 */
export function timerRemainingMs(timer: WorkshopTimer | null, localNowMs: number, offsetMs: number): number {
  if (!timer) return 0
  switch (timer.status) {
    case 'running': {
      const ends = Date.parse(timer.endsAt ?? '')
      if (Number.isNaN(ends)) return timer.remainingMs
      return Math.min(timer.remainingMs, Math.max(0, ends - (localNowMs + offsetMs)))
    }
    case 'paused':
      return timer.remainingMs
    case 'stopped':
      return timer.durationMs
    case 'finished':
      return 0
  }
}

/** A running timer that has reached zero here is finished, even before the server says so. */
export function timerPhase(timer: WorkshopTimer | null, localNowMs: number, offsetMs: number): TimerPhase {
  if (!timer) return 'idle'
  if (timer.status === 'running' && timerRemainingMs(timer, localNowMs, offsetMs) <= 0) return 'finished'
  return timer.status
}

/**
 * How long a finished timer stays in its "Time's up" state (red pill, 0:00) before the pill goes back
 * to plain "Timer". The server keeps it finished; a facilitator can still Reset it.
 */
export const TIMES_UP_ALERT_MS = 10_000

/** What the timer pill shows: the phase, or 'ended' once a finished timer's alert is over. */
export type TimerDisplay = TimerPhase | 'ended'

/**
 * The phase as the pill and the presentation show it: a timer that finished more than
 * TIMES_UP_ALERT_MS ago (on the server's clock) is 'ended', so it no longer shouts "Time's up" at
 * people, including those who open the board later. A finished timer without an end time is 'ended'.
 */
export function timerDisplayPhase(
  timer: WorkshopTimer | null,
  localNowMs: number,
  offsetMs: number,
): TimerDisplay {
  const phase = timerPhase(timer, localNowMs, offsetMs)
  if (phase !== 'finished') return phase
  const ends = Date.parse(timer?.endsAt ?? '')
  if (Number.isNaN(ends)) return 'ended'
  return localNowMs + offsetMs - ends >= TIMES_UP_ALERT_MS ? 'ended' : 'finished'
}

/** P-016: the last seconds of a running timer, which the timer pill on the canvas emphasises. */
export const LAST_SECONDS_MS = 10_000

/** Whether `remainingMs` of a running timer is in the last seconds: some time left, at most LAST_SECONDS_MS. */
export const inLastSeconds = (remainingMs: number): boolean =>
  remainingMs > 0 && remainingMs <= LAST_SECONDS_MS

/** "4:05", "0:09", "1:02:03". Rounds up, so the display reaches 0:00 exactly when time is up. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Spoken form for screen readers: "4 minutes 5 seconds left". */
export function describeClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`)
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s || parts.length === 0) parts.push(`${s} second${s === 1 ? '' : 's'}`)
  return parts.join(' ')
}

/**
 * Parses what a facilitator types as a duration: "5" (minutes), "5:30", "1:05:00", "90s", "2m",
 * "1h", "1h30m". Returns ms, or null when it is not a duration between 1 s and 24 h.
 */
export function parseDurationInput(input: string): number | null {
  const s = input.trim().toLowerCase()
  if (!s) return null
  let ms: number | null = null
  if (/^\d+(\.\d+)?$/.test(s)) ms = Number(s) * 60_000
  else if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    const parts = s.split(':').map(Number)
    if (parts.slice(1).some((p) => p >= 60)) return null
    // m:ss or h:mm:ss
    ms = parts.reduce((acc, p) => acc * 60 + p, 0) * 1000
  } else {
    const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(s)
    if (m && (m[1] || m[2] || m[3]))
      ms = ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000
  }
  if (ms === null || !Number.isFinite(ms)) return null
  ms = Math.round(ms)
  return ms >= 1000 && ms <= 24 * 3600_000 ? ms : null
}

/**
 * Whether a finished-state alert should fire now: the timer was seen running with time left in this
 * tab and has now reached zero (not when someone opens the board after it ended long ago).
 */
export function crossedZero(
  prev: { phase: TimerPhase; endsAt: string | null } | null,
  nextPhase: TimerPhase,
) {
  return prev !== null && prev.phase === 'running' && nextPhase === 'finished'
}
