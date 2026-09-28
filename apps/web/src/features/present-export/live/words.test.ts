import { describe, expect, it } from 'vitest'
import { endedText, followingText, namesText, startRefusedText } from './words.ts'

describe('present-live words', () => {
  it('says who ended a presentation and why', () => {
    const by = { byUserId: 'usr_annnnnnnnnnnn', byName: 'Ann' }
    expect(endedText({ kind: 'ended', reason: 'stopped', ...by }, 'Ann')).toBe('Ann ended the presentation.')
    expect(endedText({ kind: 'ended', reason: 'ended-by-owner', ...by }, 'Ben')).toBe(
      'Ann ended the presentation.',
    )
    expect(endedText({ kind: 'ended', reason: 'presenter-left', byUserId: null, byName: null }, 'Ben')).toBe(
      'Ben left the board, so the presentation ended.',
    )
    expect(endedText({ kind: 'ended', reason: null, byUserId: null, byName: null }, 'Ben')).toBe(
      'The presentation has ended.',
    )
    expect(endedText(null, null)).toBe('The presentation has ended.')
  })

  it('counts and lists followers', () => {
    expect(followingText(0)).toBe('No one following yet')
    expect(followingText(1)).toBe('1 following')
    expect(followingText(12)).toBe('12 following')
    expect(namesText(['Ann'])).toBe('Ann')
    expect(namesText(['Ann', 'Ben'])).toBe('Ann and Ben')
    expect(namesText(['Ann', 'Ben', 'Cal'])).toBe('Ann, Ben and Cal')
    expect(namesText(['Ann', 'Ben', 'Cal', 'Dee'])).toBe('Ann, Ben, Cal and 1 other')
    expect(namesText(['Ann', 'Ben'], 9)).toBe('Ann, Ben and 7 others')
    expect(namesText([], 0)).toBe('')
  })

  it('explains a refused "Present to everyone"', () => {
    expect(startRefusedText('GUEST_ACCOUNT_REQUIRED', 'x')).toMatch(/Guests can’t present to everyone/)
    expect(startRefusedText('ALREADY_PRESENTING', 'Ann is presenting.')).toBe('Ann is presenting.')
  })
})
