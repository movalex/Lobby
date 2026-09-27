// Pure keyboard predicates (no DOM, no editor): type-to-edit on a selected note (COL-04), the
// Ctrl/Cmd+F board-search intercept (MAK-12), Enter to rename a selected frame (RETRO-14) and
// Space-to-pan from a clicked button (F3).
//
// COL-04 decision: typing APPENDS. With exactly one unlocked note selected (and nothing being edited),
// a printable key starts editing that note with the caret at the end of its text and inserts the
// character there. It never replaces: a stray keystroke cannot wipe a note (Enter still selects all
// text, so "Enter, then type" is the replace gesture). Excluded so their shortcuts keep working:
// Space (hold to pan), [ and ] (send to back / bring to front), and any Ctrl/Cmd/Alt chord (AltGr
// characters such as @ on German layouts still type). Single-key tool shortcuts (N, T, L, P, …) work as
// usual whenever nothing, several shapes, or a non-note is selected.
//
// RETRO-02 exception: the note left selected by FINISHING an edit (Esc) is not typed into. Right after
// an edit the next key is a command, not more text: "N, click, type, Esc, N" must give a second note,
// not an "n" appended to the first. While that note is still the only selection, tool keys (N, T, F,
// L, …) switch tools and Enter re-edits it (COL-02, tldraw's own Enter). The exception ends as soon as
// the selection changes or the note is clicked or selected again; type-to-edit then applies as above.

export interface KeyEventLike {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey?: boolean
  isComposing?: boolean
  /** KeyboardEvent.getModifierState('AltGraph'): Windows reports AltGr as Ctrl+Alt. */
  altGraph?: boolean
}

const NOT_TYPING = new Set([' ', '[', ']'])

/** A key press that produces one printable character (not a shortcut chord, not a named key). */
export function isTypeToEditKey(e: KeyEventLike): boolean {
  if (e.isComposing) return false
  if (e.metaKey) return false
  if ((e.ctrlKey || e.altKey) && !e.altGraph) return false
  const k = e.key
  if (typeof k !== 'string' || [...k].length !== 1) return false // 'Enter', 'ArrowUp', 'Dead', 'Process'…
  if (NOT_TYPING.has(k)) return false
  if (/\p{C}/u.test(k)) return false // control / format characters
  return true
}

/**
 * A key that types one character into whatever text field has the keyboard (Space included): what the
 * pending buffers hold while a note's or frame's text field is not ready yet.
 */
export function isPrintableKey(e: KeyEventLike): boolean {
  if (e.isComposing || e.metaKey) return false
  if ((e.ctrlKey || e.altKey) && !e.altGraph) return false
  const k = e.key
  return typeof k === 'string' && [...k].length === 1 && !/\p{C}/u.test(k)
}

export interface SelectionLike {
  type: string
  /** The shape or one of its ancestors is locked. */
  locked: boolean
}

export interface TypeToEditState {
  selected: readonly SelectionLike[]
  /** editor.isIn('select.idle') */
  isIdle: boolean
  /** editor.getEditingShapeId() !== null */
  isEditing: boolean
  isReadonly: boolean
  menusOpen: boolean
  /** The key event targets a text field (input, textarea, contenteditable): never steal it. */
  targetIsTextField: boolean
  /**
   * RETRO-02: the only selected note is the one whose editing just ended (Esc), and it has not been
   * clicked or re-selected since. Type-to-edit does not fire for it.
   */
  justLeftEditing?: boolean
}

export function shouldTypeToEdit(e: KeyEventLike, s: TypeToEditState): boolean {
  if (!isTypeToEditKey(e)) return false
  if (s.targetIsTextField || s.isEditing || s.isReadonly || s.menusOpen || !s.isIdle) return false
  if (s.selected.length !== 1 || s.justLeftEditing) return false
  const only = s.selected[0]
  return only?.type === 'note' && !only.locked
}

/**
 * RETRO-14: Enter (no modifiers) with exactly one unlocked frame selected starts renaming it. tldraw
 * 5.4.2 renames a frame only from a double-click on its heading (FrameShapeUtil.canEdit refuses
 * 'press_enter'), so Enter did nothing.
 */
export function shouldRenameFrame(e: KeyEventLike, s: TypeToEditState): boolean {
  if (e.key !== 'Enter' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  if (s.targetIsTextField || s.isEditing || s.isReadonly || s.menusOpen || !s.isIdle) return false
  if (s.selected.length !== 1) return false
  const only = s.selected[0]
  return only?.type === 'frame' && !only.locked
}

export interface FocusedControlLike {
  /** document.activeElement is a <button> or [role=button]. */
  isButton: boolean
  /** It is a text field (input, textarea, contenteditable). */
  isTextField: boolean
  /**
   * The user reached it with keyboard navigation (Tab, arrow keys), not a click or a dialog handing the
   * focus back. (:focus-visible cannot tell: Chrome turns it on for a clicked button at the first key.)
   */
  focusedByKeyboard: boolean
  menusOpen: boolean
  modalOpen: boolean
}

/**
 * F3: a plain Space press while a button the user CLICKED still has the focus (a toolbar tool, zoom
 * in, the top bar's Export after its dialog was closed with the mouse) starts Space+drag panning; it
 * does not press the button. tldraw's elementShouldCaptureKeys lets a focused <button> swallow keys, so
 * the editor never saw Space and the drag moved the selected shapes instead. A button reached with
 * keyboard navigation keeps Space as well as Enter and Tab; menus and dialogs keep their keys.
 */
export function shouldRedirectSpaceToBoard(e: KeyEventLike, f: FocusedControlLike): boolean {
  if (e.key !== ' ' && e.code !== 'Space') return false
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return false
  return f.isButton && !f.isTextField && !f.focusedByKeyboard && !f.menusOpen && !f.modalOpen
}

/** Ctrl/Cmd+F (no Shift/Alt): board search instead of the browser's find. Layout-independent via `code`. */
export function isBoardSearchKey(e: KeyEventLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing) return false
  return e.key?.toLowerCase() === 'f' || (!/^[\x20-\x7e]$/.test(e.key ?? '') && e.code === 'KeyF')
}
