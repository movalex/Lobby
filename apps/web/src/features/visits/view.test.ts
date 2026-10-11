// Wave N, N4-3: the outline plan (at most 200, the rest counted) and the tour's stops, and the tab's acknowledgement.
import { VISIT_HIGHLIGHT_MAX_OUTLINES } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { ackKey, acknowledge, wasAcknowledged } from './ack.ts'
import { finish } from './model.ts'
import { nextStop, planOutlines, tourStops } from './view.ts'

const changes = (
  added: string[],
  changed: string[],
  removed: { id: string; bounds?: { x: number; y: number; width: number; height: number } }[] = [],
) =>
  finish(
    1_000,
    added,
    changed,
    removed.map((r) => ({ id: r.id, type: 'stickynote', ...(r.bounds ? { bounds: r.bounds } : {}) })),
    0,
    false,
  )

describe('planOutlines', () => {
  it('outlines the added first, then the changed, in scene order', () => {
    const plan = planOutlines(changes(['a1', 'a2'], ['c1']))
    expect(plan.shown).toEqual([
      { id: 'a1', kind: 'added' },
      { id: 'a2', kind: 'added' },
      { id: 'c1', kind: 'changed' },
    ])
    expect(plan.rest).toBe(0)
  })

  it('draws at most 200 and counts the rest', () => {
    const added = Array.from({ length: 150 }, (_, i) => `a${i}`)
    const changed = Array.from({ length: 120 }, (_, i) => `c${i}`)
    const plan = planOutlines(changes(added, changed))
    expect(VISIT_HIGHLIGHT_MAX_OUTLINES).toBe(200)
    expect(plan.shown).toHaveLength(200)
    expect(plan.shown.filter((o) => o.kind === 'added')).toHaveLength(150)
    expect(plan.shown.filter((o) => o.kind === 'changed')).toHaveLength(50)
    expect(plan.rest).toBe(70)
    expect(planOutlines(changes(added, changed), 10)).toMatchObject({ rest: 260 })
    expect(planOutlines(changes(added, changed), 0)).toMatchObject({ shown: [], rest: 270 })
  })
})

describe('the tour', () => {
  const where = (id: string) => (id.startsWith('x') ? null : { x: id.length, y: 0, width: 10, height: 10 })

  it('visits the added, then the changed, then the removed that have a place; what has no place is skipped', () => {
    const stops = tourStops(
      changes(
        ['a', 'xa'],
        ['cc'],
        [{ id: 'gone', bounds: { x: 5, y: 5, width: 20, height: 20 } }, { id: 'nowhere' }],
      ),
      where,
    )
    expect(stops.map((s) => [s.id, s.kind])).toEqual([
      ['a', 'added'],
      ['cc', 'changed'],
      ['gone', 'removed'],
    ])
    expect(stops[2]?.bounds).toEqual({ x: 5, y: 5, width: 20, height: 20 })
  })

  it('nextStop wraps round and is -1 with nothing to visit', () => {
    expect(nextStop(-1, 3)).toBe(0)
    expect(nextStop(0, 3)).toBe(1)
    expect(nextStop(2, 3)).toBe(0)
    expect(nextStop(5, 0)).toBe(-1)
    expect(nextStop(-1, 1)).toBe(0)
    expect(nextStop(0, 1)).toBe(0)
  })
})

describe('acknowledging a visit on this tab', () => {
  const store = () => {
    const m = new Map<string, string>()
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    }
  }
  it('remembers the visit it marked seen, per board, and nothing else', () => {
    const s = store()
    expect(wasAcknowledged('b-1', 500, s)).toBe(false)
    acknowledge('b-1', 500, s)
    expect(s.m.get(ackKey('b-1'))).toBe('500')
    expect(wasAcknowledged('b-1', 500, s)).toBe(true)
    expect(wasAcknowledged('b-1', 501, s)).toBe(false) // another visit is not acknowledged
    expect(wasAcknowledged('b-2', 500, s)).toBe(false)
  })

  it('a blocked or throwing storage means no memory, never an error', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => acknowledge('b-1', 5, throwing)).not.toThrow()
    expect(wasAcknowledged('b-1', 5, throwing)).toBe(false)
    expect(() => acknowledge('b-1', 5, null)).not.toThrow()
    expect(wasAcknowledged('b-1', 5, null)).toBe(false)
  })
})
