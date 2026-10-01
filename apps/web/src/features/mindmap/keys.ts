// Mind-map keys (pure: no DOM, no editor). With exactly one topic selected, or while typing in one:
//
//   Tab            add a child topic and type in it
//   Enter          add a sibling below and type in it (on the central topic: a child)
//   Shift+Tab      move the topic up a level (it becomes its parent's next sibling)
//   Shift+Enter    a new line inside the topic (while typing; tldraw's own behaviour)
//   Arrow keys     move the selection through the map: away from the centre goes to the nearest child
//                  (a collapsed topic opens first), toward it goes to the parent, up and down go to the
//                  previous and next sibling (only while not typing; replaces nudging for topics)
//   F2, or typing  edit the selected topic (typing appends, like sticky notes: canvas-ux COL-04,
//                  with the same RETRO-02 exception right after Esc)
//   Delete         remove the topic and its branch (the board's delete, widened; asks above a size)
//
// They never fire with Ctrl, Cmd or Alt held, during IME composition, while a menu is open, or when
// the key goes to a text field other than the topic being edited. Read-only people keep only the
// arrow keys (moving the selection changes nothing on the board).

import { isTypeToEditKey, type KeyEventLike } from '../canvas-ux/keys.ts'
import type { NavDirection } from './model.ts'

export type TopicKeyIntent =
  | { kind: 'child' }
  | { kind: 'sibling' }
  | { kind: 'promote' }
  | { kind: 'nav'; dir: NavDirection }
  | { kind: 'edit'; text: string }

export interface TopicKeyState {
  /** Exactly one topic is selected (the central topic included) and nothing is being edited. */
  topicSelected: boolean
  /** The shape being edited is a topic, and the key comes from its text editor. */
  editingTopic: boolean
  /** the select tool is idle (tldraw: isIn('select.idle')) */
  isIdle: boolean
  isReadonly: boolean
  menusOpen: boolean
  /** The key goes to some other text field (an input, the search box, a comment…). */
  targetIsTextField: boolean
  /** The selected topic is the one whose editing just ended with Esc (RETRO-02). */
  justLeftEditing: boolean
  /** The selected topic, or an ancestor of it, is locked. */
  locked: boolean
}

const ARROWS: Record<string, NavDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

export function topicKeyIntent(e: KeyEventLike, s: TopicKeyState): TopicKeyIntent | null {
  if (e.isComposing || s.menusOpen) return null
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const shift = e.shiftKey === true

  if (s.editingTopic) {
    if (s.isReadonly) return null
    if (e.key === 'Tab') return shift ? { kind: 'promote' } : { kind: 'child' }
    if (e.key === 'Enter' && !shift) return { kind: 'sibling' }
    return null
  }

  if (!s.topicSelected || !s.isIdle || s.targetIsTextField) return null
  const dir = ARROWS[e.key]
  if (dir) return shift ? null : { kind: 'nav', dir }
  if (s.isReadonly) return null
  if (e.key === 'Tab') return shift ? { kind: 'promote' } : { kind: 'child' }
  if (e.key === 'Enter') return shift ? null : { kind: 'sibling' }
  if (s.locked) return null
  if (e.key === 'F2' && !shift) return { kind: 'edit', text: '' }
  if (!s.justLeftEditing && isTypeToEditKey(e)) return { kind: 'edit', text: e.key }
  return null
}

/** The chords this feature reads in its own key listener (for the keyboard map check). */
export const MINDMAP_KEYS = ['tab', 'shift+tab', 'enter', 'f2', 'left', 'right', 'up', 'down'] as const
