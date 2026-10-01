// The CLIENT side of the arrow acceptance tests: copies of the board made and edited with Excalidraw's
// own helpers, exactly as the recheck's probes make them (docs/EXCALIDRAW-MIGRATION.md §8.6.2 row
// "(3.5) apps/sync/test/room/arrows/**"): `updateBoundElements`, `movePoints`, `moveFixedSegment`,
// `dragSelectedElements`, `refreshTextDimensions`, `mutateElement`. Frozen with the tests (lead-owned).
//
// It never implements a server rule: the server side of every test is O1's room. The one reference
// computation here, `followError`, re-runs Excalidraw's own follow on a copy of the STORED arrow to say
// whether its bound ends sit where their FixedPointBindings put them on the stored targets.

import { createTableTextMetrics } from '@draftroom/canvas-schema/engine'
import { GEOMETRY_TOLERANCE_PX } from '@draftroom/canvas-schema/limits'
import * as element from '@excalidraw/element'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's own element objects and helpers, typed loosely on purpose
export type El = any
export type Scene = Map<string, El>
export type Pt = [number, number]

// biome-ignore lint/suspicious/noExplicitAny: the engine module, re-typed at the call sites
const X = element as any
export const LinearElementEditor = X.LinearElementEditor

export const TOL = GEOMETRY_TOLERANCE_PX

