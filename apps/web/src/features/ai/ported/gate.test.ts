// K7-1, K7-3: when the AI tools that build on the board are offered (./gate.ts): hidden when AI is off for the
// board, when the person may not add to it, when they cannot edit, and when the budget is spent.
import type { AiStatus } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { budgetSpent, canBuildWithAi } from './gate.ts'

const ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: null,
}
const budget = (usedPercent: number) => ({ usedPercent, resetsAt: '2026-10-09T00:00:00.000Z' })

describe('canBuildWithAi', () => {
  it('is offered when AI is on, may add and has budget', () => {
    expect(canBuildWithAi(ON, false)).toBe(true)
    expect(canBuildWithAi({ ...ON, budget: budget(79) }, false)).toBe(true)
    expect(canBuildWithAi({ ...ON, budget: budget(99) }, false)).toBe(true)
  })

  it('is hidden when the status is not known yet or AI is off for the board', () => {
    expect(canBuildWithAi(null, false)).toBe(false)
    expect(canBuildWithAi(undefined, false)).toBe(false)
    expect(canBuildWithAi({ ...ON, enabled: false, reason: 'board-off' }, false)).toBe(false)
    expect(canBuildWithAi({ ...ON, enabled: false, reason: 'turned-off' }, false)).toBe(false)
    expect(canBuildWithAi({ ...ON, enabled: false, reason: 'guest' }, false)).toBe(false)
  })

  it('is hidden for someone who may only summarize, or who cannot edit', () => {
    expect(canBuildWithAi({ ...ON, canInsert: false }, false)).toBe(false)
    expect(canBuildWithAi(ON, true)).toBe(false)
  })

  it('is hidden when the day’s budget is spent', () => {
    expect(budgetSpent({ ...ON, budget: budget(100) })).toBe(true)
    expect(canBuildWithAi({ ...ON, budget: budget(100) }, false)).toBe(false)
    expect(budgetSpent(ON)).toBe(false)
    expect(budgetSpent(null)).toBe(false)
  })
})
