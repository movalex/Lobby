/**
 * Edits the spike B arrow checks (B3 L6, L10) make through Excalidraw's OWN element operations, as the
 * user's gestures produce them, and then through the real sync path: the operation runs on a copy of the
 * scene (Excalidraw's `LinearElementEditor.movePoints` / `moveFixedSegment`, `updateBoundElements`), and the
 * result is installed with `CanvasPort.transact` (one undo step, pushed by the engine core like any edit).
 * The same operations the arrow acceptance tests use (apps/sync/test/room/arrows/support/excalidraw.ts).
 *
 * Exposed on `window.__lobbyBoard.helpers` (the spike board page only exists behind the dev-auth guard).
 */
import * as element from '@excalidraw/element'
import type { LobbyCanvasPort } from '../../port-impl.ts'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers, typed loosely on purpose
const X = element as any
// biome-ignore lint/suspicious/noExplicitAny: plain element copies
type El = any
type Pt = [number, number]

const PATH_FIELDS = [
  'x',
  'y',
  'points',
  'width',
  'height',
  'angle',
  'elbowed',
  'fixedSegments',
  'startIsSpecial',
  'endIsSpecial',
]

function copyScene(port: LobbyCanvasPort): Map<string, El> {
  const m = new Map<string, El>()
  for (const e of port.items()) m.set(e.id, JSON.parse(JSON.stringify(e)))
  return m
}

const fakeScene = (map: Map<string, El>) => ({
  mutateElement: (el: El, u: El, o?: El) => X.mutateElement(el, map, u, o),
  getNonDeletedElementsMap: () => map,
  getElementsMapIncludingDeleted: () => map,
  getNonDeletedElements: () => [...map.values()],
  triggerUpdate: () => {},
})

const pathOf = (el: El): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const f of PATH_FIELDS) if (el[f] !== undefined) out[f] = el[f]
  return out
}

export function createSpecHelpers(port: LobbyCanvasPort) {
  return {
    /** Scene coordinates of point `i` of a linear element (negative from the end), rotation-aware. */
    pointAt(id: string, i: number): Pt {
      const map = copyScene(port)
      const a = map.get(id)
      const n = a.points.length
      const p = X.LinearElementEditor.getPointAtIndexGlobalCoordinates(a, i < 0 ? n + i : i, map)
      return [p[0], p[1]]
    },
    /** A point drag (the point editor: createPointAt + movePoints) to scene `to`, as one edit. */
    dragPoint(id: string, i: number, to: Pt): void {
      const map = copyScene(port)
      const a = map.get(id)
      const idx = i < 0 ? a.points.length + i : i
      const local = X.LinearElementEditor.createPointAt(a, map, to[0], to[1], null)
      X.LinearElementEditor.movePoints(a, fakeScene(map), new Map([[idx, { point: local }]]))
      port.transact('spec.dragPoint', (tx) => tx.update(id, pathOf(a)))
    },
    /** An elbow arrow's segment `index` dragged to scene `x` (a vertical segment), as one edit. */
    dragSegment(id: string, index: number, x: number): void {
      const map = copyScene(port)
      X.LinearElementEditor.moveFixedSegment({ elementId: id }, index, x, 0, fakeScene(map))
      port.transact('spec.dragSegment', (tx) => tx.update(id, pathOf(map.get(id))))
    },
    /** Routes an elbow arrow (Excalidraw's router) and fixes its segment `index` at scene `x`, as one edit. */
    routeElbow(id: string, fixAt?: { index: number; x: number }): void {
      const map = copyScene(port)
      const a = map.get(id)
      Object.assign(a, X.updateElbowArrowPoints(a, map, { points: a.points }, {}))
      if (fixAt)
        X.LinearElementEditor.moveFixedSegment({ elementId: id }, fixAt.index, fixAt.x, 0, fakeScene(map))
      port.transact('spec.routeElbow', (tx) => tx.update(id, pathOf(map.get(id))))
    },
    /** A target's move, resize or rotation with Excalidraw's follow of its bound arrows, as one edit. */
    editTarget(id: string, update: Record<string, unknown>): void {
      const map = copyScene(port)
      const before = copyScene(port)
      X.mutateElement(map.get(id), map, update)
      X.updateBoundElements(map.get(id), fakeScene(map))
      // the target and every arrow Excalidraw's follow moved, as a resize gesture leaves them locally (the
      // engine core classifies the arrows' changes as derived: held, never pushed)
      port.transact('spec.editTarget', (tx) => {
        tx.update(id, update)
        for (const [aid, a] of map) {
          if (aid === id || a.type !== 'arrow') continue
          if (JSON.stringify(pathOf(a)) !== JSON.stringify(pathOf(before.get(aid)))) tx.update(aid, pathOf(a))
        }
      })
    },
    /** An elbow arrow's fixed segments in order: orientation and scene cross-axis position. */
    segments(id: string): { v: boolean; cross: number; index: number }[] {
      const a = port.get(id) as El
      return [...(a?.fixedSegments ?? [])]
        .sort((p: El, q: El) => p.index - q.index)
        .map((s: El) => {
          const v = Math.abs(s.start[0] - s.end[0]) <= Math.abs(s.start[1] - s.end[1])
          return { v, cross: v ? a.x + s.start[0] : a.y + s.start[1], index: s.index }
        })
    },
    /**
     * How far an arrow's bound ends are from where Excalidraw's own follow puts them against the current
     * targets (updateBoundPoint for both ends, then movePoints, on a copy); 0 = on the target's edge.
     */
    followError(id: string): number {
      const map = copyScene(port)
      const stored = copyScene(port)
      const a = map.get(id)
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
        if (p) ups.push([idx, { point: p }])
      }
      if (!ups.length) return 0
      const glob = (el: El, i: number, m: Map<string, El>) =>
        X.LinearElementEditor.getPointAtIndexGlobalCoordinates(el, i, m)
      const before = ups.map(([i]) => glob(stored.get(id), i, stored))
      X.LinearElementEditor.movePoints(a, fakeScene(map), new Map(ups))
      return Math.max(
        ...ups.map(([i], k) => {
          const p = glob(a, i, map)
          const q = before[k]
          return Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
        }),
      )
    },
  }
}
