// OWNER: WS5 (wave T). The cards a timeline draws, read from the canvas: the planning read model's cards (over
// `canvas.index` only, never a walk of the scene) with their title (the first line of the card's text), their tags
// (the board's names) and whether they are locked. Reads only: a timeline never writes except the dates of a bar the
// person drags or nudges (./Overlay.tsx), and a receiving client pushes nothing.
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { cardsOn } from '../planning/index.ts'
import { boardTagsOf, displayTags } from '../tags/ported/model.ts'
import type { TimelineCard } from './layout.ts'

/** The first non-empty line of a card's text: its title. */
export const titleOf = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? ''

/** Every card of the board as the timeline reads it (reactive: call it inside `useValue`). */
export function timelineCards(canvas: LobbyCanvas): TimelineCard[] {
  const board = boardTagsOf(canvas.doc.entries('tagDef:'))
  return cardsOn(canvas).map(({ el, card }) => ({
    id: el.id,
    title: titleOf(canvas.text.of(el.id)),
    status: card.status,
    who: card.who,
    start: card.start,
    due: card.due,
    tags: displayTags(el, board).map((t) => ({ key: t.key, name: t.name })),
    locked: canvas.isLocked(el.id),
  }))
}
