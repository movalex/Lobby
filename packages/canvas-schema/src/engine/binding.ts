/**
 * Server-derived bound arrows (docs/EXCALIDRAW-MIGRATION.md §2.9.4 rule 7, revisions 3.3–3.5): the
 * SIGNATURES and the contract, frozen at the spike B contracts step C0. The lead wrote these STUBS;
 * O1 implements them after C0 (and keeps the critic's elbow-in-Node probe as a unit test). The room
 * calls them in the savepoint of the write that causes them; O4's roll-forward calls them in step g.
 *
 * The contract every implementation keeps:
 * - Each helper returns the WHOLE `path` unit of the arrow (arrow: `x`, `y`, `points`, `width`, `height`,
 *   `angle`, `elbowed`, and `fixedSegments`, `startIsSpecial`, `endIsSpecial` when the arrow has them;
 *   groups.ts `pathUnitOf`), never a part of it.
 * - Both bound endpoints are recomputed from the stored `FixedPointBinding`s (`fixedPoint`, `mode`) and
 *   the targets' stored geometry, as orbit mode does, with Excalidraw's pure `updateBoundPoint`. Each
 *   re-snapped bound point is rounded to 2 decimals BEFORE the rebase.
 * - The rebase IS `LinearElementEditor.movePoints` (rotation-aware: E 11397-11445, `_updatePoints`
 *   E 11509-11546), called with the re-snapped bound points as `updateBoundElements` calls it, so every
 *   unbound point (a free end, every midpoint) keeps its scene position. Never the hand-written
 *   "`x`, `y` = s, subtract the offset" (wrong for a rotated arrow: 14.2 px in the recheck's probe).
 *   Scene coordinates are `getPointAtIndexGlobalCoordinates` (E 11212-11223; engine/linear.ts).
 * - Self-loops (both ends bound to one element) keep their midpoints' offset from the start
 *   (`moveMidPointsWithElement`, E 9115, 11424); their first re-snaps settle within a few writes.
 * - An elbow arrow's route is `updateElbowArrowPoints` with a map of the arrow and its targets, and the
 *   helper returns the router's WHOLE output (`normalizeArrowElementUpdate`: `points`, `x`, `y`,
 *   `fixedSegments`, `width`, `height`, `startIsSpecial`, `endIsSpecial`, E 5416-5447); fixed segments
 *   keep their order, orientations and positions across their axes, even when a heading change
 *   renumbers them.
 * - The result is rounded as limits.ts `roundGeometry` says (points and fixed segments to 2 decimals;
 *   `x`, `y` only when the arrow is unrotated). A result equal to the stored unit after rounding is
 *   `changed: false`, and the room then writes nothing.
 * - An end whose binding is null, or whose target is missing or deleted, is left where it is (the
 *   invariants null a binding to a deleted target, §2.4.4).
 * - Pure: no `Scene`, no DOM, no clocks; the caller bumps versions and advances only `gclock.fit`.
 */
import type { EngineElement } from './types.ts'

type Pt = readonly [number, number]

/** The stored elements a re-snap reads (the arrow, its targets, its label). */
export type ElementsById = ReadonlyMap<string, EngineElement>

export interface ArrowBindingLike {
  readonly elementId: string
  readonly fixedPoint: Pt
  readonly mode: 'inside' | 'orbit' | 'skip'
}

/** An arrow as the helpers read it (the stored element). */
export type ArrowElementLike = EngineElement & {
  readonly type: 'arrow'
  readonly points: readonly Pt[]
  readonly startBinding: ArrowBindingLike | null
  readonly endBinding: ArrowBindingLike | null
  readonly elbowed: boolean
  readonly fixedSegments?: readonly { readonly start: Pt; readonly end: Pt; readonly index: number }[] | null
  readonly startIsSpecial?: boolean | null
  readonly endIsSpecial?: boolean | null
}

/** The whole `path` unit of an arrow, as the helpers return it. */
export interface ArrowPathUnit {
  readonly x: number
  readonly y: number
  readonly points: readonly Pt[]
  readonly width: number
  readonly height: number
  readonly angle: number
  readonly elbowed: boolean
  readonly fixedSegments?: readonly { readonly start: Pt; readonly end: Pt; readonly index: number }[] | null
  readonly startIsSpecial?: boolean | null
  readonly endIsSpecial?: boolean | null
}

export interface ResnapResult {
  /** the whole re-snapped, rounded unit */
  readonly path: ArrowPathUnit
  /** false when the unit equals the stored one after rounding: the room writes nothing */
  readonly changed: boolean
}

/**
 * Re-snap one arrow's bound ends against the stored targets in `elements` (dispatches to
 * `resnapLinearArrow` or `routeElbowArrow`). The arrow itself is read from its argument, not from the map.
 */
export function resnapArrow(arrow: ArrowElementLike, elements: ElementsById): ResnapResult {
  void arrow
  void elements
  throw new Error('not implemented (O1): packages/canvas-schema/src/engine/binding.ts resnapArrow')
}

/** A straight or curved arrow: `updateBoundPoint` for both bound ends, rounded, then `movePoints`, rounded. */
export function resnapLinearArrow(arrow: ArrowElementLike, elements: ElementsById): ResnapResult {
  void arrow
  void elements
  throw new Error('not implemented (O1): packages/canvas-schema/src/engine/binding.ts resnapLinearArrow')
}

/** An elbow arrow: `updateElbowArrowPoints`, and the router's whole output, rounded. */
export function routeElbowArrow(arrow: ArrowElementLike, elements: ElementsById): ResnapResult {
  void arrow
  void elements
  throw new Error('not implemented (O1): packages/canvas-schema/src/engine/binding.ts routeElbowArrow')
}

/** An arrow label's derived layout (§2.9.4 rule 7 "The arrow's label: a derived `layout` write"). */
export interface ArrowLabelLayout {
  readonly x: number
  readonly y: number
  /** unleased only: the re-wrapped text and its box (`fontSize` and `originalText` never change) */
  readonly text?: string
  readonly width?: number
  readonly height?: number
}

/**
 * Where the arrow's bound label goes after the arrow's geometry changed, with
 * `LinearElementEditor.getBoundTextElementPosition` (runs in plain Node; the label wraps to
 * `ARROW_LABEL_WIDTH_FRACTION` of the arrow's width, E 6583-6587, with the metrics table, §2.11).
 * `leased: true` (someone is typing in the label): position only (`x`, `y`); the holder re-wraps.
 *
 * THE CALLER BUMPS THE ARROW'S `version` BEFORE CALLING THIS: the helper caches its answer per label
 * in a WeakMap keyed by (arrow version, label version) (E 10345, 11674-11690), so a second re-snap of
 * the same objects in one savepoint would otherwise get the old position.
 */
export function arrowLabelLayout(
  arrow: ArrowElementLike,
  label: EngineElement,
  elements: ElementsById,
  opts: { readonly leased: boolean },
): ArrowLabelLayout {
  void arrow
  void label
  void elements
  void opts
  throw new Error('not implemented (O1): packages/canvas-schema/src/engine/binding.ts arrowLabelLayout')
}
