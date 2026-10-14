// Wave P review (P-005): the text lease's messages name the element's kind, not "this note" for everything.
import { describe, expect, it } from 'vitest'
import { didNotOpenTyped, editingNow, leaseThingOf, opening, typingIn } from './words.ts'

describe('lease words', () => {
  it('name the kind of the lease’s element', () => {
    expect(leaseThingOf({ type: 'stickynote' })).toBe('note')
    expect(leaseThingOf({ type: 'rectangle' })).toBe('shape')
    expect(leaseThingOf({ type: 'ellipse' })).toBe('shape')
    expect(leaseThingOf({ type: 'diamond' })).toBe('shape')
    expect(leaseThingOf({ type: 'arrow' })).toBe('connector')
    expect(leaseThingOf({ type: 'text' })).toBe('text')
    // not on this tab (yet): the note's words, as before
    expect(leaseThingOf(undefined)).toBe('note')
  })

  it('say it in every message', () => {
    expect(typingIn('Dana', 'shape')).toBe('Dana is typing in this shape')
    expect(editingNow('Dana', 'text')).toBe('Not saved — Dana is editing this text now')
    expect(didNotOpenTyped('connector')).toBe('The connector did not open, so what you typed was not saved.')
    expect(opening('note', 0)).toBe('Opening the note… (Esc cancels)')
    expect(opening('shape', 3)).toBe('Opening the shape… (3 typed, Esc cancels)')
  })
})
