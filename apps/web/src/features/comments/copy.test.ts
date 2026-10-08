// K2-6 (wave K, UXP-8, UXD-15): the comments' copy is pointer-aware, checked with a matchMedia stub, and makes
// no promise about email.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { coarsePointer, composerHint, emptyPanelText, NOTIFICATIONS_NOTE } from './copy.ts'

const stubPointer = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : false }))

afterEach(() => vi.unstubAllGlobals())

describe('pointer-aware comment copy (K2-6)', () => {
  it('reads the primary pointer from matchMedia', () => {
    stubPointer(true)
    expect(coarsePointer()).toBe(true)
    stubPointer(false)
    expect(coarsePointer()).toBe(false)
  })

  it('a browser without matchMedia, or one that throws, is a fine pointer', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(coarsePointer()).toBe(false)
    vi.stubGlobal('matchMedia', () => {
      throw new Error('blocked')
    })
    expect(coarsePointer()).toBe(false)
  })

  it('on (pointer: coarse) there is no "Press C" or "Shift+Enter"', () => {
    stubPointer(true)
    const coarse = coarsePointer()
    const empty = emptyPanelText({ coarse, canComment: true })
    const hint = composerHint(coarse)
    for (const s of [empty, hint]) {
      expect(s).not.toMatch(/Press C/)
      expect(s).not.toMatch(/Shift\+Enter/)
      expect(s).not.toMatch(/\bclick\b/i)
    }
    expect(empty).toMatch(/Tap the comment button/)
    expect(hint).toBe('@ to mention')
  })

  it('a mouse and keyboard keep the keys', () => {
    stubPointer(false)
    const coarse = coarsePointer()
    expect(emptyPanelText({ coarse, canComment: true })).toMatch(/Press C/)
    expect(composerHint(coarse)).toMatch(/Shift\+Enter for a new line/)
  })

  it('someone who cannot comment is told only that there are none', () => {
    expect(emptyPanelText({ coarse: true, canComment: false })).toBe('No comments yet.')
    expect(emptyPanelText({ coarse: false, canComment: false })).toBe('No comments yet.')
  })

  it('the notifications note no longer says email is "not available yet"', () => {
    expect(NOTIFICATIONS_NOTE).not.toMatch(/available yet/i)
    expect(NOTIFICATIONS_NOTE).not.toMatch(/email/i)
  })
})
