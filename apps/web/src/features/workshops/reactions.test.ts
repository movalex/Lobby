import { describe, expect, it } from 'vitest'
import {
  addBurst,
  BURST_MS,
  type Burst,
  CURSOR_BURST_OFFSET,
  MAX_BURSTS,
  placeBurst,
  ReactionThrottle,
} from './reactions.ts'

const view = { width: 1000, height: 700 }
const base = {
  mine: false,
  cursor: { x: 400, y: 300 },
  viewport: view,
  cursorsHidden: false,
  presenting: false,
  laneX: 900,
  jitter: 0.5,
}

describe('placeBurst', () => {
  it('near the sender’s cursor when this person can see it (just above the pointer’s tip)', () => {
    expect(placeBurst(base)).toEqual({
      kind: 'cursor',
      x: 400 + CURSOR_BURST_OFFSET.x,
      y: 300 + CURSOR_BURST_OFFSET.y,
    })
  })

  it('in the top lane otherwise: own reactions, hidden cursors, presenting, no or edge cursor', () => {
    const top = { kind: 'top', x: 900, y: 18 }
    expect(placeBurst({ ...base, mine: true })).toEqual(top)
    expect(placeBurst({ ...base, cursorsHidden: true })).toEqual(top)
    expect(placeBurst({ ...base, presenting: true })).toEqual(top)
    expect(placeBurst({ ...base, cursor: null })).toEqual(top)
    expect(placeBurst({ ...base, cursor: { x: 5, y: 300 } })).toEqual(top)
    expect(placeBurst({ ...base, cursor: { x: 400, y: 699 } })).toEqual(top)
    expect(placeBurst({ ...base, cursor: { x: -50, y: 300 } })).toEqual(top)
    expect(placeBurst({ ...base, cursor: { x: 400, y: 40 } })).toEqual(top) // up by the top bar
  })

  it('spreads the lane with the jitter, stays on screen, and has a default when the button is hidden', () => {
    const xs = [0, 0.25, 0.5, 0.75, 1].map((jitter) => placeBurst({ ...base, mine: true, jitter }).x)
    expect(new Set(xs).size).toBe(5)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(72)
    expect(placeBurst({ ...base, mine: true, laneX: 995, jitter: 1 }).x).toBeLessThanOrEqual(view.width - 28)
    expect(placeBurst({ ...base, mine: true, laneX: null }).x).toBe(view.width - 120)
  })
})

const burst = (id: number, at: number): Burst => ({
  id,
  userId: 'usr_aaaaaaaaaaaa',
  name: 'A',
  emoji: '👍',
  mine: false,
  at,
  placement: { kind: 'top', x: 1, y: 1 },
})

describe('addBurst', () => {
  it('drops finished bursts and keeps at most MAX_BURSTS (the newest)', () => {
    let list: Burst[] = []
    list = addBurst(list, burst(1, 0), 0)
    list = addBurst(list, burst(2, BURST_MS - 1), BURST_MS - 1)
    expect(list.map((b) => b.id)).toEqual([1, 2])
    list = addBurst(list, burst(3, BURST_MS), BURST_MS)
    expect(list.map((b) => b.id)).toEqual([2, 3])
    for (let i = 4; i < 4 + MAX_BURSTS; i++) list = addBurst(list, burst(i, BURST_MS), BURST_MS)
    expect(list).toHaveLength(MAX_BURSTS)
    expect(list.at(-1)?.id).toBe(3 + MAX_BURSTS)
  })
})

describe('ReactionThrottle (the server’s limit, before sending)', () => {
  it('five a second', () => {
    const t = new ReactionThrottle()
    expect([0, 1, 2, 3, 4, 5].map((ms) => t.tryTake(ms))).toEqual([true, true, true, true, true, false])
    expect(t.tryTake(999)).toBe(false)
    expect(t.tryTake(1000)).toBe(true)
  })
})
