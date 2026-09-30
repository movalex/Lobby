/**
 * Server-derived bound arrows (docs/EXCALIDRAW-MIGRATION.md §2.9.4 rule 7, revisions 3.3–3.5): the
 * SIGNATURES and the contract were frozen at the spike B contracts step C0; O1 implements them. The room
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
 *   (`moveMidPointsWithElement`, E 9115, 11424); their first re-snaps settle within a few writes. This
 *   implementation re-snaps a self-loop up to `SELF_LOOP_ITERATIONS` times in one call, until its unit no
 *   longer changes after rounding (CONTRACTS.md finding 3), so a stored self-loop is (nearly) settled.
 * - An elbow arrow's route is `updateElbowArrowPoints` with a map of the arrow and its targets, and the
 *   helper returns the router's WHOLE output (`normalizeArrowElementUpdate`: `points`, `x`, `y`,
 *   `fixedSegments`, `width`, `height`, `startIsSpecial`, `endIsSpecial`, E 5416-5447); fixed segments
 *   keep their order, orientations and positions across their axes, even when a heading change
 *   renumbers them. It is reached exactly as Excalidraw's own follow reaches it: `movePoints` on an elbow
 *   arrow hands the new end points to `mutateElement`, which runs the router and assigns its whole output
 *   (E 5538-5557, 11509-11524).
 * - The result is rounded as limits.ts `roundGeometry` says (points and fixed segments to 2 decimals;
 *   `x`, `y` only when the arrow is unrotated). A result equal to the stored unit after rounding is
 *   `changed: false`, and the room then writes nothing.
 * - An end whose binding is null, or whose target is missing or deleted, is left where it is (the
 *   invariants null a binding to a deleted target, §2.4.4).
 * - Pure: no `Scene`, no DOM, no clocks; the caller bumps versions and advances only `gclock.fit`. The
 *   inputs are never mutated: the helpers work on JSON copies.
 */
import * as common from '@excalidraw/common'
import * as element from '@excalidraw/element'
import { ENGINE_ARTIFACT_FIELDS, pathUnitOf } from '../groups.ts'
import { round2, roundGeometry } from '../limits.ts'
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

// ---- the engine calls, re-typed (as raw.ts and linear.ts do: under `nodenext` the engine's .d.ts
// re-exports do not resolve, so server-side code types the helpers itself) -----------------------------

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's own element objects, mutated in place by its helpers
type Mut = any
type WorkMap = Map<string, Mut>

interface BindingEngineApi {
  updateBoundPoint(
    arrow: Mut,
    startOrEnd: 'startBinding' | 'endBinding',
    binding: Mut,
    bindable: Mut,
    elementsMap: WorkMap,
  ): [number, number] | null
  mutateElement(el: Mut, elementsMap: WorkMap, updates: Mut, options?: Mut): Mut
  getBoundTextMaxWidth(container: Mut, text: Mut): number
  wrapText(text: string, font: string, maxWidth: number): string
  measureText(text: string, font: string, lineHeight: number): { width: number; height: number }
  LinearElementEditor: {
    movePoints(
      el: Mut,
      scene: Mut,
      updates: Map<number, { point: [number, number] }>,
      otherUpdates?: Mut,
      options?: Mut,
    ): void
    getBoundTextElementPosition(arrow: Mut, label: Mut, elementsMap: WorkMap): { x: number; y: number }
  }
}
const api = element as unknown as BindingEngineApi
const fonts = common as unknown as { getFontString(opts: { fontSize: number; fontFamily: number }): string }

/** At most this many re-snaps of one self-loop per call (it settles within 2 on 3.5's rounding, §2.9.4). */
export const SELF_LOOP_ITERATIONS = 4

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** A stand-in for Excalidraw's `Scene`, over a plain map (what the engine's helpers call on it). */
function fakeScene(map: WorkMap) {
  return {
    mutateElement: (el: Mut, updates: Mut, options?: Mut) => api.mutateElement(el, map, updates, options),
    getNonDeletedElementsMap: () => map,
    getElementsMapIncludingDeleted: () => map,
    getNonDeletedElements: () => [...map.values()],
    triggerUpdate: () => {},
  }
}