/** The server's metrics provider (the table of §2.11), so client and room lay text out alike. */
export function useServerTextMetrics(): void {
  X.setCustomTextMetricsProvider(createTableTextMetrics())
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
export const cloneScene = (s: ReadonlyMap<string, El>): Scene =>
  new Map([...s].map(([k, v]) => [k, clone(v)]))
export const fakeScene = (map: Scene) => ({
  mutateElement: (el: El, u: El, o?: El) => X.mutateElement(el, map, u, o),
  getNonDeletedElementsMap: () => map,
  getElementsMapIncludingDeleted: () => map,
  getNonDeletedElements: () => [...map.values()],
  triggerUpdate: () => {},
})

// ---- constructors (the probes' setups) ---------------------------------------------------------------
//
// Lobby's new elements have roughness 0 (`currentItemRoughness: 0`, §2.3.2), and so do these. The probes
// used Excalidraw's constructor default, roughness 1: then a ROTATED arrow's follow residual depends on the
// random rough-shape seed (the curve's bounds, hence the rotation centre, jitter) and can exceed
// GEOMETRY_TOLERANCE_PX (0.53 px seen in 1 of ~8,000 rotated follows); at roughness 0 it is exactly 0.
// s1-sweep.test.ts pins the roughness-1 case with fixed seeds (CONTRACTS.md, findings).

export const newRect = (o: El, type: 'rectangle' | 'ellipse' | 'diamond' = 'rectangle'): El =>
  X.newElement({ type, roughness: 0, ...o })
export const newArrow = (o: El): El => X.newArrowElement({ type: 'arrow', roughness: 0, ...o })
export const newFrame = (o: El): El => X.newFrameElement({ roughness: 0, ...o })
export const newNote = (o: El): El => ({
  ...X.newStickyNoteElement({ type: 'stickynote', roughness: 0, ...o }),
  created: null,
})
export const newText = (o: El): El => X.newTextElement({ roughness: 0, ...o })

/** Binds `arrow`'s `ends` to targets and lists it in their `boundElements` (both sides, as Excalidraw keeps them). */
export function bind(arrow: El, start: El | null, end: El | null, fs: Pt = [1, 0.5], fe: Pt = [0, 0.5]): El {
  arrow.startBinding = start ? { elementId: start.id, fixedPoint: fs, mode: 'orbit' } : null
  arrow.endBinding = end ? { elementId: end.id, fixedPoint: fe, mode: 'orbit' } : null
  for (const t of [start, end])
    if (t && !(t.boundElements ?? []).some((r: El) => r.id === arrow.id))
      t.boundElements = [...(t.boundElements ?? []), { id: arrow.id, type: 'arrow' }]
  return arrow
}

/** An elbow arrow's route through Excalidraw's router, and optionally its segment `index` fixed at scene `x`. */
export function routeElbow(scene: Scene, arrow: El, fixAt?: { index: number; x: number }): void {
  Object.assign(arrow, X.updateElbowArrowPoints(arrow, scene, { points: arrow.points }, {}))
  if (fixAt)
    LinearElementEditor.moveFixedSegment({ elementId: arrow.id }, fixAt.index, fixAt.x, 0, fakeScene(scene))
}

// ---- geometry reads ----------------------------------------------------------------------------------

/** Scene coordinates of point `i` (negative from the end), rotation-aware. */
export const glob = (a: El, i: number, map: ReadonlyMap<string, El>): Pt => {
  const p = LinearElementEditor.getPointAtIndexGlobalCoordinates(a, i, map)
  return [p[0], p[1]]
}
export const dist = (p: Pt, q: Pt): number => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
/** An elbow arrow's fixed segments in order: orientation and scene cross-axis position. */
export const segments = (a: El): { v: boolean; cross: number; index: number }[] =>
  [...(a.fixedSegments ?? [])]
    .sort((p: El, q: El) => p.index - q.index)
    .map((s: El) => {
      const v = Math.abs(s.start[0] - s.end[0]) <= Math.abs(s.start[1] - s.end[1])
      return { v, cross: v ? a.x + s.start[0] : a.y + s.start[1], index: s.index }
    })
/** Every segment of the route is horizontal or vertical. */
export const orthogonal = (a: El): boolean =>
  a.points
    .slice(1)
    .every(
      (p: Pt, i: number) => Math.abs(p[0] - a.points[i][0]) < 1e-6 || Math.abs(p[1] - a.points[i][1]) < 1e-6,
    )

/**
 * How far the stored arrow's bound ends are from where Excalidraw's own follow puts them against the
 * stored targets (`updateBoundPoint` for both ends, then `movePoints`, on a copy; E 9055-9123). 0 means
 * "on the target's edge as its FixedPointBinding says". Only bound ends are measured.
 */
export function followError(stored: ReadonlyMap<string, El>, arrowId: string): number {
  const map = cloneScene(stored)
  const a = map.get(arrowId)
  const n = a.points.length
  const ups: [number, { point: Pt }][] = []
  for (const [prop, idx] of [
    ['startBinding', 0],
    ['endBinding', n - 1],
  ] as const) {
    const b = a[prop]
    if (!b) continue
    const t = map.get(b.elementId)
    if (!t || t.isDeleted) continue
    const p = X.updateBoundPoint(a, prop, b, t, map)
    if (!p) throw new Error(`updateBoundPoint gave nothing for a bound ${prop}`)
    ups.push([idx, { point: p }])
  }
  if (!ups.length) return 0
  const before = ups.map(([i]) => glob(stored.get(arrowId), i, stored))
  const selfLoop = a.startBinding && a.endBinding && a.startBinding.elementId === a.endBinding.elementId
  LinearElementEditor.movePoints(a, fakeScene(map), new Map(ups), { moveMidPointsWithElement: !!selfLoop })
  return Math.max(...ups.map(([i], k) => dist(glob(a, i, map), before[k] as Pt)))
}

// ---- client edits on a copy (what a user's browser does locally) ------------------------------------------

/** Drags point `i` of `arrowId` to scene `to` (Excalidraw's point editor: `createPointAt` + `movePoints`). */
export function dragPoint(copy: Scene, arrowId: string, i: number, to: Pt): void {
  const a = copy.get(arrowId)
  const local = LinearElementEditor.createPointAt(a, copy, to[0], to[1], null)
  LinearElementEditor.movePoints(a, fakeScene(copy), new Map([[i, { point: local }]]))
}
/** Drags an elbow arrow's segment `index` to scene `x` (a vertical segment). */
export function dragSegment(copy: Scene, arrowId: string, index: number, x: number): void {
  LinearElementEditor.moveFixedSegment({ elementId: arrowId }, index, x, 0, fakeScene(copy))
}
/** A move, resize or rotation of a target, followed by Excalidraw as it follows bound arrows. */
export function editTarget(copy: Scene, id: string, update: El): void {
  X.mutateElement(copy.get(id), copy, update)
  X.updateBoundElements(copy.get(id), fakeScene(copy))
}
/** A frame drag through Excalidraw's own `dragSelectedElements` (its children, arrows included, move with it). */
export function dragFrame(copy: Scene, frameId: string, by: { x: number; y: number }): void {
  X.dragSelectedElements(
    { originalElements: cloneScene(copy) },
    [copy.get(frameId)],
    by,
    fakeScene(copy),
    { x: 0, y: 0 },
    null,
  )
}
/** Typing in a free text: the editor's `refreshTextDimensions`, then `updateBoundElements` (X 49845). */
export function typeInText(copy: Scene, textId: string, text: string): void {
  const t0 = copy.get(textId)
  const dims = X.refreshTextDimensions(t0, null, copy, text)
  copy.set(textId, X.newElementWith(t0, { originalText: text, ...dims }))
  X.updateBoundElements(copy.get(textId), fakeScene(copy))
}
/** Rotates an arrow as a selection rotation writes it (`x`, `y`, `angle`; E 23034-23080). */
export function rotateArrowAsSelection(
  copy: Scene,
  arrowId: string,
  update: { x: number; y: number; angle: number },
): void {
  X.mutateElement(copy.get(arrowId), copy, update)
}

export { X as engine }
