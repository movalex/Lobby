// Retention of automatic checkpoints (docs/WAVE4-CONTRACTS.md checkpoints-2): the pure plan.
import type { CheckpointReason } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  dayBucket,
  hourBucket,
  planRetention,
  type RetentionItem,
  weekBucket,
} from '../../../src/features/history/retention.ts'

const H = 60 * 60 * 1000
const D = 24 * H
// A Wednesday, 10:30 UTC.
const NOW = new Date(Date.UTC(2026, 8, 30, 10, 30))

let seq = 0
const item = (ageMs: number, reason: CheckpointReason | null = 'hourly', id?: string): RetentionItem => ({
  id: id ?? `snp_${String(++seq).padStart(12, '0')}`,
  createdAt: new Date(NOW.getTime() - ageMs),
  reason,
})
const plan = (items: RetentionItem[]) => planRetention(items, NOW)
const kept = (items: RetentionItem[]) => new Set(plan(items).keep)

describe('checkpoint retention', () => {
  it('buckets are UTC hours, UTC days and Monday-to-Sunday ISO weeks', () => {
    const t = (iso: string) => Date.parse(iso)
    expect(hourBucket(t('2026-09-30T10:00:00Z'))).toBe(hourBucket(t('2026-09-30T10:59:59.999Z')))
    expect(hourBucket(t('2026-09-30T11:00:00Z'))).not.toBe(hourBucket(t('2026-09-30T10:59:59Z')))
    expect(dayBucket(t('2026-09-30T00:00:00Z'))).toBe(dayBucket(t('2026-09-30T23:59:59Z')))
    // 2026-09-28 is a Monday, 2026-10-04 the Sunday of the same week.
    expect(weekBucket(t('2026-09-28T00:00:00Z'))).toBe(weekBucket(t('2026-10-04T23:59:59Z')))
    expect(weekBucket(t('2026-09-27T23:59:59Z'))).toBe(weekBucket(t('2026-09-28T00:00:00Z')) - 1)
    expect(weekBucket(t('2026-10-05T00:00:00Z'))).toBe(weekBucket(t('2026-10-04T23:59:59Z')) + 1)
  })

  it('keeps the newest checkpoint of each hour for 48 hours, and every one made before a restore or at an import', () => {
    // 10:29, 10:10 and 10:01 today (same hour); 09:50 (previous hour).
    const newest = item(1 * 60_000)
    const older = item(20 * 60_000, 'session_end')
    const beforeRestore = item(25 * 60_000, 'before_restore')
    const imported = item(29 * 60_000, 'import')
    const previousHour = item(40 * 60_000)
    const result = plan([older, newest, beforeRestore, imported, previousHour])
    expect(new Set(result.keep)).toEqual(new Set([newest.id, beforeRestore.id, imported.id, previousHour.id]))
    expect(result.remove).toEqual([older.id])
  })

  it('a checkpoint made before a restore never pushes the routine checkpoint of its hour out', () => {
    // 10:25 session end (being restored), 10:28 the board saved before that restore.
    const sessionEnd = item(5 * 60_000, 'session_end')
    const beforeRestore = item(2 * 60_000, 'before_restore')
    const imported = item(1 * 60_000, 'import')
    expect(kept([sessionEnd, beforeRestore, imported])).toEqual(
      new Set([sessionEnd.id, beforeRestore.id, imported.id]),
    )
    // Once they are two days old, the day keeps only its newest one.
    const later = new Date(NOW.getTime() + 2 * D)
    expect(planRetention([sessionEnd, beforeRestore, imported], later).keep).toEqual([imported.id])
  })

  it('keeps one per day from 48 hours to 30 days, one per week to 6 months, and nothing older', () => {
    // Three checkpoints 5 days ago (10:30, 08:30, 02:30 UTC that day) -> the day's newest stays.
    const day5 = [item(5 * D), item(5 * D + 2 * H), item(5 * D + 8 * H, 'before_restore')]
    // 40 days ago = Friday 2026-08-21; 41 days ago = Thursday 2026-08-20 (same ISO week).
    const week = [item(40 * D), item(41 * D)]
    const ancient = [item(183 * D), item(400 * D, 'import')]
    const result = plan([...day5, ...week, ...ancient])
    expect(new Set(result.keep)).toEqual(new Set([day5[0]?.id, week[0]?.id]))
    expect(new Set(result.remove)).toEqual(
      new Set([day5[1]?.id, day5[2]?.id, week[1]?.id, ancient[0]?.id, ancient[1]?.id]),
    )
  })

  it('a day that is partly still in the hourly tier keeps its newest checkpoint, wherever it sits', () => {
    // 47 h ago (hourly tier) and 49 h ago (daily tier) fall on the same UTC day (2026-09-28, 11:30 and 09:30).
    const young = item(47 * H)
    const old = item(49 * H)
    expect(kept([young, old])).toEqual(new Set([young.id]))
  })

  it('an hourly-tier checkpoint made before a restore is kept only until it is 48 hours old', () => {
    const beforeRestore = item(30 * 60_000, 'before_restore')
    const newer = item(10 * 60_000)
    expect(kept([beforeRestore, newer]).has(beforeRestore.id)).toBe(true)
    const later = new Date(NOW.getTime() + 48 * H)
    expect(planRetention([beforeRestore, newer], later).remove).toEqual([beforeRestore.id])
  })

  it('keeps a checkpoint dated in the future (clock skew) and ties go to the larger id', () => {
    const future = item(-5 * 60_000)
    const a = item(3 * D, 'hourly', 'snp_aaaaaaaaaaaa')
    const b = item(3 * D, 'hourly', 'snp_bbbbbbbbbbbb')
    const result = plan([future, a, b])
    expect(new Set(result.keep)).toEqual(new Set([future.id, b.id]))
    expect(result.remove).toEqual([a.id])
  })

  it('does not depend on when earlier passes ran: pruning often or never keeps the same checkpoints', () => {
    const items: RetentionItem[] = []
    // A board edited every 20 minutes for 200 days, with a restore now and then.
    for (let age = 0; age < 200 * D; age += 20 * 60_000)
      items.push(item(age, age % (7 * H) === 0 ? 'before_restore' : age % H === 0 ? 'session_end' : 'hourly'))
    let alive = items
    for (let step = 0; step < 40; step++) {
      const at = new Date(NOW.getTime() + step * 7 * H)
      const often = planRetention(alive, at)
      const never = planRetention(items, at)
      expect(new Set(often.keep)).toEqual(new Set(never.keep))
      alive = alive.filter((x) => often.keep.includes(x.id))
    }
    // What is left is bounded: the hourly tier (48 buckets + restores), about 30 days and 26 weeks.
    expect(alive.length).toBeLessThanOrEqual(48 + 7 + 31 + 27)
    expect(alive.length).toBeGreaterThan(30)
  })
})
