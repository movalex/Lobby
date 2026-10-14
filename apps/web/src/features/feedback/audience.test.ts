// P-023 (wave P): Feedback is Lobby's own (the team's). An external client, a name-only guest or an account Lobby cannot
// place at a creator domain does not see the pill or the account menu's entry; the team does, and until the person is
// known nothing is hidden (a bare unit render, a page still loading).
import { describe, expect, it } from 'vitest'
import { mayGiveFeedback } from './audience.ts'

describe('who is offered Feedback', () => {
  it('the team (an account at a creator domain) is', () => {
    expect(mayGiveFeedback('account', { creator: true })).toBe(true)
  })

  it('a name-only guest is not', () => {
    expect(mayGiveFeedback('guest', { creator: false })).toBe(false)
    expect(mayGiveFeedback('guest', null)).toBe(false)
  })

  it('an external client with an account, or one Lobby could not confirm, is not', () => {
    expect(mayGiveFeedback('account', { creator: false })).toBe(false)
  })

  it('what is not known yet hides nothing', () => {
    expect(mayGiveFeedback(null, null)).toBe(true)
    expect(mayGiveFeedback('account', null)).toBe(true)
  })
})
