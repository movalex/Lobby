// The shared workshop timer: pure state transitions (no I/O), so the arithmetic is unit-tested on its
// own. The server stores the END TIMESTAMP of a running countdown, never a ticking value: every
// client derives "time left" from `endsAt` and its clock offset to the server, so late joiners and
// reloads agree with everyone else (FAC-03).
//
// Semantics (Miro-style):
// - start {durationMs}: (re)starts from the full duration, from any state.
// - pause: running -> paused, freezing what is left. Already paused/stopped/finished: no change.
// - resume: paused -> running with the frozen time left. Anything else: no change.
// - stop: resets to the set duration (stopped). Already stopped: no change.
// - add {addMs}: running -> later end; paused -> more time left; finished -> runs again for addMs.
//   `durationMs` stays the duration that was set (what Stop resets to). Stopped/no timer: refused.

import {
  TIMER_MAX_MS,
  type TimerActionInput,
  type TimerStatus,
  type WorkshopTimer,
} from '@draftroom/contracts'

export interface TimerState {
  status: TimerStatus
  durationMs: number
  /** Time left at `updatedAt` (running), frozen (paused), the set duration (stopped), 0 (finished). */
  remainingMs: number
  startedAt: Date | null
  /** When a running timer ends / a finished one ended; null while paused or stopped. */
  endsAt: Date | null
  startedBy: string | null
  updatedAt: Date
}

export class TimerRuleError extends Error {
  readonly code: 'NOT_RUNNING' | 'NO_TIMER' | 'TOO_LONG'
  constructor(code: TimerRuleError['code'], message: string) {
    super(message)
    this.name = 'TimerRuleError'
    this.code = code
  }
}

const ms = (d: Date) => d.getTime()

/** A running timer whose end has passed is finished. No scheduler: every read/write normalizes. */
export function normalizeTimer(s: TimerState, now: Date): TimerState {
  if (s.status === 'running' && s.endsAt && ms(s.endsAt) <= ms(now)) {
    return { ...s, status: 'finished', remainingMs: 0 }
  }
  return s
}

/** Milliseconds left at `now`. */
export function timeLeftMs(s: TimerState, now: Date): number {
  const n = normalizeTimer(s, now)
  switch (n.status) {
    case 'running':
      return Math.max(0, ms(n.endsAt as Date) - ms(now))
    case 'paused':
      return n.remainingMs
    case 'stopped':
      return n.durationMs
    case 'finished':
      return 0
  }
}

export interface TimerTransition {
  next: TimerState
  /** false = the action was a no-op in the current state (nothing to store or publish). */
  changed: boolean
}

export function applyTimerAction(
  prev: TimerState | null,
  action: TimerActionInput,
  now: Date,
  userId: string,
): TimerTransition {
  const cur = prev ? normalizeTimer(prev, now) : null
  const unchanged = (s: TimerState): TimerTransition => ({ next: s, changed: false })
  switch (action.action) {
    case 'start':
      return {
        changed: true,
        next: {
          status: 'running',
          durationMs: action.durationMs,
          remainingMs: action.durationMs,
          startedAt: now,
          endsAt: new Date(ms(now) + action.durationMs),
          startedBy: userId,
          updatedAt: now,
        },
      }
    case 'pause': {
      if (!cur) throw new TimerRuleError('NO_TIMER', 'There is no timer to pause.')
      if (cur.status !== 'running') return unchanged(cur)
      return {
        changed: true,
        next: { ...cur, status: 'paused', remainingMs: timeLeftMs(cur, now), endsAt: null, updatedAt: now },
      }
    }
    case 'resume': {
      if (!cur) throw new TimerRuleError('NO_TIMER', 'There is no timer to resume.')
      if (cur.status !== 'paused') return unchanged(cur)
      return {
        changed: true,
        next: { ...cur, status: 'running', endsAt: new Date(ms(now) + cur.remainingMs), updatedAt: now },
      }
    }
    case 'stop': {
      if (!cur) throw new TimerRuleError('NO_TIMER', 'There is no timer to stop.')
      if (cur.status === 'stopped') return unchanged(cur)
      return {
        changed: true,
        next: { ...cur, status: 'stopped', remainingMs: cur.durationMs, endsAt: null, updatedAt: now },
      }
    }
    case 'add': {
      if (!cur || cur.status === 'stopped')
        throw new TimerRuleError('NOT_RUNNING', 'Start the timer before adding time.')
      const left = timeLeftMs(cur, now) + action.addMs
      if (left > TIMER_MAX_MS) throw new TimerRuleError('TOO_LONG', 'A timer can run for at most 24 hours.')
      if (cur.status === 'paused')
        return { changed: true, next: { ...cur, remainingMs: left, updatedAt: now } }
      // running or finished: the countdown (re)runs until now + what is left.
      return {
        changed: true,
        next: {
          ...cur,
          status: 'running',
          remainingMs: left,
          endsAt: new Date(ms(now) + left),
          updatedAt: now,
          startedAt: cur.status === 'finished' ? now : cur.startedAt,
        },
      }
    }
  }
}

/** The response/event shape: status and time left as of `now`. */
export function timerView(s: TimerState, now: Date): WorkshopTimer {
  const n = normalizeTimer(s, now)
  return {
    status: n.status,
    durationMs: n.durationMs,
    remainingMs: timeLeftMs(n, now),
    endsAt: n.endsAt ? n.endsAt.toISOString() : null,
    startedAt: n.startedAt ? n.startedAt.toISOString() : null,
    startedBy: n.startedBy,
    updatedAt: n.updatedAt.toISOString(),
  }
}
