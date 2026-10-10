// OWNER: W5 (wave M, M5-5; landed by the wave M foundation). The countUsage stub, and the contract's lists against
// what the web really has: every static command of the board features is a PALETTE_COMMAND_IDS member (so
// `palette.run:<id>` can count it), and the template ids are the picker's.
import {
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
  USAGE_BATCH_MAX_KEYS,
  USAGE_COUNT_CAP,
  USAGE_EVENTS,
  USAGE_TEMPLATE_IDS,
  UsageBatch,
  type UsageEvent,
} from '@draftroom/contracts'
import { TEMPLATE_INFOS } from '@draftroom/templates/plan'
import { afterEach, describe, expect, it } from 'vitest'
import { CANVAS_FEATURES } from '../features/canvas-registry.ts'
import { countUsage, pendingUsage, resetUsageForTests, takeUsageBatch } from './usage.ts'

afterEach(() => resetUsageForTests())

describe('countUsage (the foundation stub: in memory, never sent)', () => {
  it('counts per event, and a batch is a valid POST /api/usage body that starts the count again', () => {
    countUsage('coach.shown')
    countUsage('coach.shown')
    countUsage('palette.open:key')
    expect(pendingUsage()).toEqual({ 'coach.shown': 2, 'palette.open:key': 1 })
    const batch = takeUsageBatch()
    expect(batch).toEqual({ events: { 'coach.shown': 2, 'palette.open:key': 1 } })
    expect(UsageBatch.safeParse(batch).success).toBe(true)
    expect(takeUsageBatch()).toBeNull()
    expect(pendingUsage()).toEqual({})
  })

  it('caps each event and the number of events; ignores what is not an event; never throws', () => {
    for (let i = 0; i < USAGE_COUNT_CAP + 20; i++) countUsage('open.cold')
    expect(pendingUsage()['open.cold']).toBe(USAGE_COUNT_CAP)
    for (const e of USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS + 10)) countUsage(e)
    expect(Object.keys(pendingUsage())).toHaveLength(USAGE_BATCH_MAX_KEYS)
    resetUsageForTests()
    expect(() => countUsage('board:b-abc123' as UsageEvent)).not.toThrow()
    expect(pendingUsage()).toEqual({})
    for (const e of USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS)) countUsage(e)
    expect(UsageBatch.safeParse(takeUsageBatch()).success).toBe(true)
  })

  it('sends nothing (no fetch, no beacon) until W5 adds the transport', () => {
    const calls: string[] = []
    const g = globalThis as { fetch?: unknown; navigator?: unknown }
    const fetchBefore = g.fetch
    g.fetch = (...a: unknown[]) => {
      calls.push(String(a[0]))
      return Promise.reject(new Error('no'))
    }
    try {
      for (let i = 0; i < 5; i++) countUsage('version.notice')
      expect(calls).toEqual([])
    } finally {
      g.fetch = fetchBefore
    }
  })
})

describe('the contract’s lists match the web', () => {
  it('every static command of the board features is a palette command id (pending ones aside, all are)', () => {
    const ids = CANVAS_FEATURES.flatMap((f) => (f.commands ?? []).map((c) => c.id))
    const known = new Set<string>(PALETTE_COMMAND_IDS)
    expect(ids.filter((id) => !known.has(id))).toEqual([])
    // and the list names nothing else, except the commands still to come (W8)
    const live = new Set(ids)
    expect(PALETTE_COMMAND_IDS.filter((id) => !live.has(id))).toEqual([...PENDING_PALETTE_COMMAND_IDS])
  })

  it('the template ids are the picker’s', () => {
    expect([...USAGE_TEMPLATE_IDS].sort()).toEqual(TEMPLATE_INFOS.map((t) => t.id).sort())
  })
})
