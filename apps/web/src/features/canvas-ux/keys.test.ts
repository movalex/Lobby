import { describe, expect, it } from 'vitest'
import {
  isBoardSearchKey,
  isTypeToEditKey,
  type KeyEventLike,
  shouldTypeToEdit,
  type TypeToEditState,
} from './keys.ts'

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})

const oneNote: TypeToEditState = {
  selected: [{ type: 'note', locked: false }],
  isIdle: true,
  isEditing: false,
  isReadonly: false,
  menusOpen: false,
  targetIsTextField: false,
}

describe('isTypeToEditKey', () => {
  it('accepts printable characters, including capitals, digits, punctuation and non-Latin text', () => {
    for (const k of ['a', 'Z', '7', '?', '-', 'é', 'ж', '😀']) expect(isTypeToEditKey(key(k))).toBe(true)
    expect(isTypeToEditKey(key('A', { shiftKey: true }))).toBe(true)
  })
  it('accepts AltGr characters (Windows reports Ctrl+Alt)', () => {
    expect(isTypeToEditKey(key('@', { ctrlKey: true, altKey: true, altGraph: true }))).toBe(true)
  })
  it('rejects named keys, chords, IME composition and keys kept for shortcuts', () => {
    for (const k of [
      'Enter',
      'Tab',
      'Escape',
      'Backspace',
      'Delete',
      'ArrowUp',
      'Dead',
      'Process',
      'F1',
      'Shift',
    ])
      expect(isTypeToEditKey(key(k))).toBe(false)
    for (const k of [' ', '[', ']']) expect(isTypeToEditKey(key(k))).toBe(false)
    expect(isTypeToEditKey(key('c', { ctrlKey: true }))).toBe(false)
    expect(isTypeToEditKey(key('d', { metaKey: true }))).toBe(false)
    expect(isTypeToEditKey(key('1', { altKey: true }))).toBe(false)
    expect(isTypeToEditKey(key('g', { ctrlKey: true, altKey: true }))).toBe(false) // Ctrl+Alt+G frames
    expect(isTypeToEditKey(key('a', { isComposing: true }))).toBe(false)
    expect(isTypeToEditKey(key('\u0007'))).toBe(false)
  })
})

describe('shouldTypeToEdit', () => {
  it('starts editing exactly one unlocked, selected note', () => {
    expect(shouldTypeToEdit(key('h'), oneNote)).toBe(true)
  })
  it('keeps single-key tool shortcuts when nothing, several, or a non-note is selected', () => {
    expect(shouldTypeToEdit(key('n'), { ...oneNote, selected: [] })).toBe(false)
    expect(
      shouldTypeToEdit(key('n'), {
        ...oneNote,
        selected: [
          { type: 'note', locked: false },
          { type: 'note', locked: false },
        ],
      }),
    ).toBe(false)
    expect(shouldTypeToEdit(key('t'), { ...oneNote, selected: [{ type: 'geo', locked: false }] })).toBe(false)
    expect(shouldTypeToEdit(key('t'), { ...oneNote, selected: [{ type: 'frame', locked: false }] })).toBe(
      false,
    )
  })
  it('never edits a locked note, a read-only board, or while something else has the keyboard', () => {
    expect(shouldTypeToEdit(key('h'), { ...oneNote, selected: [{ type: 'note', locked: true }] })).toBe(false)
    expect(shouldTypeToEdit(key('h'), { ...oneNote, isReadonly: true })).toBe(false)
    expect(shouldTypeToEdit(key('h'), { ...oneNote, isEditing: true })).toBe(false)
    expect(shouldTypeToEdit(key('h'), { ...oneNote, menusOpen: true })).toBe(false)
    expect(shouldTypeToEdit(key('h'), { ...oneNote, isIdle: false })).toBe(false)
    expect(shouldTypeToEdit(key('h'), { ...oneNote, targetIsTextField: true })).toBe(false)
  })
})

describe('isBoardSearchKey', () => {
  it('matches Ctrl+F and Cmd+F only', () => {
    expect(isBoardSearchKey(key('f', { ctrlKey: true }))).toBe(true)
    expect(isBoardSearchKey(key('F', { metaKey: true }))).toBe(true)
    expect(isBoardSearchKey(key('а', { ctrlKey: true, code: 'KeyF' }))).toBe(true) // Cyrillic layout
    expect(isBoardSearchKey(key('f'))).toBe(false)
    expect(isBoardSearchKey(key('f', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isBoardSearchKey(key('f', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(isBoardSearchKey(key('g', { ctrlKey: true, code: 'KeyF' }))).toBe(false) // Dvorak: typed g
  })
})
