// OWNER: WS4 (wave T). The Kanban's own writes, each ONE `canvas.transact` (one undo step) and only ever this person's
// (a button, a menu): a new Kanban, a frame made one or plain again, a column's label, hidden columns and WIP
// limits (the frame's `kanban` value, written whole), and Tidy (the actor's re-layout). A reader never runs any.
import type { KanbanValue } from '@draftroom/canvas-schema/planning'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { lobbyPatch } from '../cards/model.ts'
import { planningOffered } from '../planning/index.ts'
import { newKanbanSize, tidyPlan } from './layout.ts'
import { boxesIn, kanbanAt, moveCard, rectOf } from './scene.ts'

type Canvas = Pick<
  LobbyCanvas,
  'get' | 'index' | 'transact' | 'isLocked' | 'readOnly' | 'room' | 'viewport' | 'select'
>

/** Whether this page may write Kanban values now (the switch, a rev-14 room, not read-only). */
export const kanbanWritable = (canvas: Pick<LobbyCanvas, 'room' | 'readOnly'>): boolean =>
  planningOffered('kanban', canvas)

/** Whether this page may change the Kanban `frameId` (writable and the frame unlocked). */
export const kanbanFrameWritable = (canvas: Canvas, frameId: string): boolean =>
  kanbanWritable(canvas) && kanbanAt(canvas, frameId) !== null && !canvas.isLocked(frameId)

/** Whether `id` is a plain frame that could become a Kanban (no planning frame key, unlocked). */
export function convertible(canvas: Canvas, id: string): boolean {
  const el = canvas.get(id)
  if (el?.type !== 'frame' || (el as { isDeleted?: boolean }).isDeleted || canvas.isLocked(id)) return false
  const lobby = el.customData?.lobby ?? {}
  return !('kanban' in lobby) && !('timeline' in lobby) && !('sb:of' in lobby) && !('sb:pos' in lobby)
}

/** A new, empty Kanban in the middle of the view; returns its id. */
export function createKanban(canvas: Canvas): string | null {
  if (!kanbanWritable(canvas)) return null
  const value: KanbanValue = {}
  const size = newKanbanSize(value)
  const v = canvas.viewport.get()
  const x = Math.round(v.x + v.width / 2 - size.width / 2)
  const y = Math.round(v.y + v.height / 2 - size.height / 2)
  const id = canvas.transact('new kanban', (tx) =>
    tx.create('frame', {
      x,
      y,
      width: size.width,
      height: size.height,
      name: 'Kanban',
      ...lobbyPatch({ kanban: value }),
    }),
  )
  canvas.select([id])
  canvas.viewport.ensureVisible([id], { margin: 40 })
  return id
}

/** Makes a plain frame a Kanban (its cards keep their status; Tidy lays them out). */
export function makeKanban(canvas: Canvas, frameId: string): boolean {
  if (!kanbanWritable(canvas) || !convertible(canvas, frameId)) return false
  canvas.transact('use as kanban', (tx) => tx.update(frameId, lobbyPatch({ kanban: {} })))
  return true
}

/** Makes a Kanban a plain frame again (its cards stay cards, where they are). */
export function unmakeKanban(canvas: Canvas, frameId: string): boolean {
  if (!kanbanFrameWritable(canvas, frameId)) return false
  canvas.transact('plain frame', (tx) => tx.update(frameId, lobbyPatch({ kanban: null })))
  return true
}

/** Writes a Kanban's whole `kanban` value (labels, hidden columns, WIP), one step. */
export function writeKanban(
  canvas: Canvas,
  frameId: string,
  value: KanbanValue,
  label = 'kanban columns',
): boolean {
  if (!kanbanFrameWritable(canvas, frameId)) return false
  canvas.transact(label, (tx) => tx.update(frameId, lobbyPatch({ kanban: value })))
  return true
}

/** Tidy: every card into its status's column, stacked; the frame grows to hold them. Returns how many moved. */
export function tidyKanban(canvas: Canvas, frameId: string): number {
  if (!kanbanFrameWritable(canvas, frameId)) return 0
  const k = kanbanAt(canvas, frameId)
  if (!k) return 0
  const cards = boxesIn(canvas, frameId).filter((c) => !canvas.isLocked(c.id))
  const { moves, frameHeight } = tidyPlan(rectOf(k.el), k.value, cards)
  if (!moves.size && frameHeight === null) return 0
  canvas.transact('tidy kanban', (tx) => {
    if (frameHeight !== null) tx.update(frameId, { height: frameHeight })
    for (const [id, at] of moves) moveCard(canvas, tx, id, at)
  })
  return moves.size
}
