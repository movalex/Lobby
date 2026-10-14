// Wave P (P-030): the wait before each look for an owner's approval of an access request.
import { describe, expect, it } from 'vitest'
import { approvalPollDelay } from './RequestAccess.tsx'

describe('looking for the approval of an access request', () => {
  it('starts at 5 s, spaces out, and never goes past 30 s', () => {
    const waits = Array.from({ length: 8 }, (_, i) => approvalPollDelay(i))
    expect(waits[0]).toBe(5_000)
    expect(waits.at(-1)).toBe(30_000)
    expect(Math.max(...waits)).toBe(30_000)
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1] ?? 0)
  })

  it('treats a nonsense attempt number as the first or the last', () => {
    expect(approvalPollDelay(-3)).toBe(5_000)
    expect(approvalPollDelay(1_000_000)).toBe(30_000)
  })
})
