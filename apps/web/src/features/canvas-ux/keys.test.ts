import { describe, expect, it } from 'vitest'
import {
  CANVAS_OWN_KEYS,
  type FocusedControlLike,
  isBoardSearchKey,
  isContextMenuKey,
  isPrintableKey,
  isSelectionToolbarKey,
  isTypeToEditKey,
  type KeyEventLike,
  shouldEditNoteOnEnter,
  shouldRedirectSpaceToBoard,
  shouldRenameFrame,
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

describe('RETRO-02: the note just left with Esc', () => {
  const left: TypeToEditState = { ...oneNote, justLeftEditing: true }
  it('is not typed into: N, T, F, L… reach the tool shortcuts instead', () => {
    for (const k of ['n', 't', 'f', 'l', 'N', 'h']) expect(shouldTypeToEdit(key(k), left)).toBe(false)
  })
  it('type-to-edit applies again once the flag clears (clicked or selected again)', () => {
    expect(shouldTypeToEdit(key('n'), { ...left, justLeftEditing: false })).toBe(true)
    expect(shouldTypeToEdit(key('n'), oneNote)).toBe(true)
  })
})

describe('RETRO-14: Enter renames the one selected frame', () => {
  const oneFrame: TypeToEditState = { ...oneNote, selected: [{ type: 'frame', locked: false }] }
  it('Enter with exactly one unlocked frame selected', () => {
    expect(shouldRenameFrame(key('Enter'), oneFrame)).toBe(true)
  })
  it('not for chords, other keys, other selections, locked frames, read-only boards or while editing', () => {
    expect(shouldRenameFrame(key('Enter', { shiftKey: true }), oneFrame)).toBe(false)
    expect(shouldRenameFrame(key('Enter', { ctrlKey: true }), oneFrame)).toBe(false)
    expect(shouldRenameFrame(key('Enter', { isComposing: true }), oneFrame)).toBe(false)
    expect(shouldRenameFrame(key('a'), oneFrame)).toBe(false)
    expect(shouldRenameFrame(key('Enter'), oneNote)).toBe(false)
    expect(
      shouldRenameFrame(key('Enter'), {
        ...oneFrame,
        selected: [
          { type: 'frame', locked: false },
          { type: 'frame', locked: false },
        ],
      }),
    ).toBe(false)
    expect(
      shouldRenameFrame(key('Enter'), { ...oneFrame, selected: [{ type: 'frame', locked: true }] }),
    ).toBe(false)
    expect(shouldRenameFrame(key('Enter'), { ...oneFrame, isReadonly: true })).toBe(false)
    expect(shouldRenameFrame(key('Enter'), { ...oneFrame, isEditing: true })).toBe(false)
    expect(shouldRenameFrame(key('Enter'), { ...oneFrame, targetIsTextField: true })).toBe(false)
    expect(shouldRenameFrame(key('Enter'), { ...oneFrame, menusOpen: true })).toBe(false)
  })
})

describe('isPrintableKey (the pending buffers)', () => {
  it('holds characters and Space, not named keys or chords', () => {
    for (const k of ['a', 'Z', ' ', ':', '&', '[', 'é']) expect(isPrintableKey(key(k))).toBe(true)
    for (const k of ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowLeft'])
      expect(isPrintableKey(key(k))).toBe(false)
    expect(isPrintableKey(key('z', { ctrlKey: true }))).toBe(false)
    expect(isPrintableKey(key('@', { ctrlKey: true, altKey: true, altGraph: true }))).toBe(true)
  })
})

describe('F3: Space from a clicked button pans', () => {
  const clicked: FocusedControlLike = {
    isButton: true,
    isTextField: false,
    focusedByKeyboard: false,
    menusOpen: false,
    modalOpen: false,
  }
  it('redirects a plain Space while a clicked button has the focus', () => {
    expect(shouldRedirectSpaceToBoard(key(' ', { code: 'Space' }), clicked)).toBe(true)
  })
  it('leaves Space to buttons reached by Tab/arrows, text fields, menus, dialogs, chords and other keys', () => {
    expect(shouldRedirectSpaceToBoard(key(' '), { ...clicked, focusedByKeyboard: true })).toBe(false)
    expect(shouldRedirectSpaceToBoard(key(' '), { ...clicked, isButton: false })).toBe(false)
    expect(shouldRedirectSpaceToBoard(key(' '), { ...clicked, isTextField: true })).toBe(false)
    expect(shouldRedirectSpaceToBoard(key(' '), { ...clicked, menusOpen: true })).toBe(false)
    expect(shouldRedirectSpaceToBoard(key(' '), { ...clicked, modalOpen: true })).toBe(false)
    expect(shouldRedirectSpaceToBoard(key(' ', { shiftKey: true }), clicked)).toBe(false)
    expect(shouldRedirectSpaceToBoard(key(' ', { ctrlKey: true }), clicked)).toBe(false)
    expect(shouldRedirectSpaceToBoard(key('Enter'), clicked)).toBe(false)
    expect(shouldRedirectSpaceToBoard(key('Tab'), clicked)).toBe(false)
  })
})

describe('A11Y-12: Enter edits the one selected note (caret at the end, set in keyboard.ts)', () => {
  it('takes a plain Enter on one unlocked note, on an idle, editable board', () => {
    expect(shouldEditNoteOnEnter(key('Enter'), oneNote)).toBe(true)
    // Also right after an edit ended (RETRO-02: Enter re-edits the note just left).
    expect(shouldEditNoteOnEnter(key('Enter'), { ...oneNote, justLeftEditing: true })).toBe(true)
  })
  it('leaves chords, frames, several shapes, locked notes, menus, fields and read-only boards alone', () => {
    for (const mods of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }])
      expect(shouldEditNoteOnEnter(key('Enter', mods), oneNote)).toBe(false)
    expect(shouldEditNoteOnEnter(key('Enter', { isComposing: true }), oneNote)).toBe(false)
    expect(shouldEditNoteOnEnter(key('a'), oneNote)).toBe(false)
    const frame = { ...oneNote, selected: [{ type: 'frame', locked: false }] }
    expect(shouldEditNoteOnEnter(key('Enter'), frame)).toBe(false)
    const two = { ...oneNote, selected: [...oneNote.selected, ...oneNote.selected] }
    expect(shouldEditNoteOnEnter(key('Enter'), two)).toBe(false)
    const locked = { ...oneNote, selected: [{ type: 'note', locked: true }] }
    expect(shouldEditNoteOnEnter(key('Enter'), locked)).toBe(false)
    for (const patch of [
      { isIdle: false },
      { isEditing: true },
      { isReadonly: true },
      { menusOpen: true },
      { targetIsTextField: true },
    ])
      expect(shouldEditNoteOnEnter(key('Enter'), { ...oneNote, ...patch })).toBe(false)
  })
})

