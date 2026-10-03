// R2-10: revealed vote badges keep a minimum size on screen at overview zoom.
import { describe, expect, it } from 'vitest'
import { badgeScale } from '../voting.ts'
import { MIN_BADGE_TEXT_PX, resultBadgeScale } from './WorkshopOverlay.tsx'

describe('result badges at overview zoom (R2-10)', () => {
  it('are full size from 100 % zoom, as before', () => {
    for (const zoom of [1, 2, 8]) expect(resultBadgeScale(zoom)).toBe(1)
  })

  it('shrink with the zoom but never below what keeps the figure at MIN_BADGE_TEXT_PX (13 px at full size)', () => {
    for (const zoom of [0.9, 0.6, 0.3, 0.1, 0.01]) {
      expect(resultBadgeScale(zoom), `zoom ${zoom}`).toBeGreaterThanOrEqual(MIN_BADGE_TEXT_PX / 13 - 1e-9)
      expect(13 * resultBadgeScale(zoom), `zoom ${zoom}`).toBeGreaterThanOrEqual(MIN_BADGE_TEXT_PX - 1e-9)
    }
    // the old rule let them fall to 60 % (a 7.8 px figure)
    expect(badgeScale(0.1)).toBe(0.6)
    expect(resultBadgeScale(0.1)).toBeGreaterThan(badgeScale(0.1))
  })

  it('never grows past full size and follows the zoom in between', () => {
    expect(resultBadgeScale(0.95)).toBe(0.95)
    for (const zoom of [0.01, 0.5, 0.9, 1, 4]) expect(resultBadgeScale(zoom)).toBeLessThanOrEqual(1)
  })
})
