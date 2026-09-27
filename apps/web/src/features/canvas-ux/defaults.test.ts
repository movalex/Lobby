import { describe, expect, it } from 'vitest'
import { MAX_SHAPES_PER_PAGE, snapDefaultPatch } from './defaults.ts'

describe('alignment guides default (MAK-02)', () => {
  it('turns snapping on when the user never chose', () => {
    expect(snapDefaultPatch({})).toEqual({ isSnapMode: true })
    expect(snapDefaultPatch({ isSnapMode: null })).toEqual({ isSnapMode: true })
  })
  it('respects an explicit choice, on or off', () => {
    expect(snapDefaultPatch({ isSnapMode: false })).toBeNull()
    expect(snapDefaultPatch({ isSnapMode: true })).toBeNull()
  })
})

describe('shape cap (PRF-02)', () => {
  it('allows a 5,000-object board plus a 500-note paste', () => {
    expect(MAX_SHAPES_PER_PAGE).toBeGreaterThanOrEqual(10_000)
    expect(4000 + 500).toBeLessThanOrEqual(MAX_SHAPES_PER_PAGE)
  })
})
