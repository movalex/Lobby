/**
 * `LobbyCanvas.hitTest` (docs/EXCALIDRAW-CONTRACTS.md §2.1; tldraw's getShapeAtPoint,
 * getSelectedShapeAtPoint, isPointInShape, getHitTestMargin): the element under a scene point by document
 * geometry, as Excalidraw picks it (App.getElementAtPosition: live, not a bound label — its container
 * counts through its label — inside its frame when frames clip, topmost first). Hidden (collapsed)
 * elements never hit. Options:
 *
 *  - `margin`: screen pixels of slack (default: Excalidraw's own threshold at this zoom);
 *  - `hitInside`: a point inside a closed shape counts (default true; false: the outline only);
 *  - `selectedFirst`: an element of the current selection wins over one above it;
 *  - `skipLocked`: locked elements never hit (default: they do; Excalidraw's own picking skips them);
 *  - `filter`: any other test.
 *
 * Browser only (Excalidraw's collision helpers).
 */
import { DEFAULT_COLLISION_THRESHOLD } from '@excalidraw/common'
import {
  getContainingFrame,
  hitElementBoundText,
  hitElementItself,
  isCursorInFrame,
} from '@excalidraw/element'
import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
} from '@excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { pointFrom } from '@excalidraw/math'
import type { GlobalPoint } from '@excalidraw/math/types'
import type { HitTestOptions } from '../api/lobby-canvas.ts'
import type { CanvasElement, ScenePoint } from '../port.ts'

export function hitTest(
  api: ExcalidrawImperativeAPI,
  point: ScenePoint,
  opts: HitTestOptions,
  isHidden: (id: string) => boolean,
): CanvasElement | null {
  const s = api.getAppState()
  const zoom = s.zoom.value
  const live = api.getSceneElements() as readonly ExcalidrawElement[]
  const map = new Map(live.map((e) => [e.id, e])) as unknown as ElementsMap
  const p = pointFrom<GlobalPoint>(point.x, point.y)
  const selected = s.selectedElementIds
  const hits: ExcalidrawElement[] = []
  for (const el of live) {
    if (el.type === 'text' && (el as { containerId?: string | null }).containerId) continue
    if (isHidden(el.id)) continue
    if (opts.skipLocked && el.locked) continue
    if (opts.filter && !opts.filter(el as unknown as CanvasElement)) continue
    const threshold =
      opts.margin !== undefined
        ? opts.margin / zoom
        : Math.max(el.strokeWidth / 2 + 0.1, (0.85 * DEFAULT_COLLISION_THRESHOLD) / zoom)
    const hit =
      hitElementBoundText(p, el, map) ||
      hitElementItself({
        point: p,
        element: el,
        threshold,
        elementsMap: map,
        ...(opts.hitInside === false ? { overrideShouldTestInside: false } : {}),
      } as never)
    if (!hit) continue
    const frame = getContainingFrame(el, map)
    if (frame && s.frameRendering.enabled && s.frameRendering.clip) {
      if (!isCursorInFrame(point, frame as NonDeleted<ExcalidrawFrameLikeElement>, map)) continue
    }
    hits.push(el)
  }
  if (!hits.length) return null
  if (opts.selectedFirst) {
    for (let i = hits.length - 1; i >= 0; i--) {
      const el = hits[i] as ExcalidrawElement
      if (selected[el.id]) return el as unknown as CanvasElement
    }
  }
  return hits[hits.length - 1] as unknown as CanvasElement
}
