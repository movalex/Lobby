// Retention of automatic checkpoints (docs/WAVE4-CONTRACTS.md checkpoints-2; CHECKPOINT_RETENTION in
// @draftroom/contracts). Pure: given a board's automatic checkpoints and the time, which ones to keep.
//
// Buckets are UTC calendar hours, days and ISO weeks (Monday to Sunday); the checkpoint a bucket keeps
// is its newest one. By age:
//   younger than hourlyHours  every "safety" checkpoint (made before a restore, a private-notes reveal
//                             or an AI regroup, or right after an import), and the newest ROUTINE one
//                             (hourly, session end) of each hour.
//                             A safety checkpoint never pushes a routine one out: restoring the
//                             session-end checkpoint of 10:05 at 10:07 saves the board first, and that
//                             must not delete the very checkpoint being restored.
//   younger than dailyDays    the newest of each day (any reason, whatever its age)
//   younger than weeklyDays   the newest of each week
//   older                     deleted
// A checkpoint dated in the future (clock skew between servers) is kept. Manual checkpoints never get
// here: the caller passes automatic ones only, and the delete statement re-checks the kind.
//
// Pruning often or rarely gives the same result (a test checks it): the buckets nest (an hour lies in
// one day, a day in one ISO week), and a checkpoint that lost its bucket to a newer one never becomes
// the newest of a larger bucket, which always holds that newer one too.

import { CHECKPOINT_RETENTION, type CheckpointReason } from '@draftroom/contracts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export interface RetentionPolicy {
  hourlyMs: number
  dailyMs: number
  weeklyMs: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  hourlyMs: CHECKPOINT_RETENTION.hourlyHours * HOUR,
  dailyMs: CHECKPOINT_RETENTION.dailyDays * DAY,
  weeklyMs: CHECKPOINT_RETENTION.weeklyDays * DAY,
}

export interface RetentionItem {
  id: string
  createdAt: Date
  /** null for legacy pre_restore rows (treated like a routine automatic checkpoint). */
  reason: CheckpointReason | null
}

/** Checkpoints made before a risky operation: all kept while they are in the hourly tier. */
export const SAFETY_REASONS: ReadonlySet<string> = new Set<CheckpointReason>([
  'before_restore',
  'import',
  'before_reveal',
  'before_ai_themes',
])
const isSafety = (item: RetentionItem) => item.reason !== null && SAFETY_REASONS.has(item.reason)

export const hourBucket = (t: number) => Math.floor(t / HOUR)
export const dayBucket = (t: number) => Math.floor(t / DAY)
/** ISO weeks: 1970-01-01 (day 0) was a Thursday, so Monday 1969-12-29 (day -3) starts week 0. */
export const weekBucket = (t: number) => Math.floor((dayBucket(t) + 3) / 7)

export interface RetentionPlan {
  keep: string[]
  remove: string[]
}

export function planRetention(
  items: readonly RetentionItem[],
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): RetentionPlan {
  // Newest first (ties: the larger id), so the first item seen in a bucket is the one it keeps.
  const sorted = [...items].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )
  const newest = {
    routineHour: new Map<number, string>(),
    day: new Map<number, string>(),
    week: new Map<number, string>(),
  }
  const first = (map: Map<number, string>, key: number, id: string) => {
    if (!map.has(key)) map.set(key, id)
  }
  for (const item of sorted) {
    const t = item.createdAt.getTime()
    if (!isSafety(item)) first(newest.routineHour, hourBucket(t), item.id)
    first(newest.day, dayBucket(t), item.id)
    first(newest.week, weekBucket(t), item.id)
  }

  const keep: string[] = []
  const remove: string[] = []
  const at = now.getTime()
  for (const item of sorted) {
    const t = item.createdAt.getTime()
    const age = at - t
    let kept: boolean
    if (!Number.isFinite(t) || age < 0) kept = true
    else if (age >= policy.weeklyMs) kept = false
    else if (age < policy.hourlyMs) kept = isSafety(item) || newest.routineHour.get(hourBucket(t)) === item.id
    else if (age < policy.dailyMs) kept = newest.day.get(dayBucket(t)) === item.id
    else kept = newest.week.get(weekBucket(t)) === item.id
    ;(kept ? keep : remove).push(item.id)
  }
  return { keep, remove }
}
