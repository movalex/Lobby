// Pure keyboard predicates (no DOM, no editor): type-to-edit on a selected note (COL-04) and the
// Ctrl/Cmd+F board-search intercept (MAK-12).
//
// COL-04 decision: typing APPENDS. With exactly one unlocked note selected (and nothing being edited),
// a printable key starts editing that note with the caret at the end of its text and inserts the
// character there. It never replaces: a stray keystroke cannot wipe a note (Enter still selects all
// text, so "Enter, then type" is the replace gesture). Excluded so their shortcuts keep working:
// Space (hold to pan), [ and ] (send to back / bring to front), and any Ctrl/Cmd/Alt chord (AltGr
// characters such as @ on German layouts still type). Single-key tool shortcuts (N, T, L, P, …) work as
// usual whenever nothing, several shapes, or a non-note is selected.

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
}

export function shouldTypeToEdit(e: KeyEventLike, s: TypeToEditState): boolean {
  if (!isTypeToEditKey(e)) return false
  if (s.targetIsTextField || s.isEditing || s.isReadonly || s.menusOpen || !s.isIdle) return false
  if (s.selected.length !== 1) return false
  const only = s.selected[0]
  return only?.type === 'note' && !only.locked
}

/** Ctrl/Cmd+F (no Shift/Alt): board search instead of the browser's find. Layout-independent via `code`. */
export function isBoardSearchKey(e: KeyEventLike): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.isComposing) return false
  return e.key?.toLowerCase() === 'f' || (!/^[\x20-\x7e]$/.test(e.key ?? '') && e.code === 'KeyF')
}
