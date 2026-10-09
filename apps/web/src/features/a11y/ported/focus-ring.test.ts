import { describe, expect, it } from 'vitest'
import {
  isRealMove,
  keyboardIntent,
  nextRing,
  RING_START,
  type RingInput,
  type RingState,
} from './focus-ring.ts'

const run = (inputs: readonly RingInput[], from: RingState = RING_START): RingState =>
  inputs.reduce(nextRing, from)

/** A note edit: the focus goes into the editor (not the board), keys are typed there, Escape, the focus comes back. */
const editAndEscape: readonly RingInput[] = [
  { type: 'focus', onBoard: false },
  { type: 'key', key: 'H', inTextEntry: true },
  { type: 'key', key: 'i', inTextEntry: true },
  { type: 'key', key: 'Enter', inTextEntry: true },
  { type: 'key', key: 'Escape', inTextEntry: true },
  { type: 'focus', onBoard: true },
]

describe('the board focus ring (K2-1, UXD-05)', () => {
  it('pointer, then an edit, then Escape: the ring stays hidden', () => {
    const s = run([{ type: 'pointerdown' }, { type: 'focus', onBoard: true }, ...editAndEscape])
    expect(s.ring).toBe(false)
    expect(s.modality).toBe('pointer')
  })

  it('the page opening with the focus on the board shows no ring, nor does typing into a note opened by the pointer', () => {
    expect(run([{ type: 'focus', onBoard: true }]).ring).toBe(false)
    expect(run([{ type: 'focus', onBoard: true }, { type: 'pointerdown' }, ...editAndEscape]).ring).toBe(
      false,
    )
  })

  it('K.1 (WCAG 2.4.7): after a click, any key that acts on the board shows the ring at once (native :focus-visible)', () => {
    const clicked = run([{ type: 'pointerdown' }, { type: 'focus', onBoard: true }])
    expect(clicked.ring).toBe(false)
    // a tool's letter, an arrow (a nudge), Delete, Enter (edit), Space: the keyboard acts on the board
    for (const key of ['n', 'ArrowRight', 'Delete', 'Enter', ' ', 'PageDown'])
      expect(nextRing(clicked, { type: 'key', key, onBoard: true }), key).toMatchObject({
        modality: 'keyboard',
        ring: true,
      })
    // pressed elsewhere (a panel button has the focus): the keyboard is the last input, no ring until the board has it
    const elsewhere = nextRing(clicked, { type: 'key', key: 'ArrowDown', onBoard: false })
    expect(elsewhere).toEqual({ modality: 'keyboard', ring: false })
    expect(nextRing(elsewhere, { type: 'focus', onBoard: true }).ring).toBe(true)
  })

  it('K.1: Escape, a modifier alone and Ctrl/Meta/Alt chords are not keyboard intent (a pointer user keeps no ring)', () => {
    const clicked = run([{ type: 'pointerdown' }, { type: 'focus', onBoard: true }])
    for (const k of [
      { key: 'Escape' },
      { key: 'Shift' },
      { key: 'Control' },
      { key: 'AltGraph' },
      { key: 'Meta' },
      { key: 'z', ctrl: true },
      { key: 'c', meta: true },
      { key: 'Dead' },
      { key: 'Process' },
    ])
      expect(nextRing(clicked, { type: 'key', ...k, onBoard: true }), JSON.stringify(k)).toBe(clicked)
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

  it('K.1: keyboard intent is any key that moves the focus or acts; typing in a field counts only for Tab and F6', () => {
    for (const key of ['Tab', 'F6', 'Enter', 'a', 'ArrowRight', ' ', 'Delete', 'Backspace', 'Home', 'F2'])
      expect(keyboardIntent({ key }), key).toBe(true)
    for (const key of ['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified', ''])
      expect(keyboardIntent({ key }), key).toBe(false)
    expect(keyboardIntent({ key: 'z', ctrl: true })).toBe(false)
    expect(keyboardIntent({ key: 'Tab', alt: true })).toBe(false)
    // Shift alone is not a chord: Shift+Tab moves the focus, a capital letter is a key
    expect(keyboardIntent({ key: 'Tab' })).toBe(true)
    // in a text field (the note editor, a search box) typing is not intent; Tab and F6 still leave it
    for (const key of ['a', 'Enter', 'Backspace', 'ArrowLeft', ' '])
      expect(keyboardIntent({ key, inTextEntry: true }), key).toBe(false)
    expect(keyboardIntent({ key: 'Tab', inTextEntry: true })).toBe(true)
    expect(keyboardIntent({ key: 'F6', inTextEntry: true })).toBe(true)
  })
})

describe('K.1 refix: keys that open a text entry, and key repeats (pointer users keep no ring)', () => {
  const clicked: readonly RingInput[] = [{ type: 'pointerdown' }, { type: 'focus', onBoard: true }]
  /** the key opened a text entry (cursor chat's composer, a note's editor): typed into, then closed */
  const intoEntryAndBack = (close: string): readonly RingInput[] => [
    { type: 'leave' },
    { type: 'focus', onBoard: false, textEntry: true },
    { type: 'key', key: 'h', inTextEntry: true },
    { type: 'key', key: 'i', inTextEntry: true },
    { type: 'key', key: close, inTextEntry: true },
    { type: 'focus', onBoard: true },
  ]

  it('cursor chat by a pointer user: "/", a message, Enter, the focus back on the board: no ring', () => {
    const s = run([...clicked, { type: 'key', key: '/', onBoard: true }, ...intoEntryAndBack('Enter')])
    expect(s).toMatchObject({ modality: 'pointer', ring: false })
  })

  it('type-to-edit by a pointer user: click a note, type (its first letters open the editor), Escape: no ring', () => {
    const s = run([
      ...clicked,
      { type: 'key', key: 'H', onBoard: true },
      { type: 'key', key: 'e', onBoard: true }, // typed before the editor (its lease) opened
      ...intoEntryAndBack('Escape'),
    ])
    expect(s).toMatchObject({ modality: 'pointer', ring: false })
  })

  it('a keyboard user who types to edit gets the ring back; a letter that opens nothing still shows it', () => {
    const tabbed: readonly RingInput[] = [
      { type: 'key', key: 'Tab' },
      { type: 'focus', onBoard: true },
    ]
    expect(
      run([...tabbed, { type: 'key', key: 'H', onBoard: true }, ...intoEntryAndBack('Escape')]).ring,
    ).toBe(true)
    expect(run([...clicked, { type: 'key', key: 'r', onBoard: true }])).toMatchObject({
      modality: 'keyboard',
      ring: true,
    })
    // Enter (not typing) to edit is the keyboard acting: the ring after Escape, as before
    expect(
      run([...clicked, { type: 'key', key: 'Enter', onBoard: true }, ...intoEntryAndBack('Escape')]).ring,
    ).toBe(true)
  })

  it('Space held while dragging to pan: its key repeats do not flicker the ring', () => {
    let s = run(clicked)
    s = nextRing(s, { type: 'key', key: ' ', onBoard: true })
    const trace: boolean[] = []
    s = nextRing(s, { type: 'pointerdown' })
    trace.push(s.ring)
    for (let i = 0; i < 4; i++) {
      s = nextRing(s, { type: 'pointermove', moved: true })
      trace.push(s.ring)
      s = nextRing(s, { type: 'key', key: ' ', onBoard: true, repeat: true })
      trace.push(s.ring)
    }
    expect(trace.every((r) => r === false)).toBe(true)
    expect(s.modality).toBe('pointer')
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
