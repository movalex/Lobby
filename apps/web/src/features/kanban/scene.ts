// OWNER: WS4 (wave T). The Kanbans as the scene holds them, read through `canvas.index` (never a walk of the scene):
// a frame's `kanban` value and the card boxes inside it, for the overlay, the drop runtime, Tidy and the card writes.
import { cardOf, type KanbanValue, kanbanOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import type { CardBox, Rect } from './layout.ts'

export interface KanbanFrame {
  readonly el: CanvasElement
  readonly value: KanbanValue
}

type Reader = Pick<LobbyCanvas, 'get' | 'index'>

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The Kanban a frame id names, or null (no frame, deleted, or no valid `kanban`). */
export function kanbanAt(canvas: Reader, frameId: string | null | undefined): KanbanFrame | null {
  if (!frameId) return null
  const el = canvas.get(frameId)
  if (!live(el)) return null
  const value = kanbanOf(el as PlanningElement)
  return value ? { el, value } : null
}

export const rectOf = (el: CanvasElement): Rect => ({ x: el.x, y: el.y, width: el.width, height: el.height })

/** The cards inside a frame as boxes (their own unrotated rectangles). */
export function boxesIn(canvas: Reader, frameId: string): CardBox[] {
  const out: CardBox[] = []
  for (const el of canvas.index.byFrame(frameId)) {
    if (!live(el)) continue
    const card = cardOf(el as PlanningElement)
    if (card)
      out.push({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height, status: card.status })
  }
  return out
}

/** The Kanban frame whose rectangle holds scene point `p` (the topmost when frames overlap), or null. */
export function kanbanUnder(
  canvas: Pick<LobbyCanvas, 'index'>,
  p: { x: number; y: number },
  skip?: string,
): KanbanFrame | null {
  let hit: KanbanFrame | null = null
  for (const el of canvas.index.withLobbyKey('kanban')) {
    if (!live(el) || el.id === skip) continue
    const value = kanbanOf(el as PlanningElement)
    if (!value) continue
    if (p.x >= el.x && p.x <= el.x + el.width && p.y >= el.y && p.y <= el.y + el.height) hit = { el, value }
  }
  return hit
}
