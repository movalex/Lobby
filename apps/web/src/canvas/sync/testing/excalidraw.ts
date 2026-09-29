/**
 * Client copies made and edited with Excalidraw's own element helpers (`@excalidraw/element` in Node), for
 * the engine core's and the undo core's tests: the follow of a bound arrow (`updateBoundElements`), a point
 * drag (`movePoints`), an elbow segment drag (`moveFixedSegment`), a frame drag (`dragSelectedElements`).
 * The same operations the arrow acceptance tests use (apps/sync/test/room/arrows/support), written here so
 * canvas code does not import another app's tests. Not node-safe (test support only).
 */
import * as element from '@excalidraw/element'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element objects and helpers, typed loosely on purpose
export type El = any
export type Scene = Map<string, El>
export type Pt = [number, number]

// biome-ignore lint/suspicious/noExplicitAny: the engine module, re-typed at the call sites
const X = element as any
export const LinearElementEditor = X.LinearElementEditor

export const cloneScene = (s: ReadonlyMap<string, El>): Scene =>
  new Map([...s].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))

export const fakeScene = (map: Scene) => ({
  mutateElement: (el: El, u: El, o?: El) => X.mutateElement(el, map, u, o),
  getNonDeletedElementsMap: () => map,
  getElementsMapIncludingDeleted: () => map,
  getNonDeletedElements: () => [...map.values()],
  triggerUpdate: () => {},
})

export const newRect = (o: El): El => X.newElement({ type: 'rectangle', roughness: 0, ...o })
export const newArrow = (o: El): El => X.newArrowElement({ type: 'arrow', roughness: 0, ...o })
export const newFrame = (o: El): El => X.newFrameElement({ roughness: 0, ...o })

export function bind(arrow: El, start: El | null, end: El | null, fs: Pt = [1, 0.5], fe: Pt = [0, 0.5]): El {
  arrow.startBinding = start ? { elementId: start.id, fixedPoint: fs, mode: 'orbit' } : null
  arrow.endBinding = end ? { elementId: end.id, fixedPoint: fe, mode: 'orbit' } : null
  for (const t of [start, end])
    if (t && !(t.boundElements ?? []).some((r: El) => r.id === arrow.id))
      t.boundElements = [...(t.boundElements ?? []), { id: arrow.id, type: 'arrow' }]
  return arrow
}

export function routeElbow(scene: Scene, arrow: El, fixAt?: { index: number; x: number }): void {
  Object.assign(arrow, X.updateElbowArrowPoints(arrow, scene, { points: arrow.points }, {}))
  if (fixAt)
    LinearElementEditor.moveFixedSegment({ elementId: arrow.id }, fixAt.index, fixAt.x, 0, fakeScene(scene))
}

export const glob = (a: El, i: number, map: ReadonlyMap<string, El>): Pt => {
  const p = LinearElementEditor.getPointAtIndexGlobalCoordinates(a, i, map)
  return [p[0], p[1]]
}
export const dist = (p: Pt, q: Pt): number => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
export const segments = (a: El): { v: boolean; cross: number; index: number }[] =>
  [...(a.fixedSegments ?? [])]
    .sort((p: El, q: El) => p.index - q.index)
    .map((s: El) => {
      const v = Math.abs(s.start[0] - s.end[0]) <= Math.abs(s.start[1] - s.end[1])
      return { v, cross: v ? a.x + s.start[0] : a.y + s.start[1], index: s.index }
    })

export function dragPoint(copy: Scene, arrowId: string, i: number, to: Pt): void {
  const a = copy.get(arrowId)
  const local = LinearElementEditor.createPointAt(a, copy, to[0], to[1], null)
  LinearElementEditor.movePoints(a, fakeScene(copy), new Map([[i, { point: local }]]))
}
export function dragSegment(copy: Scene, arrowId: string, index: number, x: number): void {
  LinearElementEditor.moveFixedSegment({ elementId: arrowId }, index, x, 0, fakeScene(copy))
}
/** A move, resize or rotation of a target, followed by Excalidraw as it follows bound arrows. */
export function editTarget(copy: Scene, id: string, update: El): void {
  X.mutateElement(copy.get(id), copy, update)
  X.updateBoundElements(copy.get(id), fakeScene(copy))
}
/** The server's re-snap of one arrow against the stored targets, as Excalidraw's follow computes it. */
export function resnap(copy: Scene, arrowId: string): void {
  const a = copy.get(arrowId)
  const n = a.points.length
  const ups: [number, { point: Pt }][] = []
  for (const [prop, idx] of [
    ['startBinding', 0],
    ['endBinding', n - 1],
  ] as const) {
    const b = a[prop]
    if (!b) continue
    const t = copy.get(b.elementId)
    if (!t || t.isDeleted) continue
    const p = X.updateBoundPoint(a, prop, b, t, copy)
    if (p) ups.push([idx, { point: p }])
  }
  if (ups.length) LinearElementEditor.movePoints(a, fakeScene(copy), new Map(ups))
}
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

export { X as engine }
