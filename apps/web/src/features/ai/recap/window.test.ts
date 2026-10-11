// Wave N, N4-4 (OWNER: WS4): Catch me up's window reads the SERVER's previous visit time when the visits feature handed it
// in, else this device's localStorage as before, else the last 24 hours. (recap.test.ts keeps the device-local cases.)
import { beforeEach, describe, expect, it } from 'vitest'
import {
  catchUpSince,
  catchUpWindow,
  DAY_MS,
  lastVisitKey,
  noteServerVisit,
  noteVisit,
  resetVisits,
  writeLastVisit,
} from './window.ts'

const NOW = Date.UTC(2026, 9, 12, 15, 0, 0)
const HOUR = 3_600_000

function store() {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}
const throwing = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

beforeEach(() => resetVisits())

describe('Catch me up’s window with the server’s visit time', () => {
  it('the server value wins over this device’s last visit', () => {
    const s = store()
    writeLastVisit('b-1', NOW - 2 * HOUR, s) // this device was here two hours ago...
    noteVisit('b-1', NOW - 1_000, s)
    noteServerVisit('b-1', NOW - 30 * HOUR) // ...but the person's last visit anywhere was 30 hours ago
    expect(catchUpWindow('b-1', NOW, s)).toEqual({ since: NOW - 30 * HOUR, visit: true })
    expect(catchUpSince('b-1', NOW, s)).toBe(NOW - 30 * HOUR)
  })

  it('works with no localStorage at all (a throwing or absent storage still gets the server’s time)', () => {
    noteServerVisit('b-1', NOW - 5 * HOUR)
    expect(catchUpWindow('b-1', NOW, throwing)).toEqual({ since: NOW - 5 * HOUR, visit: true })
    expect(catchUpWindow('b-1', NOW, null)).toEqual({ since: NOW - 5 * HOUR, visit: true })
  })

  it('null (a first visit on the server) falls back to this device’s last visit', () => {
    const s = store()
    writeLastVisit('b-1', NOW - 7 * HOUR, s)
    noteVisit('b-1', NOW - 1_000, s)
    noteServerVisit('b-1', null)
    expect(catchUpWindow('b-1', NOW, s)).toEqual({ since: NOW - 7 * HOUR, visit: true })
    expect(s.m.get(lastVisitKey('b-1'))).toBe(String(NOW - 1_000))
  })

  it('null clears an earlier answer (the same page opens the board again and the api has none this time)', () => {
    const s = store()
    noteServerVisit('b-1', NOW - 30 * HOUR)
    noteServerVisit('b-1', null)
    expect(catchUpWindow('b-1', NOW, s)).toEqual({ since: NOW - DAY_MS, visit: false })
  })

  it('a throwing storage with nothing from the server gives the last 24 hours', () => {
    expect(catchUpWindow('b-1', NOW, throwing)).toEqual({ since: NOW - DAY_MS, visit: false })
    expect(() => noteVisit('b-1', NOW, throwing)).not.toThrow()
    expect(catchUpSince('b-1', NOW, throwing)).toBe(NOW - DAY_MS)
    expect(catchUpSince('b-2', NOW, null)).toBe(NOW - DAY_MS)
  })

  it('a server time that is not in the past of this clock is not used (a clock that is behind), nor is a bad number', () => {
    const s = store()
    writeLastVisit('b-1', NOW - 3 * HOUR, s)
    noteVisit('b-1', NOW - 1_000, s)
    noteServerVisit('b-1', NOW + 60_000)
    expect(catchUpWindow('b-1', NOW, s)).toEqual({ since: NOW - 3 * HOUR, visit: true })
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      noteServerVisit('b-1', bad)
      expect(catchUpWindow('b-1', NOW, s).since, String(bad)).toBe(NOW - 3 * HOUR)
    }
  })

  it('is per board, and resetVisits forgets it', () => {
    noteServerVisit('b-1', NOW - 4 * HOUR)
    expect(catchUpWindow('b-2', NOW, null)).toEqual({ since: NOW - DAY_MS, visit: false })
    expect(catchUpWindow('b-1', NOW, null).visit).toBe(true)
    resetVisits()
    expect(catchUpWindow('b-1', NOW, null).visit).toBe(false)
  })
})
