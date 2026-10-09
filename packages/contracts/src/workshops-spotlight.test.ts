// L5-2 (wave L): the spotlight's schemas. Additive to the workshops contract: a previous build's WorkshopState
// still parses, and the new fields are optional, so a web from before wave L strips them and an api from before
// sends none.
import { describe, expect, it } from 'vitest'
import {
  isNewerSpotlight,
  SPOTLIGHT_MAX_MS,
  SPOTLIGHT_MAX_REFS,
  Spotlight,
  SpotlightInput,
  SpotlightState,
  WORKSHOP_EVENTS,
  WorkshopSpotlightEvent,
  WorkshopState,
} from './workshops.ts'

const version = { epoch: 'e1', n: 3 }
const spotlight = {
  refs: ['shape:abc'],
  bringEveryone: false,
  by: { userId: 'usr_abcdefghijkl', name: 'Maya' },
  startedAt: '2026-10-09T10:00:00.000Z',
  endsAt: '2026-10-09T10:05:00.000Z',
  version,
}

describe('SpotlightInput', () => {
  it('takes 1 to 200 shape refs; bringEveryone defaults to false', () => {
    expect(SpotlightInput.parse({ refs: ['shape:a'] })).toEqual({ refs: ['shape:a'], bringEveryone: false })
    expect(SpotlightInput.safeParse({ refs: [] }).success).toBe(false)
    expect(SpotlightInput.safeParse({}).success).toBe(false)
    expect(SpotlightInput.safeParse({ refs: ['a'] }).success).toBe(false)
    const many = Array.from({ length: SPOTLIGHT_MAX_REFS + 1 }, (_, i) => `shape:n${i}`)
    expect(SpotlightInput.safeParse({ refs: many }).success).toBe(false)
    expect(SpotlightInput.safeParse({ refs: many.slice(0, SPOTLIGHT_MAX_REFS) }).success).toBe(true)
  })
})

describe('the spotlight and its events', () => {
  it('parses a state, an answer and an event (a start, an end with its reason)', () => {
    expect(Spotlight.parse(spotlight)).toEqual(spotlight)
    expect(SpotlightState.parse({ spotlight, version, serverNow: 'now' }).spotlight?.by.name).toBe('Maya')
    expect(SpotlightState.parse({ spotlight: null, version, serverNow: 'now' }).spotlight).toBeNull()
    expect(
      WorkshopSpotlightEvent.safeParse({ spotlight, version, reason: null, endedBy: null }).success,
    ).toBe(true)
    expect(
      WorkshopSpotlightEvent.safeParse({
        spotlight: null,
        version,
        reason: 'expired',
        endedBy: null,
      }).success,
    ).toBe(true)
    expect(
      WorkshopSpotlightEvent.safeParse({ spotlight: null, version, reason: 'bored', endedBy: null }).success,
    ).toBe(false)
    expect(WORKSHOP_EVENTS.spotlight).toBe('workshop.spotlight')
    expect(SPOTLIGHT_MAX_MS).toBe(5 * 60 * 1000)
  })

  it('orders states of one api process by their number, and any state of another process is newer', () => {
    expect(isNewerSpotlight(null, version)).toBe(true)
    expect(isNewerSpotlight(version, { epoch: 'e1', n: 3 })).toBe(true) // the same state again is idempotent
    expect(isNewerSpotlight(version, { epoch: 'e1', n: 4 })).toBe(true)
    expect(isNewerSpotlight(version, { epoch: 'e1', n: 2 })).toBe(false)
    expect(isNewerSpotlight(version, { epoch: 'e2', n: 0 })).toBe(true)
    expect(isNewerSpotlight(version, null)).toBe(false)
  })
})

describe('WorkshopState with the spotlight', () => {
  const base = {
    timer: null,
    vote: null,
    hands: [],
    handsVersion: null,
    serverNow: '2026-10-09T10:00:00.000Z',
  }

  it('parses the state wave K sent (no spotlight fields)', () => {
    const s = WorkshopState.parse(base)
    expect(s.spotlight).toBeUndefined()
    expect(s.spotlightVersion).toBeUndefined()
  })

  it('carries the spotlight and its version when the api has them, and null when none runs', () => {
    const s = WorkshopState.parse({ ...base, spotlight, spotlightVersion: version })
    expect(s.spotlight?.refs).toEqual(['shape:abc'])
    expect(s.spotlightVersion).toEqual(version)
    expect(WorkshopState.parse({ ...base, spotlight: null, spotlightVersion: version }).spotlight).toBeNull()
  })

  it('refuses a malformed spotlight rather than showing half of one', () => {
    expect(WorkshopState.safeParse({ ...base, spotlight: { ...spotlight, refs: [] } }).success).toBe(false)
    expect(WorkshopState.safeParse({ ...base, spotlight: { refs: ['shape:a'] } }).success).toBe(false)
  })
})
