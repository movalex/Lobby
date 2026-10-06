/**
 * OWNER: 3a (canvas tools). W5-11 (the wave-5 review): a connector you draw ends on the outlines of the
 * shapes it joins, as on the tldraw page (its arrows are clipped to both shapes, a precise anchor included).
 *
 * Excalidraw 0.18's arrow tool binds an end it holds still inside a shape for 700 ms (`BIND_MODE_TIMEOUT`)
 * in `inside` mode: the end sits at the anchor itself, so a connector drawn from inside one note to inside
 * another runs centre to centre through both, and exports look the same. Its `orbit` mode keeps the same
 * anchor (`fixedPoint`, the point the connector aims at) but ends the line on the shape's outline, one
 * orbit gap out (W5-53: 1 + stroke / 2, 2 px for the default stroke; the pnpm patch of @excalidraw/element in
 * patches/ made it, the engine's own was 5 + stroke / 2). So, once the gesture has ended (and for pasted
 * connectors), an `inside` end becomes an `orbit` end with the same anchor, and its point moves to where
 * Excalidraw's own `updateBoundPoint` puts an orbit end. Excalidraw also leaves the start of a connector
 * drawn out of a shape where the press was, inside it, until something re-routes it: that end moves onto the
 * outline the same way. The server re-snaps bound ends with the same code on the arrow's `path` write (plan
 * §2.4.3 step 9), so every tab ends up with these points.
 *
 * Left as they are: elbow connectors (they route by fixed points), rotated ones, an end bound to a frame
 * (a connector pointing at a spot inside a frame keeps pointing there), and a connector whose two ends are
 * bound to the same shape (an arrow drawn inside one shape).
 */

import { LinearElementEditor, updateBoundPoint } from '@excalidraw/element'
import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  ExcalidrawElement,
  FixedPointBinding,
} from '@excalidraw/element/types'

type Binding = FixedPointBinding | null | undefined

/** The fields the outline write sets on a connector (one `tx.update`). */
export interface OutlinePatch {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly points: readonly (readonly [number, number])[]
  readonly startBinding: Binding
  readonly endBinding: Binding
}

const isFrame = (el: ExcalidrawElement) => el.type === 'frame' || el.type === 'magicframe'

/** How far (scene units) an end may sit from where Excalidraw's orbit rule puts it (plan §3.5's tolerance). */
const TOLERANCE = 0.5

/** The end's target when this end is to end on its outline, else null. */
function boundTarget(
  binding: Binding,
  other: Binding,
  map: ReadonlyMap<string, ExcalidrawElement>,
): ExcalidrawBindableElement | null {
  if (!binding || (binding.mode !== 'inside' && binding.mode !== 'orbit')) return null
  if (other?.elementId === binding.elementId) return null
  const t = map.get(binding.elementId)
  if (!t || t.isDeleted || isFrame(t)) return null
  return t as ExcalidrawBindableElement
}

/**
 * The write that puts `arrow`'s bound ends on their shapes' outlines, or null when they are there already:
 * an `inside` end becomes an `orbit` end with the same anchor, and an end the engine left where the press
 * was (it does so for the start of a connector drawn out of a shape) moves to where the orbit rule puts it.
 * `elements` is the scene (live elements). Pure: reads only its arguments.
 */
export function connectorOutlinePatch(
  arrow: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): OutlinePatch | null {
  if (arrow.type !== 'arrow' || arrow.isDeleted) return null
  const a = arrow as ExcalidrawArrowElement
  if ((a as { elbowed?: boolean }).elbowed || a.angle !== 0 || a.points.length < 2) return null
  const map = new Map<string, ExcalidrawElement>(elements.map((e) => [e.id, e]))
  const start = boundTarget(a.startBinding, a.endBinding, map)
  const end = boundTarget(a.endBinding, a.startBinding, map)
  if (!start && !end) return null
  const orbit = (b: Binding, t: ExcalidrawBindableElement | null): Binding =>
    b && t ? { ...b, mode: 'orbit' } : b
  const next = {
    ...a,
    startBinding: orbit(a.startBinding, start),
    endBinding: orbit(a.endBinding, end),
  } as ExcalidrawArrowElement
  map.set(next.id, next)
  const elementsMap = map as unknown as ElementsMap
  const points = next.points.map((p) => [p[0], p[1]] as [number, number])
  const last = points.length - 1
  let moved = a.startBinding?.mode === 'inside' && !!start
  moved ||= a.endBinding?.mode === 'inside' && !!end
  const put = (i: number, p: readonly [number, number] | null) => {
    const q = points[i] as [number, number]
    if (!p || (Math.abs(p[0] - q[0]) <= TOLERANCE && Math.abs(p[1] - q[1]) <= TOLERANCE)) return
    points[i] = [p[0], p[1]]
    moved = true
  }
  if (start) put(0, updateBoundPoint(next as never, 'startBinding', next.startBinding, start, elementsMap))
  if (end) put(last, updateBoundPoint(next as never, 'endBinding', next.endBinding, end, elementsMap))
  if (!moved) return null
  const placed = { ...next, points } as unknown as ExcalidrawArrowElement
  const norm = LinearElementEditor.getNormalizeElementPointsAndCoords(placed as never)
  const xs = norm.points.map((p) => p[0])
  const ys = norm.points.map((p) => p[1])
  return {
    x: norm.x,
    y: norm.y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: norm.points.map((p) => [p[0], p[1]] as const),
    startBinding: next.startBinding,
    endBinding: next.endBinding,
  }
}
