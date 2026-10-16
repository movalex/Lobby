// OWNER: WS4 (wave T). The card table's rows as the scene holds them (through `canvas.index`: features/planning
// `cardsOn`), with the words people read: the title (a card's label), the assignee's name, the tags as the board names
// them, the link and where the card sits. And the paste: the new cards in ONE undo step, as a grid or into a Kanban.
import { kanbanOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import type { CardsState } from '../cards/bridge.ts'
import { lobbyPatch } from '../cards/model.ts'
import { personView } from '../cards/people.ts'
import { cardsWritable } from '../cards/write.ts'
import { appendPlacement, type CardBox } from '../kanban/layout.ts'
import { boxesIn, kanbanAt, rectOf } from '../kanban/scene.ts'
import { cardsOn } from '../planning/index.ts'
import { tagsOf } from '../tags/ported/bridge.ts'
import { displayTags } from '../tags/ported/model.ts'
import { gridPlacements, IMPORT_CARD, type ImportCard, type TableRow } from './model.ts'

/** Every card on the board as a row (the board's paint order), or only those of `only`. */
export function tableRows(
  ctx: CanvasFeatureContext,
  cards: CardsState | null,
  today: string,
  only?: ReadonlySet<string>,
): TableRow[] {
  const canvas = ctx.canvas
  const board = tagsOf(canvas)?.rt.board.get()
  const out: TableRow[] = []
  for (const { el, card } of cardsOn(canvas)) {
    if (only && !only.has(el.id)) continue
    const frame = el.frameId ? canvas.get(el.frameId) : undefined
    const place =
      frame && !(frame as { isDeleted?: boolean }).isDeleted
        ? ((frame as { name?: string | null }).name ?? '') ||
          (kanbanOf(frame as PlanningElement) ? 'Kanban' : 'Frame')
        : ''
    out.push({
      id: el.id,
      title: canvas.text.of(el.id).trim(),
      card,
      who: card.who ? (cards ? personView(ctx, cards.people, card.who).name : 'Someone') : '',
      tags: board ? displayTags(el, board).map((t) => t.name) : [],
      link: ((el as { link?: string | null }).link ?? '') as string,
      place,
      overdue: card.due !== null && card.status !== 'done' && card.due < today,
    })
  }
  return out
}

/** Where pasted cards go: a Kanban (into their status's columns) when one is the target, else a grid in view. */
export function createCards(
  canvas: Pick<
    LobbyCanvas,
    'transact' | 'viewport' | 'get' | 'index' | 'select' | 'isLocked' | 'room' | 'readOnly'
  >,
  cards: readonly ImportCard[],
  kanbanId: string | null,
): string[] {
  if (!cards.length || !cardsWritable(canvas)) return []
  const k = kanbanId && !canvas.isLocked(kanbanId) ? kanbanAt(canvas, kanbanId) : null
  const v = canvas.viewport.get()
  const grid = gridPlacements(cards.length, { x: v.x + v.width / 2, y: v.y + v.height / 2 })
  // into a Kanban: each at the bottom of its column, after the ones placed before it
  const placed: CardBox[] = k ? boxesIn(canvas, k.el.id) : []
  let frameHeight: number | null = null
  const at = cards.map((c, i) => {
    if (!k) return grid[i] as { x: number; y: number }
    const frame = { ...rectOf(k.el), height: frameHeight ?? k.el.height }
    const box: CardBox = {
      id: `new-${i}`,
      x: 0,
      y: 0,
      width: IMPORT_CARD,
      height: IMPORT_CARD,
      status: c.status,
    }
    const p = appendPlacement(frame, k.value, c.status, box, placed)
    if (!p) return grid[i] as { x: number; y: number }
    placed.push({ ...box, x: p.at.x, y: p.at.y })
    if (p.frameHeight !== null) frameHeight = p.frameHeight
    return p.at
  })
  const ids = canvas.transact('paste cards', (tx) =>
    cards.map((c, i) => {
      const lobby: Record<string, unknown> = { 'card:status': c.status }
      if (c.who) lobby['card:who'] = c.who
      if (c.start) lobby['card:start'] = c.start
      if (c.due) lobby['card:due'] = c.due
      const p = at[i] as { x: number; y: number }
      return tx.create('note', { x: p.x, y: p.y, size: IMPORT_CARD, text: c.title, ...lobbyPatch(lobby) })
    }),
  )
  // links and the Kanban in a second write folded into the same undo step: the port drops an update to an element
  // created in the same transaction (canvas/port-impl.ts), so they go on once the notes exist
  const links = cards.flatMap((c, i) => (c.link ? [[ids[i] as string, c.link] as const] : []))
  if (k || links.length)
    canvas.transact(
      'paste cards',
      (tx) => {
        if (k) {
          tx.setFrame(ids, k.el.id)
          if (frameHeight !== null) tx.update(k.el.id, { height: frameHeight })
        }
        for (const [id, link] of links) tx.update(id, { link })
      },
      { joinPrevious: true },
    )
  canvas.select(ids)
  if (ids.length) canvas.viewport.ensureVisible(ids, { margin: 60 })
  return ids
}
