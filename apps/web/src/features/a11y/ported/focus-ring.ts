// K2-1 (wave K, UXD-05): when the board's focus ring (./FocusRing.tsx, W5-45) shows. Pure (Node-tested);
// ./index.tsx feeds it the page's events.
//
// The ring shows while the board has the keyboard focus AND the keyboard brought it there. Before wave K
// every key counted as "the keyboard": a mouse user who clicked a note, typed in it and pressed Escape got the
// ring around the whole canvas after every edit (the typing and the Escape were keys). Now only the keys that
// move the focus count (Tab, Shift+Tab, F6), plus an explicit entry (the F6 command inside the board, the
// "Skip to canvas" link). Typing, Escape and every other key leave the last input as it was, so:
//  - pointer, edit, type, Escape: no ring (the last input that moved anything was the pointer);
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
  /** A trusted key press anywhere on the page (KeyboardEvent.key). */
  | { readonly type: 'key'; readonly key: string }
  /** The focus arrived on an element; `onBoard`: the board's focusable canvas (not its text editor). */
  | { readonly type: 'focus'; readonly onBoard: boolean }
  /** The focus left the board's canvas. */
  | { readonly type: 'leave' }
  /** The keyboard was brought to the board on purpose (F6, "Skip to canvas"); `onBoard`: it has the focus now. */
  | { readonly type: 'enter'; readonly onBoard: boolean }

/** The keys that move the keyboard focus to another place on the page. */
const FOCUS_KEYS: ReadonlySet<string> = new Set(['Tab', 'F6'])

/** Whether a key press makes the keyboard the last input (Tab, Shift+Tab, F6: not typing, not Escape). */
export const movesFocus = (key: string): boolean => FOCUS_KEYS.has(key)

export function nextRing(s: RingState, input: RingInput): RingState {
  switch (input.type) {
    case 'pointerdown':
      return s.modality === 'pointer' && !s.ring ? s : { modality: 'pointer', ring: false }
    case 'pointermove':
      if (!input.moved) return s
      return s.modality === 'pointer' && !s.ring ? s : { modality: 'pointer', ring: false }
    case 'key':
      return movesFocus(input.key) && s.modality !== 'keyboard' ? { ...s, modality: 'keyboard' } : s
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
