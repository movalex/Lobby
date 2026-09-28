import { describe, expect, it } from 'vitest'
import { composerAfterAnswer, composerOnSubmit } from './composer.ts'

describe('the "Add note" composer never loses typed text (round-2 F6)', () => {
  it('empties the box the moment a note is sent, so the next idea can be typed while it saves', () => {
    expect(composerOnSubmit('first idea')).toBe('')
  })

  it('keeps whatever was typed while the note was saving, whether the save worked or not', () => {
    // Saved: the box holds the next idea, untouched.
    expect(composerAfterAnswer({ current: 'second idea', submitted: 'first idea', ok: true })).toBe(
      'second idea',
    )
    expect(composerAfterAnswer({ current: '', submitted: 'first idea', ok: true })).toBe('')
    // Refused with nothing typed since: the note comes back as it was, to try again.
    expect(composerAfterAnswer({ current: '', submitted: 'first idea', ok: false })).toBe('first idea')
    expect(composerAfterAnswer({ current: '  \n', submitted: 'first idea', ok: false })).toBe('first idea')
    // Refused after typing more: neither text is lost (the refused one first).
    expect(composerAfterAnswer({ current: 'second idea', submitted: 'first idea', ok: false })).toBe(
      'first idea\n\nsecond idea',
    )
  })
})
