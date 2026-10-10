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

  // M2-1 (FTU-6): the same, in the viewer's voice: nobody is told about themselves in the third person
  it('tells the person who ended it "You ended the presentation.", and the presenter whose it was who an owner was', () => {
    const ann = 'usr_annnnnnnnnnnn'
    const ben = 'usr_bennnnnnnnnnn'
    const stopped = { kind: 'ended', reason: 'stopped', byUserId: ann, byName: 'Ann' } as const
    expect(endedText(stopped, 'Ann', ann, ann)).toBe('You ended the presentation.')
    expect(endedText(stopped, 'Ann', ben, ann)).toBe('Ann ended the presentation.')
    expect(endedText(stopped, 'Ann')).toBe('Ann ended the presentation.')
    const owner = { kind: 'ended', reason: 'ended-by-owner', byUserId: ben, byName: 'Ben' } as const
    expect(endedText(owner, 'Ann', ben, ann)).toBe('You ended the presentation.')
    expect(endedText(owner, 'Ann', ann, ann)).toBe('Ben ended your presentation.')
    expect(endedText(owner, 'Ann', 'usr_cyyyyyyyyyyyy', ann)).toBe('Ben ended the presentation.')
    // leaving the board is nobody's "You ended"
    const left = { kind: 'ended', reason: 'presenter-left', byUserId: ann, byName: 'Ann' } as const
    expect(endedText(left, 'Ann', ann, ann)).toBe('Ann left the board, so the presentation ended.')
    expect(endedText(null, 'Ann', ann, ann)).toBe('The presentation has ended.')
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
