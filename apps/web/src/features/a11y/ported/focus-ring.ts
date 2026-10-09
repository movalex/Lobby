// K2-1 (wave K, UXD-05): when the board's focus ring (./FocusRing.tsx, W5-45) shows. Pure (Node-tested);
// ./index.tsx feeds it the page's events.
//
// The ring shows while the board has the keyboard focus AND the keyboard is the last input that moved the focus or
// acted. Before wave K every key counted as "the keyboard": a mouse user who clicked a note, typed in it and
// pressed Escape got the ring around the whole canvas after every edit (the typing and the Escape were keys).
// K2-1 then counted only Tab, Shift+Tab and F6, which left a keyboard user who clicked once and then worked by
// hotkeys or arrows without a ring (WCAG 2.4.7). Wave K.1 follows the native `:focus-visible` rule instead: any
// key that moves the focus or acts makes the keyboard the last input, and shows the ring at once when the board
// has the focus. What does not count (`keyboardIntent`):
//  - Escape (closing an editor or a menu is not a move: a pointer user's Escape out of a note keeps no ring);
//  - a modifier on its own (Shift, Ctrl, Alt, Meta, AltGr, the locks), dead keys and IME composition keys;
//  - a chord with Ctrl, Meta or Alt (the browser's and the board's shortcuts; native :focus-visible ignores them too);
//  - keys typed into a text field or the note editor (typing, Enter and Backspace in the words).
// So:
//  - pointer, edit, type, Escape: no ring (the last input that moved anything was the pointer);
//  - pointer, then an arrow, Delete, Enter or a tool's letter on the board: the ring (the keyboard acts);
//  - Tab or F6 to the board, Enter to edit, type, Escape: the ring again (the keyboard brought it there);
//  - a press of the pointer, or a real move of it, hides the ring and makes the pointer the last input.

/** The last input that can move the keyboard focus: nothing yet (the page just opened), a pointer or the keyboard. */
export type Modality = 'none' | 'pointer' | 'keyboard'

export interface RingState {
  readonly modality: Modality
  /** The ring is drawn. */
  readonly ring: boolean
}

export const RING_START: RingState = Object.freeze({ modality: 'none', ring: false })

export type RingInput =
  /** A pointer pressed anywhere on the page. */
  | { readonly type: 'pointerdown' }
  /** A pointer moved; `moved` is false for an event at the position the pointer already had. */
  | { readonly type: 'pointermove'; readonly moved: boolean }
  /**
   * A trusted key press anywhere on the page: KeyboardEvent.key, its Ctrl, Meta and Alt, whether it went into a
   * text field (`inTextEntry`) and whether the board's canvas has the focus (`onBoard`).
   */
  | {
      readonly type: 'key'
      readonly key: string
      readonly ctrl?: boolean
      readonly meta?: boolean
      readonly alt?: boolean
      readonly inTextEntry?: boolean
      readonly onBoard?: boolean
    }
  /** The focus arrived on an element; `onBoard`: the board's focusable canvas (not its text editor). */
  | { readonly type: 'focus'; readonly onBoard: boolean }
  /** The focus left the board's canvas. */
  | { readonly type: 'leave' }
  /** The keyboard was brought to the board on purpose (F6, "Skip to canvas"); `onBoard`: it has the focus now. */
  | { readonly type: 'enter'; readonly onBoard: boolean }

/** Keys that neither move the focus nor act on their own (KeyboardEvent.key values), and Escape. */
const NOT_INTENT: ReadonlySet<string> = new Set([
  'Escape',
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Hyper',
  'Super',
  'Fn',
  'FnLock',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Symbol',
  'SymbolLock',
  'Dead',
  'Process',
  'Compose',
  'Unidentified',
])

/**
 * Whether a key press makes the keyboard the last input (native :focus-visible semantics, see the header): any key
 * that moves the focus or acts, not Escape, not a modifier alone, not a Ctrl, Meta or Alt chord, not typing.
 */
export function keyboardIntent(k: {
  readonly key: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly alt?: boolean
  readonly inTextEntry?: boolean
}): boolean {
  if (!k.key || NOT_INTENT.has(k.key)) return false
  if (k.ctrl || k.meta || k.alt) return false
  // Tab leaves a field too (it moves the focus); every other key in a field is typing
  if (k.inTextEntry) return k.key === 'Tab' || k.key === 'F6'
  return true
}

export function nextRing(s: RingState, input: RingInput): RingState {
  switch (input.type) {
    case 'pointerdown':
      return s.modality === 'pointer' && !s.ring ? s : { modality: 'pointer', ring: false }
    case 'pointermove':
      if (!input.moved) return s
      return s.modality === 'pointer' && !s.ring ? s : { modality: 'pointer', ring: false }
    case 'key': {
      if (!keyboardIntent(input)) return s
      // the board has the focus: the keyboard acting on it shows the ring now (as :focus-visible would)
      const ring = s.ring || input.onBoard === true
      return s.modality === 'keyboard' && ring === s.ring ? s : { modality: 'keyboard', ring }
    }
    case 'focus': {
      const ring = input.onBoard && s.modality === 'keyboard'
      return ring === s.ring ? s : { ...s, ring }
    }
    case 'leave':
      return s.ring ? { ...s, ring: false } : s
    case 'enter':
      return { modality: 'keyboard', ring: input.onBoard }
  }
}

/** A pointer position, to tell a real move from an event at the same place. */
export interface PointerAt {
  readonly x: number
  readonly y: number
}

/**
 * Whether a pointermove is a move: its position differs from the last one seen, or the browser reports a
 * movement. An event at an unknown last position is not taken as one (the next event is).
 */
export function isRealMove(
  last: PointerAt | null,
  e: {
    readonly clientX: number
    readonly clientY: number
    readonly movementX?: number
    readonly movementY?: number
  },
): boolean {
  if (e.movementX || e.movementY) return true
  if (!last) return false
  return last.x !== e.clientX || last.y !== e.clientY
}
