// Wave L foundation: the room's contracts revision per socket (canvas.room.contractsRev()).
import { describe, expect, it } from 'vitest'
import { ContractsRevTracker } from './contracts-rev.ts'

describe('ContractsRevTracker', () => {
  it('is null until the socket’s contracts frame, then its revision; a welcome (a new socket) forgets it', () => {
    let changes = 0
    const t = new ContractsRevTracker(() => changes++)
    expect(t.get()).toBeNull()
    t.welcome()
    expect(changes).toBe(0) // still null: no change
    t.contracts(12)
    expect([t.get(), changes]).toEqual([12, 1])
    t.contracts(12)
    expect(changes).toBe(1) // the same revision again: no change
    t.welcome()
    expect([t.get(), changes]).toEqual([null, 2])
    // a rollback: the next room says 11
    t.contracts(11)
    expect([t.get(), changes]).toEqual([11, 3])
  })

  it('ignores a frame that names no positive integer revision', () => {
    const t = new ContractsRevTracker(() => {})
    for (const bad of [0, -1, 1.5, Number.NaN]) t.contracts(bad)
    expect(t.get()).toBeNull()
  })
})
