// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §2, §6.2). Every card write, each ONE `canvas.transact` (one undo
// step): make, unmake, a status (with the move into its column when the card sits in a Kanban, in the same step), the
// assignee, the dates and the link. Nothing here runs on a change someone else made: these are this person's own
// edits (the echo rule). A write is offered only in a rev-14 room, never read-only, never on a locked card
// (`cardWritable`); the room checks every key again (roles, guests, the assignee, the lock).
import { type CardStatus, cardOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import type { CanvasElement, LobbyCanvas, LobbyTx } from '../../canvas/api/index.ts'
import { appendPlacement, bandOfBox, bandsOf } from '../kanban/layout.ts'
import { boxesIn, kanbanAt, moveCard, rectOf } from '../kanban/scene.ts'
import { planningOffered } from '../planning/index.ts'
import {
  dateProblem,
  fieldLobby,
  isCard,
  isCardable,
  lobbyPatch,
  makeCardLobby,
  unmakeCardLobby,
} from './model.ts'

type Canvas = Pick<LobbyCanvas, 'get' | 'index' | 'transact' | 'isLocked' | 'readOnly' | 'room' | 'selection'>

/** Whether this page may write card fields at all (the switch, a rev-14 room, not read-only). */
export const cardsWritable = (canvas: Pick<LobbyCanvas, 'room' | 'readOnly'>): boolean =>
  planningOffered('cards', canvas)

/** Whether this page may write the card fields of `id` (a live, unlocked card). */
export const cardWritable = (canvas: Canvas, id: string): boolean =>
  cardsWritable(canvas) && isCard(canvas.get(id)) && !canvas.isLocked(id)

/** The selected elements that could become cards now (cardable, unlocked, not cards yet). */
export function makeableIn(canvas: Canvas, ids: readonly string[]): string[] {
  if (!cardsWritable(canvas)) return []
  return ids.filter((id) => {
    const el = canvas.get(id)
    return isCardable(el) && !isCard(el) && !canvas.isLocked(id)
  })
}

/** The selected cards that may be unmade now. */
export const unmakeableIn = (canvas: Canvas, ids: readonly string[]): string[] =>
  ids.filter((id) => cardWritable(canvas, id))

/** A status a card takes when made: its Kanban column's when it sits in one, else "To do". */
function statusWhenMade(canvas: Canvas, el: CanvasElement): CardStatus {
  const k = kanbanAt(canvas, el.frameId)
  if (!k || !planningOffered('kanban', canvas)) return 'todo'
  // the column under its centre (no position is written for a make)
  return bandOfBox(bandsOf(rectOf(k.el), k.value), el)?.status ?? 'todo'
}

/** Makes cards of `ids` (cardable, unlocked, not cards yet) in one step; returns how many it made. */
export function makeCards(canvas: Canvas, ids: readonly string[]): number {
  const todo = makeableIn(canvas, ids)
  if (!todo.length) return 0
  canvas.transact('make card', (tx) => {
    for (const id of todo) {
      const el = canvas.get(id)
      if (el) tx.update(id, lobbyPatch(makeCardLobby(statusWhenMade(canvas, el))))
    }
  })
  return todo.length
}

/** Unmakes the cards of `ids` (every `card:*` key goes) in one step; returns how many. */
export function unmakeCards(canvas: Canvas, ids: readonly string[]): number {
  const todo = unmakeableIn(canvas, ids)
  if (!todo.length) return 0
  canvas.transact('unmake card', (tx) => {
    for (const id of todo) {
      const el = canvas.get(id)
      if (el) tx.update(id, lobbyPatch(unmakeCardLobby(el)))
    }
  })
  return todo.length
}

/**
 * Inside a transaction: `id`'s status becomes `status`, and when it sits in a Kanban (and Kanbans are offered) it
 * moves to the bottom of that column, the frame growing to hold it, in the same step.
 */
export function writeStatus(canvas: Canvas, tx: LobbyTx, id: string, status: CardStatus): void {
  const el = canvas.get(id)
  if (!el) return
  tx.update(id, lobbyPatch(fieldLobby('status', status)))
  const k = kanbanAt(canvas, el.frameId)
  if (!k || !planningOffered('kanban', canvas) || canvas.isLocked(k.el.id)) return
  const box = { id, x: el.x, y: el.y, width: el.width, height: el.height, status }
  const place = appendPlacement(rectOf(k.el), k.value, status, box, boxesIn(canvas, k.el.id))
  if (!place) return
  moveCard(canvas, tx, id, place.at)
  if (place.frameHeight !== null) tx.update(k.el.id, { height: place.frameHeight })
}

/** Sets the status of the writable cards among `ids` (one step); returns how many changed. */
export function setStatus(canvas: Canvas, ids: readonly string[], status: CardStatus): number {
  const todo = ids.filter((id) => {
    if (!cardWritable(canvas, id)) return false
    return cardOf(canvas.get(id) as PlanningElement)?.status !== status
  })
  if (!todo.length) return 0
  canvas.transact('card status', (tx) => {
    for (const id of todo) writeStatus(canvas, tx, id, status)
  })
  return todo.length
}

export type FieldResult = { ok: true } | { ok: false; problem: string }

/** Sets one card's assignee (a member's uid) or clears it (null), one step. */
export function setWho(canvas: Canvas, id: string, uid: string | null): FieldResult {
  if (!cardWritable(canvas, id)) return { ok: false, problem: 'This card cannot be changed here.' }
  const card = cardOf(canvas.get(id) as PlanningElement)
  if (card?.who === uid) return { ok: true }
  canvas.transact(uid ? 'assign card' : 'unassign card', (tx) =>
    tx.update(id, lobbyPatch(fieldLobby('who', uid))),
  )
  return { ok: true }
}

/** Sets or clears one card's start or due date (the start is never after the due date), one step. */
export function setDate(
  canvas: Canvas,
  id: string,
  field: 'start' | 'due',
  value: string | null,
): FieldResult {
  if (!cardWritable(canvas, id)) return { ok: false, problem: 'This card cannot be changed here.' }
  const card = cardOf(canvas.get(id) as PlanningElement)
  if (!card) return { ok: false, problem: 'This is no card.' }
  const v = value === '' ? null : value
  const problem = dateProblem(card, field, v)
  if (problem) return { ok: false, problem }
  if (card[field] === v) return { ok: true }
  canvas.transact(field === 'start' ? 'card start' : 'card due', (tx) =>
    tx.update(id, lobbyPatch(fieldLobby(field, v))),
  )
  return { ok: true }
}

/** Sets or clears a card's link (the element's native `link`), one step; `allowed` is the schema's link rule. */
export function setLink(
  canvas: Canvas,
  id: string,
  link: string | null,
  allowed: (link: string) => boolean,
): FieldResult {
  if (!cardWritable(canvas, id)) return { ok: false, problem: 'This card cannot be changed here.' }
  const v = link?.trim() || null
  if (v && !allowed(v)) return { ok: false, problem: 'Use a web address (https://…) or a Lobby link.' }
  const el = canvas.get(id) as (CanvasElement & { link?: string | null }) | undefined
  if ((el?.link ?? null) === v) return { ok: true }
  canvas.transact('card link', (tx) => tx.update(id, { link: v }))
  return { ok: true }
}
