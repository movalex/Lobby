// K2-6 (wave K, UXP-8, UXD-15): the comments' copy is pointer-aware, checked with a matchMedia stub; wave K.1: what it
// says about email is what the bells say (none is sent).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BELL_EMPTY as DASHBOARD_BELL_EMPTY,
  BELL_NOTE as DASHBOARD_BELL_NOTE,
} from '../../dashboard/notifications.ts'
import {
  BELL_EMPTY,
  BELL_NOTE,
  coarsePointer,
  composerHint,
  emptyPanelText,
  NOT_EMAILED,
  NOTIFICATIONS_NOTE,
} from './copy.ts'

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
  })

  it('K.1: the panel, the board bell and the dashboard bell say the same true thing about email (none is sent)', () => {
    expect(NOT_EMAILED).toBe('They are not sent by email.')
    expect(NOTIFICATIONS_NOTE.endsWith(NOT_EMAILED)).toBe(true)
    expect(BELL_NOTE.endsWith(NOT_EMAILED)).toBe(true)
    // one copy of the words: the dashboard re-exports these, and the board's bell draws them
    expect(DASHBOARD_BELL_NOTE).toBe(BELL_NOTE)
    expect(DASHBOARD_BELL_EMPTY).toBe(BELL_EMPTY)
    const bar = readFileSync(new URL('./ported/CommentsTopBar.tsx', import.meta.url), 'utf8')
    expect(bar).toContain('{BELL_NOTE}')
    expect(bar).toContain('{BELL_EMPTY}')
    expect(bar).not.toMatch(/all caught up/)
  })
})
