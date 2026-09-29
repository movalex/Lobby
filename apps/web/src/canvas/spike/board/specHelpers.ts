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
  let sampler: { stop(): { max: Record<string, number>; samples: number } } | null = null
  const followError = (i: string): number => api.followError(i)
  const api = {
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
    /**
     * A target's move, resize or rotation with Excalidraw's follow of its bound arrows, as one edit. A
     * rotation also turns the target's label (Excalidraw rotates a container and its bound text together;
     * the label's `angle` is `shape`, not lease-gated). The label's layout is left to the lease holder.
     */
    editTarget(id: string, update: Record<string, unknown>): void {
      const map = copyScene(port)
      const before = copyScene(port)
      X.mutateElement(map.get(id), map, update)
      X.updateBoundElements(map.get(id), fakeScene(map))
      const label =
        update.angle !== undefined
          ? (map.get(id).boundElements ?? []).find((b: El) => b.type === 'text')?.id
          : undefined
      // the target and every arrow Excalidraw's follow moved, as a resize gesture leaves them locally (the
      // engine core classifies the arrows' changes as derived: held, never pushed)
      port.transact('spec.editTarget', (tx) => {
        tx.update(id, update)
        if (label && map.get(label)) tx.update(label, { angle: update.angle })
        for (const [aid, a] of map) {
          if (aid === id || a.type !== 'arrow') continue
          if (JSON.stringify(pathOf(a)) !== JSON.stringify(pathOf(before.get(aid)))) tx.update(aid, pathOf(a))
        }
      })
    },
    /**
     * A new arrow bound to `start` / `end` (FixedPointBindings, mode orbit) and listed in their
     * `boundElements` (both sides, as Excalidraw keeps them), as one edit. Returns the arrow's id.
     */
    bindArrow(
      props: Record<string, unknown>,
      start: { id: string; at: Pt } | null,
      end: { id: string; at: Pt } | null,
    ): string {
      return port.transact('spec.bindArrow', (tx) => {
        const aid = tx.create('arrow', {
          roughness: 0,
          ...props,
          startBinding: start ? { elementId: start.id, fixedPoint: start.at, mode: 'orbit' } : null,
          endBinding: end ? { elementId: end.id, fixedPoint: end.at, mode: 'orbit' } : null,
        })
        for (const t of new Set([start?.id, end?.id].filter(Boolean) as string[])) {
          const el = port.get(t) as El
          tx.update(t, { boundElements: [...(el?.boundElements ?? []), { id: aid, type: 'arrow' }] })
        }
        return aid
      })
    },
    /** A frame drag through Excalidraw's own `dragSelectedElements` (its children, arrows included, move with it). */
    dragFrame(frameId: string, by: { x: number; y: number }): void {
      const map = copyScene(port)
      const before = copyScene(port)
      X.dragSelectedElements(
        { originalElements: copyScene(port) },
        [map.get(frameId)],
        by,
        fakeScene(map),
        { x: 0, y: 0 },
        null,
      )
      port.transact('spec.dragFrame', (tx) => {
        for (const [id, e] of map) {
          const b = before.get(id)
          const patch: Record<string, unknown> = {}
          for (const f of [...PATH_FIELDS, 'frameId'])
            if (JSON.stringify(e[f]) !== JSON.stringify(b?.[f])) patch[f] = e[f]
          if (Object.keys(patch).length) tx.update(id, patch)
        }
      })
    },
    /**
     * A selection rotation by `delta` radians around the selection's centre (Excalidraw's rotation handle:
     * every element's centre turns around it and its `angle` grows; bound labels turn with their
     * containers; E 23034-23080), with Excalidraw's follow of arrows bound to rotated targets, as one edit.
     */
    rotateSelection(ids: string[], delta: number): void {
      const map = copyScene(port)
      const before = copyScene(port)
      const els = ids.map((i) => map.get(i)).filter(Boolean)
      const [x1, y1, x2, y2] = X.getCommonBounds(els, map) as [number, number, number, number]
      const cx = (x1 + x2) / 2
      const cy = (y1 + y2) / 2
      const turn = (e: El) => {
        const [, , , , ex, ey] = X.getElementAbsoluteCoords(e, map) as [
          number,
          number,
          number,
          number,
          number,
          number,
        ]
        const c = Math.cos(delta)
        const s = Math.sin(delta)
        const nx = cx + (ex - cx) * c - (ey - cy) * s
        const ny = cy + (ex - cx) * s + (ey - cy) * c
        const angle = ((e.angle ?? 0) + delta + 2 * Math.PI) % (2 * Math.PI)
        X.mutateElement(e, map, { x: e.x + nx - ex, y: e.y + ny - ey, angle })
      }
      const moved = new Set<string>()
      for (const e of els) {
        turn(e)
        moved.add(e.id)
        for (const b of e.boundElements ?? []) {
          const l = map.get(b.id)
          if (b.type === 'text' && l && !moved.has(l.id)) {
            turn(l)
            moved.add(l.id)
          }
        }
      }
      for (const e of els)
        if (e.type !== 'arrow') X.updateBoundElements(e, fakeScene(map), { simultaneouslyUpdated: els })
      port.transact('spec.rotateSelection', (tx) => {
        for (const [id, e] of map) {
          const b = before.get(id)
          const patch: Record<string, unknown> = {}
          for (const f of PATH_FIELDS) if (JSON.stringify(e[f]) !== JSON.stringify(b?.[f])) patch[f] = e[f]
          if (Object.keys(patch).length) tx.update(id, patch)
        }
      })
    },
    /**
     * How far a note's label (and the note's height) are from Excalidraw's own sticky-note layout for the
     * note as it is now (`getStickyNoteLayout`: wrap at the note's width, font fit, growth): "the label is
     * re-wrapped for this width". Null when the note has no label.
     */
    noteLayoutError(noteId: string): { text: number; container: number; wrapped: boolean } | null {
      const map = copyScene(port)
      const n = map.get(noteId)
      const lid = (n?.boundElements ?? []).find((b: El) => b.type === 'text')?.id
      const l = lid ? map.get(lid) : null
      if (!n || !l) return null
      const lay = X.getStickyNoteLayout(n, l, { originalText: l.originalText })
      const t = lay.text
      if (!t) return null
      const d = (a: number, b: number) => Math.abs((a ?? 0) - (b ?? 0))
      return {
        text: Math.max(
          d(l.x, t.x),
          d(l.y, t.y),
          d(l.width, t.width),
          d(l.height, t.height),
          d(l.fontSize, t.fontSize),
        ),
        container: d(n.height, lay.container.height),
        wrapped: l.text === t.text,
      }
    },
    /**
     * Samples `followError` of `ids` every `everyMs` (and on every scene change the port reports) until
     * `stopSampling`, which returns the largest error seen per arrow and the number of samples: "the bound
     * end follows the target on every applied write, never reset to the old edge by an ack".
     */
    startSampling(ids: string[], everyMs = 20): void {
      sampler?.stop()
      const max = new Map<string, number>(ids.map((i) => [i, 0]))
      let n = 0
      const take = () => {
        n++
        for (const i of ids) {
          const e = port.get(i) ? followError(i) : 0
          if (e > (max.get(i) ?? 0)) max.set(i, e)
        }
      }
      const t = setInterval(take, everyMs)
      const off = port.on('changed', take)
      sampler = {
        stop: () => {
          clearInterval(t)
          off()
          sampler = null
          return { max: Object.fromEntries(max), samples: n }
        },
      }
    },
    stopSampling(): { max: Record<string, number>; samples: number } | null {
      return sampler?.stop() ?? null
    },
    /** A plain copy of an element's path unit (x, y, points, angle, …), for "whose whole version is stored". */
    pathOf(id: string): Record<string, unknown> | null {
      const e = port.get(id)
      return e ? JSON.parse(JSON.stringify(pathOf(e))) : null
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
      const selfLoop = a.startBinding && a.endBinding && a.startBinding.elementId === a.endBinding.elementId
      X.LinearElementEditor.movePoints(a, fakeScene(map), new Map(ups), {
        moveMidPointsWithElement: !!selfLoop,
      })
      return Math.max(
        ...ups.map(([i], k) => {
          const p = glob(a, i, map)
          const q = before[k]
          return Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
        }),
      )
    },
  }
  return api
}
