/**
 * Bound connectors during another person's drag (D1, W5-08; docs/EXCALIDRAW-MIGRATION.md §2.7): drawing
 * only, nothing is ever written or pushed.
 *
 * A peer's drag preview moves the dragged elements by a render offset (RenderOverrides). An arrow bound to
 * them is not dragged, so before this it stayed where it was until the drag's commit re-snapped it ("the
 * connector detaches on the other person's screen", DEMO 1:00). Now, per drag frame:
 *  - an arrow whose two ends are bound to elements moved by the same offset moves with them (an offset of
 *    its own; its label follows, as a container's does);
 *  - an arrow with one end on a moved element is re-routed on a COPY with Excalidraw's own binding code
 *    (`updateBoundElements` over copies of the arrow and its targets, the targets moved by the preview's
 *    offset, as the dragger's own screen does), drawn by Lobby's drag-preview layer with Excalidraw's own
 *    shape generator (`arrowPaths`), while the engine draws the real arrow invisible (RenderOverrides
 *    `setPreviewHidden`). When the drag ends, or the committed (re-snapped) arrow arrives, the copy goes.
 *
 * Browser (the element package's helpers); `planDragArrows` itself runs in Node tests too.
 */
import * as ElementNs from '@excalidraw/element'
import type { SceneElement } from '../sync/types.ts'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers, typed loosely on purpose
const X = ElementNs as any
// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element objects
type El = any

export interface DragOffset {
  readonly x: number
  readonly y: number
}

export interface DragArrowPlan {
  /** arrows whose two ends move together: the same offset as their targets */
  readonly moveWith: Map<string, DragOffset>
  /** copies of the arrows with one moved end, re-routed (never written) */
  readonly reroute: El[]
}

const targetOf = (a: El, end: 'startBinding' | 'endBinding'): string | null => a?.[end]?.elementId ?? null

function fakeScene(map: Map<string, El>) {
  return {
    mutateElement: (el: El, u: El, o?: El) => X.mutateElement(el, map, u, o),
    getNonDeletedElementsMap: () => map,
    getElementsMapIncludingDeleted: () => map,
    getNonDeletedElements: () => [...map.values()],
    triggerUpdate: () => {},
  }
}

/**
 * What a peer's drag preview does to the arrows bound to what it drags. `offsets`: the dragged elements
 * (containers and frame children; labels follow their containers) and their offset; `map`: the scene.
 */
export function planDragArrows(
  map: ReadonlyMap<string, SceneElement>,
  offsets: ReadonlyMap<string, DragOffset>,
): DragArrowPlan {
  const moveWith = new Map<string, DragOffset>()
  const reroute: El[] = []
  const arrows = new Set<string>()
  for (const id of offsets.keys())
    for (const b of ((map.get(id) as El)?.boundElements ?? []) as { id: string; type: string }[])
      if (b.type === 'arrow') arrows.add(b.id)
  for (const aid of arrows) {
    if (offsets.has(aid)) continue // dragged itself (selected, or in a dragged frame)
    const a = map.get(aid) as El
    if (!a || a.isDeleted || a.type !== 'arrow') continue
    const s = targetOf(a, 'startBinding')
    const e = targetOf(a, 'endBinding')
    const so = s ? offsets.get(s) : undefined
    const eo = e ? offsets.get(e) : undefined
    if (!so && !eo) continue
    if (so && eo && so.x === eo.x && so.y === eo.y) {
      moveWith.set(aid, so)
      continue
    }
    const local = new Map<string, El>()
    for (const id of [aid, s, e]) {
      if (!id || local.has(id)) continue
      const el = map.get(id)
      if (el && !el.isDeleted) local.set(id, structuredClone(el))
    }
    for (const [tid, o] of [
      [s, so],
      [e, eo],
    ] as const) {
      const t = tid ? local.get(tid) : undefined
      if (t && o) {
        t.x += o.x
        t.y += o.y
      }
    }
    try {
      const scene = fakeScene(local)
      for (const tid of new Set([s, e]))
        if (tid && offsets.has(tid) && local.has(tid)) X.updateBoundElements(local.get(tid), scene)
      reroute.push(local.get(aid))
    } catch (err) {
      // an arrow Excalidraw cannot re-route here keeps its old drawing until the commit
      console.warn('drag preview: a bound arrow could not be re-routed', err)
    }
  }
  return { moveWith, reroute }
}

/** An SVG path of an element's shape (rough.js's `toPaths`), in the element's own coordinates. */
export interface ShapePath {
  readonly d: string
  readonly stroke: string
  readonly strokeWidth: number
  readonly fill: string
}

/**
 * The paths Excalidraw itself would draw for `el` (its shape generator and rough.js generator: the same
 * roughness, seed, dash, arrowheads and theme colours as the canvas), in `el`'s coordinates.
 */
export function arrowPaths(el: El, theme: 'light' | 'dark', background = '#ffffff'): ShapePath[] {
  const shape = X.ShapeCache.generateElementShape(el, {
    isExporting: true,
    canvasBackgroundColor: background,
    embedsValidationStatus: null,
    theme,
  })
  const rg = (X.ShapeCache as { rg?: { toPaths(d: unknown): ShapePath[] } }).rg
  if (!rg) return []
  const list = (Array.isArray(shape) ? shape : [shape]).filter(Boolean)
  return list.flatMap((d: unknown) => rg.toPaths(d))
}
