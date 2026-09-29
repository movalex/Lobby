/**
 * Scene coordinates of a linear element's points, through Excalidraw's own rotation-aware helper
 * (docs/EXCALIDRAW-MIGRATION.md §2.9.4 rule 7 "Rebasing": scene coordinates are
 * `LinearElementEditor.getPointAtIndexGlobalCoordinates`, E 11212-11223, never `x` + pᵢ). groups.ts's
 * `userSetGeometry` reads points through this wrapper only. Added at the spike B contracts step C0;
 * owned by O1 afterwards like the rest of `engine/**`.
 *
 * The helper rotates `(x + pᵢ)` about the centre of the element's absolute bounds
 * (`getElementAbsoluteCoords`, which for a curved arrow uses the curve's bounds), by `angle`.
 */
import * as element from '@excalidraw/element'
import type { EngineElement } from './types.ts'

type Pt = [number, number]

interface LinearApi {
  getPointAtIndexGlobalCoordinates(el: unknown, index: number, elementsMap: ReadonlyMap<string, unknown>): Pt
}
// A namespace import, re-typed (as raw.ts does): under `nodenext` (apps/sync's settings, the Node-safety check)
// the engine's .d.ts re-exports do not resolve, so its named types cannot be relied on on the server.
const linear = (element as unknown as { LinearElementEditor: LinearApi }).LinearElementEditor

/** A linear element as this wrapper reads it. */
export type LinearLike = Pick<EngineElement, 'id' | 'type' | 'x' | 'y' | 'angle'> & {
  readonly points: readonly (readonly [number, number])[]
}

/**
 * The scene position of point `index` of `el` (negative counts from the end). `elementsMap` is the scene
 * the element lives in; a map holding only the element is enough for its own points.
 */
export function pointAtIndexGlobal(
  el: LinearLike,
  index: number,
  elementsMap: ReadonlyMap<string, unknown> = new Map([[el.id, el]]),
): Pt {
  const p = linear.getPointAtIndexGlobalCoordinates(el, index, elementsMap)
  return [p[0], p[1]]
}