/** A work map of copies: the arrow and the live targets its bindings name (all the re-snap reads). */
function workMapFor(arrow: ArrowElementLike, elements: ElementsById): { a: Mut; map: WorkMap } {
  const a = copy(arrow) as Mut
  const map: WorkMap = new Map([[a.id, a]])
  for (const b of [arrow.startBinding, arrow.endBinding]) {
    if (!b || map.has(b.elementId)) continue
    const t = elements.get(b.elementId)
    if (t && !t.isDeleted) map.set(b.elementId, copy(t))
  }
  return { a, map }
}

const isSelfLoop = (a: {
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
}) => !!a.startBinding && !!a.endBinding && a.startBinding.elementId === a.endBinding.elementId

/** One follow of both bound ends, exactly as `updateBoundElements` runs it, with the rounding rule. */
function snapOnce(a: Mut, map: WorkMap): void {
  const ups = new Map<number, { point: [number, number] }>()
  const last = a.points.length - 1
  for (const [prop, idx] of [
    ['startBinding', 0],
    ['endBinding', last],
  ] as const) {
    const b = a[prop]
    if (!b) continue
    const t = map.get(b.elementId)
    if (!t || t.isDeleted) continue
    const p = api.updateBoundPoint(a, prop, b, t, map)
    // the re-snapped bound point is rounded BEFORE the rebase (§3.5), so an unrotated rebase is exact
    if (p) ups.set(idx, { point: [round2(p[0]), round2(p[1])] })
  }
  if (ups.size)
    api.LinearElementEditor.movePoints(a, fakeScene(map), ups, { moveMidPointsWithElement: isSelfLoop(a) })
  for (const f of ENGINE_ARTIFACT_FIELDS) delete a[f]
  Object.assign(a, roundGeometry(a))
}

const unitKey = (el: Mut): string => JSON.stringify(pathUnitOf(el))

/** An elbow arrow whose points are not an orthogonal route (a diagonal segment): never routed yet. */
export function isUnroutedElbow(a: { elbowed?: boolean; points?: readonly Pt[] }): boolean {
  if (!a.elbowed || !a.points || a.points.length < 2) return false
  for (let i = 1; i < a.points.length; i++) {
    const p = a.points[i - 1] as Pt
    const q = a.points[i] as Pt
    if (Math.abs(p[0] - q[0]) > 1e-6 && Math.abs(p[1] - q[1]) > 1e-6) return true
  }
  return false
}

function resnap(arrow: ArrowElementLike, elements: ElementsById): ResnapResult {
  const { a, map } = workMapFor(arrow, elements)
  const before = unitKey(arrow as Mut)
  const iterations = isSelfLoop(a) ? SELF_LOOP_ITERATIONS : 1
  let prev = unitKey(a)
  for (let i = 0; i < iterations; i++) {
    snapOnce(a, map)
    const next = unitKey(a)
    if (next === prev) break
    prev = next
  }
  // an elbow arrow still unrouted (its create carried the two points it was drawn with, and no bound end
  // moved, so no follow ran the router): routed as Excalidraw normalizes one (`mutateElement` with no
  // updates runs `updateElbowArrowPoints`, E 5538-5557), so the stored copy is always a route (V1, B3
  // L10 6: stored at its two create points while the client held its local route as derived)
  if (isUnroutedElbow(a)) {
    api.mutateElement(a, map, {})
    for (const f of ENGINE_ARTIFACT_FIELDS) delete a[f]
    Object.assign(a, roundGeometry(a))
  }
  const path = pathUnitOf(a) as unknown as ArrowPathUnit
  return { path, changed: unitKey(a) !== before }
}

/**
 * Re-snap one arrow's bound ends against the stored targets in `elements` (dispatches to
 * `resnapLinearArrow` or `routeElbowArrow`). The arrow itself is read from its argument, not from the map.
 */
