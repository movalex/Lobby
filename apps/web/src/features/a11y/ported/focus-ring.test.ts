import { describe, expect, it } from 'vitest'
import { isRealMove, movesFocus, nextRing, RING_START, type RingInput, type RingState } from './focus-ring.ts'

const run = (inputs: readonly RingInput[], from: RingState = RING_START): RingState =>
  inputs.reduce(nextRing, from)

/** A note edit: the focus goes into the editor (not the board), keys are typed, Escape, the focus comes back. */
const editAndEscape: readonly RingInput[] = [
  { type: 'focus', onBoard: false },
  { type: 'key', key: 'H' },
  { type: 'key', key: 'i' },
  { type: 'key', key: 'Enter' },
  { type: 'key', key: 'Escape' },
  { type: 'focus', onBoard: true },
]

describe('the board focus ring (K2-1, UXD-05)', () => {
  it('pointer, then an edit, then Escape: the ring stays hidden', () => {
    const s = run([{ type: 'pointerdown' }, { type: 'focus', onBoard: true }, ...editAndEscape])
    expect(s.ring).toBe(false)
    expect(s.modality).toBe('pointer')
  })

  it('the page opening with the focus on the board shows no ring, nor does typing on it then', () => {
    expect(run([{ type: 'focus', onBoard: true }]).ring).toBe(false)
    expect(run([{ type: 'focus', onBoard: true }, { type: 'key', key: 'n' }, ...editAndEscape]).ring).toBe(
      false,
    )
  })

  it('Tab or Shift+Tab to the board shows it', () => {
    expect(
      run([{ type: 'pointerdown' }, { type: 'key', key: 'Tab' }, { type: 'focus', onBoard: true }]).ring,
    ).toBe(true)
  })

  it('F6 to the board shows it', () => {
    expect(
      run([{ type: 'pointerdown' }, { type: 'key', key: 'F6' }, { type: 'focus', onBoard: true }]).ring,
    ).toBe(true)
  })

  it('the skip link (or the F6 command on a board that already had the focus) shows it, after a pointer too', () => {
    expect(run([{ type: 'pointerdown' }, { type: 'enter', onBoard: true }]).ring).toBe(true)
    // the entry did not reach the board (a modal kept the keyboard): no ring, but the keyboard is the last input
    const s = run([{ type: 'pointerdown' }, { type: 'enter', onBoard: false }])
    expect(s).toEqual({ modality: 'keyboard', ring: false })
  })

  it('Tab to the board, an edit, Escape: the ring comes back (the keyboard brought it there)', () => {
    const s = run([{ type: 'key', key: 'Tab' }, { type: 'focus', onBoard: true }, ...editAndEscape])
    expect(s.ring).toBe(true)
  })

  it('once the ring shows, the next pointer move hides it; a pointerdown does too', () => {
    const shown = run([
      { type: 'key', key: 'Tab' },
      { type: 'focus', onBoard: true },
    ])
    expect(shown.ring).toBe(true)
    const moved = nextRing(shown, { type: 'pointermove', moved: true })
    expect(moved).toEqual({ modality: 'pointer', ring: false })
    // and Escape out of a later edit does not bring it back
    expect(run(editAndEscape, moved).ring).toBe(false)
    expect(nextRing(shown, { type: 'pointerdown' }).ring).toBe(false)
  })

  it('an event at the position the pointer already had is not a move', () => {
    const shown = run([
      { type: 'key', key: 'F6' },
      { type: 'focus', onBoard: true },
    ])
    expect(nextRing(shown, { type: 'pointermove', moved: false })).toBe(shown)
  })

  it('the focus leaving the board, or landing elsewhere, hides it', () => {
    const shown = run([
      { type: 'key', key: 'Tab' },
      { type: 'focus', onBoard: true },
    ])
    expect(nextRing(shown, { type: 'leave' }).ring).toBe(false)
    expect(nextRing(shown, { type: 'focus', onBoard: false }).ring).toBe(false)
  })

  it('only the keys that move the focus count: Tab and F6, not typing, Escape or arrows', () => {
    for (const k of ['Tab', 'F6']) expect(movesFocus(k)).toBe(true)
    for (const k of ['Escape', 'Enter', 'a', 'ArrowRight', ' ', 'Shift', 'Delete'])
      expect(movesFocus(k)).toBe(false)
  })
})

describe('isRealMove', () => {
  it('a reported movement is a move', () => {
    expect(isRealMove(null, { clientX: 5, clientY: 5, movementX: 2, movementY: 0 })).toBe(true)
  })
  it('a new position is a move; the same one, or an unknown last one, is not', () => {
    expect(isRealMove({ x: 1, y: 1 }, { clientX: 2, clientY: 1 })).toBe(true)
    expect(isRealMove({ x: 1, y: 1 }, { clientX: 1, clientY: 1, movementX: 0, movementY: 0 })).toBe(false)
    expect(isRealMove(null, { clientX: 1, clientY: 1 })).toBe(false)
  })
})
