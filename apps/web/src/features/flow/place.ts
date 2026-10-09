// OWNER: W4 (wave L, L4-3). Where a pasted diagram goes: bulk paste's rule (canvas-ux bulk-paste.ts
// placeBulkGrid, RETRO-01): the empty spot nearest the paste point, inside the unlocked frame under it when the
// diagram fits there, else on the open canvas; never over what is already on the board. Reads the canvas only.
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { items } from '../../canvas/api/index.ts'
import { placeBulkGrid } from '../canvas-ux/bulk-paste.ts'
import { boxOfElement } from './planner.ts'

type Reader = Pick<LobbyCanvas, 'items' | 'get' | 'isHidden'>

/** The smallest unlocked frame holding `p`, or null. */
function frameUnder(reader: Reader, p: { x: number; y: number }): CanvasElement | null {
  let best: { el: CanvasElement; area: number } | null = null
  for (const el of reader.items()) {
    if (el.type !== 'frame' || el.isDeleted || el.locked) continue
    const b = boxOfElement(el)
    if (p.x < b.x || p.y < b.y || p.x > b.x + b.w || p.y > b.y + b.h) continue
    if (!best || b.w * b.h < best.area) best = { el, area: b.w * b.h }
  }
  return best?.el ?? null
}

/** The top-left a `size` diagram pasted at `center` takes, and the frame it goes in (or null). */
export function placeDiagram(
  reader: Reader,
  size: { w: number; h: number },
  center: { x: number; y: number },
): { origin: { x: number; y: number }; frameId: string | null } {
  const content = items.contentItems(reader.items()).filter((e) => !reader.isHidden(e.id))
  const frame = frameUnder(reader, center)
  const rects = (list: readonly CanvasElement[]) => list.map((e) => boxOfElement(e))
  const placement = placeBulkGrid({
    size,
    center,
    frame: frame ? boxOfElement(frame) : null,
    frameObstacles: frame ? rects(content.filter((e) => e.frameId === frame.id)) : [],
    pageObstacles: rects(content.filter((e) => !e.frameId)),
  })
  return { origin: placement.topLeft, frameId: frame && placement.inFrame ? frame.id : null }
}