describe('A11Y-04: selection toolbar and context menu keys', () => {
  it('Alt+F10 goes to the selection toolbar; F10 alone and other chords do not', () => {
    expect(isSelectionToolbarKey(key('F10', { altKey: true }))).toBe(true)
    expect(isSelectionToolbarKey(key('Unidentified', { altKey: true, code: 'F10' }))).toBe(true)
    expect(isSelectionToolbarKey(key('F10'))).toBe(false)
    expect(isSelectionToolbarKey(key('F10', { altKey: true, shiftKey: true }))).toBe(false)
    expect(isSelectionToolbarKey(key('F10', { altKey: true, ctrlKey: true }))).toBe(false)
  })
  it('Shift+F10 and the ContextMenu key open the context menu', () => {
    expect(isContextMenuKey(key('F10', { shiftKey: true }))).toBe(true)
    expect(isContextMenuKey(key('ContextMenu'))).toBe(true)
    expect(isContextMenuKey(key('ContextMenu', { shiftKey: true }))).toBe(true)
    expect(isContextMenuKey(key('F10'))).toBe(false)
    expect(isContextMenuKey(key('F10', { shiftKey: true, altKey: true }))).toBe(false)
    expect(isContextMenuKey(key('F10', { shiftKey: true, ctrlKey: true }))).toBe(false)
  })
  it('lists the chords it takes (checked against the merged key map in keyboard-map.test.ts)', () => {
    expect(CANVAS_OWN_KEYS).toEqual(['alt+f10', 'shift+f10', 'contextmenu'])
  })
})
