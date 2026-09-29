/**
 * Cross-element invariants (docs/EXCALIDRAW-MIGRATION.md §2.4.4): the signature and the violation
 * codes, frozen at the spike B contracts step C0. The lead wrote this STUB; O1 implements
 * `checkInvariants` after C0 (with `@excalidraw/element`'s own `isBindableElement` and
 * `isTextBindableContainer` through `engine/bindability.ts`). The room runs the rules after each push;
 * the spike B harness runs `checkInvariants` on the test snapshot after every check (§8.1), and O4's
 * roll-forward runs it on its result (§5.9 step g).
 *
 * The input is a whole board's element list as the test snapshot returns it: live elements AND
 * tombstones. Rules speak about live elements; a tombstone only matters where a rule says so (a live
 * label whose container is deleted is a violation).
 */
import type { WireElement } from './elements.ts'

/** One code per row of §2.4.4 (plus the index rules of §2.4.3 step 11). */
export const VIOLATION_CODES = [
  /** a text's `containerId` names no live element, or one that is not a text container (rectangle, stickynote, diamond, ellipse, arrow) */
  'LABEL_CONTAINER_INVALID',
  /** container ↔ label is not one-to-one: the container's `boundElements` lists no text, several, or one that does not name it back */
  'LABEL_NOT_ONE_TO_ONE',
  /** a label sorts before (or at) its container */
  'LABEL_ORDER',
  /** a live label whose container is deleted (deleting a container deletes its label in the same clock) */
  'LABEL_ORPHANED',
  /** `startBinding`/`endBinding.elementId` names no live, bindable element */
  'BINDING_TARGET_INVALID',
  /** a bound arrow is not listed in its target's `boundElements`, or a target lists an arrow not bound to it */
  'BINDING_ASYMMETRIC',
  /** `frameId` names no live `frame` (or a frame has a `frameId`: no nesting) */
  'FRAME_INVALID',
  /** a group id has more than one parent group across the board's elements */
  'GROUP_NESTING',
  /** a type Lobby does not store (§3.1) */
  'TYPE_REFUSED',
  /** `index` is null or not a valid fractional key */
  'INDEX_INVALID',
  /** two live elements share an `index` */
  'INDEX_DUPLICATE',
] as const
export type ViolationCode = (typeof VIOLATION_CODES)[number]

export interface Violation {
  readonly code: ViolationCode
  /** the element the rule is about */
  readonly id: string
  /** the other element involved (the container, the target, the frame, the element sharing the index) */
  readonly other?: string
  /** ids only; never element text (logs and reports carry no board content) */
  readonly detail?: string
}

/** Every violation of §2.4.4 on a board's elements (live and deleted). Empty = consistent. Pure. */
export function checkInvariants(elements: readonly WireElement[]): Violation[] {
  void elements
  throw new Error('not implemented (O1): packages/canvas-schema/src/invariants.ts checkInvariants')
}
