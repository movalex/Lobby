// OWNER: the wave T foundation (the lead); READ-ONLY for WS2-WS5 (docs/WAVE-T-CONTRACTS.md §6.2): the board's cards,
// storyboards, Kanbans and timelines as the scene holds them, read through `canvas.index` (never a walk of the whole
// scene: the index answers by key, fresh inside `canvas.on('change')`), with canvas-schema's pure planning model
// (`@draftroom/canvas-schema/planning`: order, shot numbers, timings, bands, timeline maths) on top. Nothing here
// writes: every planning write is its workstream's, through `canvas.transact` (one undo step), and only the actor's
// tab ever writes a layout, a renumbering or a status that follows a move (the echo rule, AGENTS.md).
import {
  CARD_STATUS_KEY,
  type CardFields,
  cardOf,
  KANBAN_KEY,
  type KanbanValue,
  kanbanOf,
  type PlanningElement,
  SB_HEAD_KEY,
  SB_OF_KEY,
  type Storyboard,
  storyboardsOf,
  TIMELINE_KEY,
  type TimelineValue,
  timelineOf,
} from '@draftroom/canvas-schema/planning'
import type { CanvasElement } from '../../canvas/api/index.ts'

/** What the model reads of the canvas: its scene index only. */
export interface PlanningScene {
  readonly index: {
    withLobbyKey(key: string): readonly CanvasElement[]
    byFrame(frameId: string): readonly CanvasElement[]
  }
}

export interface Card {
  readonly el: CanvasElement
  readonly card: CardFields
}

/** Every card on the board (an element with a valid `card:status`), in the index's paint order. */
export function cardsOn(scene: PlanningScene): Card[] {
  const out: Card[] = []
  for (const el of scene.index.withLobbyKey(CARD_STATUS_KEY)) {
    const card = cardOf(el as PlanningElement)
    if (card && !el.isDeleted) out.push({ el, card })
  }
  return out
}

/** The cards inside a frame (a Kanban's or a timeline's children). */
export function cardsIn(scene: PlanningScene, frameId: string): Card[] {
  const out: Card[] = []
  for (const el of scene.index.byFrame(frameId)) {
    const card = cardOf(el as PlanningElement)
    if (card && !el.isDeleted) out.push({ el, card })
  }
  return out
}

/** Every storyboard on the board by id (its head's element id), panels in order (a missing head: null). */
export function storyboardsOn(scene: PlanningScene): Map<string, Storyboard<CanvasElement>> {
  const els = new Map<string, CanvasElement>()
  for (const key of [SB_HEAD_KEY, SB_OF_KEY])
    for (const el of scene.index.withLobbyKey(key)) if (!el.isDeleted) els.set(el.id, el)
  return storyboardsOf([...els.values()] as (CanvasElement & PlanningElement)[]) as Map<
    string,
    Storyboard<CanvasElement>
  >
}

/** The storyboard a selected element belongs to: a head, a panel, or an element inside a panel. */
export function storyboardOfSelection(
  boards: ReadonlyMap<string, Storyboard<CanvasElement>>,
  el: Pick<CanvasElement, 'id' | 'frameId'>,
): Storyboard<CanvasElement> | null {
  for (const sb of boards.values()) {
    if (sb.id === el.id) return sb
    if (sb.panels.some((p) => p.id === el.id || p.id === el.frameId)) return sb
  }
  return null
}

export interface PlanningFrame<V> {
  readonly el: CanvasElement
  readonly value: V
}

/** Every Kanban frame on the board. */
export function kanbansOn(scene: PlanningScene): PlanningFrame<KanbanValue>[] {
  const out: PlanningFrame<KanbanValue>[] = []
  for (const el of scene.index.withLobbyKey(KANBAN_KEY)) {
    const value = kanbanOf(el as PlanningElement)
    if (value && !el.isDeleted) out.push({ el, value })
  }
  return out
}

/** Every timeline frame on the board. */
export function timelinesOn(scene: PlanningScene): PlanningFrame<TimelineValue>[] {
  const out: PlanningFrame<TimelineValue>[] = []
  for (const el of scene.index.withLobbyKey(TIMELINE_KEY)) {
    const value = timelineOf(el as PlanningElement)
    if (value && !el.isDeleted) out.push({ el, value })
  }
  return out
}
