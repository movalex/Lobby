// Wave V (WS4): who goes to which group (pure: ../../../src/features/breakouts/deal.ts).
import { describe, expect, it } from 'vitest'
import { deal, shuffled, smallestGroup } from '../../../src/features/breakouts/deal.ts'

/** A seeded generator (mulberry32), so a failure can be replayed. */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('deal', () => {
  it('splits evenly (the groups differ by at most one) and keeps everyone exactly once', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const people = Array.from({ length: (seed * 7) % 41 }, (_, i) => `usr_${i}`)
      const groups = Array.from({ length: 2 + (seed % 19) }, (_, i) => `g${i + 1}`)
      const out = deal([...people, ...people.slice(0, 3)], groups, seeded(seed))
      expect([...out.keys()].sort()).toEqual([...people].sort())
      const sizes = groups.map((g) => [...out.values()].filter((x) => x === g).length)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    }
  })

  it('is shuffled: the same people do not always land together', () => {
    const people = Array.from({ length: 8 }, (_, i) => `usr_${i}`)
    const firstGroups = new Set<string>()
    for (let seed = 1; seed <= 20; seed++) {
      const out = deal(people, ['g1', 'g2'], seeded(seed))
      firstGroups.add(
        people
          .filter((p) => out.get(p) === 'g1')
          .sort()
          .join(','),
      )
    }
    expect(firstGroups.size).toBeGreaterThan(5)
  })

  it('no groups: nobody is placed; shuffled keeps the items', () => {
    expect(deal(['usr_a'], []).size).toBe(0)
    expect(shuffled([1, 2, 3, 4], seeded(3)).sort()).toEqual([1, 2, 3, 4])
    // a generator that returns 1 (out of range) stays in bounds
    expect(shuffled([1, 2, 3], () => 1).sort()).toEqual([1, 2, 3])
  })
})

describe('smallestGroup', () => {
  it('the group with the fewest members, the first in order on a tie; an empty group counts zero', () => {
    expect(
      smallestGroup(
        ['g1', 'g2', 'g3'],
        new Map([
          ['g1', 2],
          ['g2', 1],
          ['g3', 1],
        ]),
      ),
    ).toBe('g2')
    expect(
      smallestGroup(
        ['g1', 'g2', 'g3'],
        new Map([
          ['g1', 2],
          ['g2', 1],
        ]),
      ),
    ).toBe('g3')
    expect(smallestGroup(['g1', 'g2'], new Map())).toBe('g1')
    expect(smallestGroup([], new Map())).toBeNull()
  })
})
