// G2: PATCH /api/boards/:bid/review-links/:id changes whether people can join an existing link with just a
// name, and nothing else. The body is strict, so a request that tries to change the link's role, expiry or
// use cap is refused rather than ignored (a stale or forged client cannot widen a link through it).
import { describe, expect, it } from 'vitest'
import { ReviewLinkUpdated, UpdateReviewLinkInput } from './dashboard.ts'

describe('UpdateReviewLinkInput / ReviewLinkUpdated (G2)', () => {
  it('takes exactly { allowGuests: boolean }', () => {
    expect(UpdateReviewLinkInput.parse({ allowGuests: true })).toEqual({ allowGuests: true })
    expect(UpdateReviewLinkInput.parse({ allowGuests: false })).toEqual({ allowGuests: false })
    for (const bad of [
      {},
      { allowGuests: 'true' },
      { allowGuests: null },
      { allowGuests: 1 },
      { allowGuests: true, role: 'editor' },
      { allowGuests: true, expiresInHours: 24 },
      { allowGuests: true, maxUses: 5 },
      { role: 'editor' },
      null,
      'allowGuests',
    ])
      expect(UpdateReviewLinkInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('answers the flag the link has now', () => {
    expect(ReviewLinkUpdated.parse({ allowGuests: true })).toEqual({ allowGuests: true })
    expect(ReviewLinkUpdated.safeParse({}).success).toBe(false)
  })
})