export function resnapArrow(arrow: ArrowElementLike, elements: ElementsById): ResnapResult {
  return arrow.elbowed ? routeElbowArrow(arrow, elements) : resnapLinearArrow(arrow, elements)
}

/** A straight or curved arrow: `updateBoundPoint` for both bound ends, rounded, then `movePoints`, rounded. */
export function resnapLinearArrow(arrow: ArrowElementLike, elements: ElementsById): ResnapResult {
  if (arrow.elbowed) throw new Error('resnapLinearArrow: an elbow arrow (use routeElbowArrow)')
  return resnap(arrow, elements)
}

/** An elbow arrow: `updateElbowArrowPoints`, and the router's whole output, rounded. */
export function routeElbowArrow(arrow: ArrowElementLike, elements: ElementsById): ResnapResult {
  if (!arrow.elbowed) throw new Error('routeElbowArrow: not an elbow arrow')
  return resnap(arrow, elements)
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
 * the same objects in one savepoint would otherwise get the old position. (This implementation also
 * works on fresh copies, so a stale cache entry is never hit.)
 *
 * The unleased re-wrap is `handleBindTextResize` for an arrow container (E 6341-6405): the words
 * (`originalText`) wrapped to `getBoundTextMaxWidth`, measured with `measureText`; the arrow itself is
 * never resized for its label.
 */
export function arrowLabelLayout(
  arrow: ArrowElementLike,
  label: EngineElement,
  elements: ElementsById,
  opts: { readonly leased: boolean },
): ArrowLabelLayout {
  void elements
  const a = copy(arrow) as Mut
  const t = copy(label) as Mut
  const map: WorkMap = new Map<string, Mut>([
    [a.id, a],
    [t.id, t],
  ])
  if (!opts.leased && typeof t.originalText === 'string' && t.originalText.length > 0) {
    const font = fonts.getFontString({ fontSize: t.fontSize, fontFamily: t.fontFamily })
    const text = api.wrapText(t.originalText, font, api.getBoundTextMaxWidth(a, t))
    const m = api.measureText(text, font, t.lineHeight)
    t.text = text
    t.width = m.width
    t.height = m.height
    const at = api.LinearElementEditor.getBoundTextElementPosition(a, t, map)
    return { x: at.x, y: at.y, text, width: m.width, height: m.height }
  }
  const at = api.LinearElementEditor.getBoundTextElementPosition(a, t, map)
  return { x: at.x, y: at.y }
}

/**
 * How far an arrow's bound ends are from where a re-snap against `elements` puts them, in scene units
 * (0: on the targets' edges as their FixedPointBindings say; ends that are not bound are not measured).
 * For tests and checkers that may not import the engine directly (the room's protocol tests, the spike B
 * harness); the C0 arrow acceptance tests measure the same with Excalidraw's own follow (`followError`).
 */
export function boundEndsOffEdge(arrow: ArrowElementLike, elements: ElementsById): number {
  const r = resnapArrow(arrow, elements)
  if (!r.changed) return 0
  const after = { ...(copy(arrow) as Mut), ...copy(r.path) } as Mut
  for (const f of ['fixedSegments', 'startIsSpecial', 'endIsSpecial']) if (!(f in r.path)) delete after[f]
  const last = arrow.points.length - 1
  const lastAfter = after.points.length - 1
  let d = 0
  const at = (el: Mut, i: number) => {
    const p = linearApi.LinearElementEditor.getPointAtIndexGlobalCoordinates(el, i, new Map([[el.id, el]]))
    return [p[0], p[1]] as const
  }
  for (const [bound, i, j] of [
    [arrow.startBinding, 0, 0],
    [arrow.endBinding, last, lastAfter],
  ] as const) {
    if (!bound) continue
    const p = at(arrow, i)
    const q = at(after, j)
    d = Math.max(d, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
  }
  return d
}

const linearApi = element as unknown as {
  LinearElementEditor: {
    getPointAtIndexGlobalCoordinates(el: Mut, i: number, map: WorkMap): [number, number]
  }
}
