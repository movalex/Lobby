// OWNER: WS5 (wave T). The cards a timeline draws, read from the canvas: the planning read model's cards (over
// `canvas.index` only, never a walk of the scene) with their title (the first line of the card's text), their tags
// (the board's names) and whether they are locked. Reads only: a timeline never writes except the dates of a bar the
// person drags or nudges (./Overlay.tsx), and a receiving client pushes nothing.
import { items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { cardsOn } from '../planning/index.ts'
import { boardTagsOf, displayTags } from '../tags/ported/model.ts'
import type { TimelineCard } from './layout.ts'

/** The first non-empty line of a card's text: its title. */
export const titleOf = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? ''

interface Cached {
  readonly key: string
  readonly card: TimelineCard
}

/** Per canvas: each card's row by what it depends on, and the last list (reused whole when no row changed). */
const caches = new WeakMap<object, { rows: Map<string, Cached>; last: TimelineCard[] }>()

const versionOf = (el: { version?: unknown } | undefined) => (el ? String(el.version ?? 0) : '-')

/**
 * Every card of the board as the timeline reads it (reactive: call it inside `useValue`). A card's row is built
 * again only when the card, its label (the title) or the board's tag names changed, and the same list comes back
 * while no row changed (a scene change elsewhere, a drag of another element at 60 fps: no title is read again and
 * the timeline sees no change).
 */
export function timelineCards(canvas: LobbyCanvas): TimelineCard[] {
  const entries = canvas.doc.entries('tagDef:')
  const board = boardTagsOf(entries)
  const tagsKey = JSON.stringify([...entries])
  let cache = caches.get(canvas)
  if (!cache) {
    cache = { rows: new Map(), last: [] }
    caches.set(canvas, cache)
  }
  const rows = new Map<string, Cached>()
  const out: TimelineCard[] = []
  let same = true
  for (const { el, card } of cardsOn(canvas)) {
    const label = items.labelOf(el, (id) => canvas.get(id))
    const locked = canvas.isLocked(el.id)
    const key = `${versionOf(el as { version?: unknown })}|${label?.id ?? ''}:${versionOf(label as { version?: unknown } | undefined)}|${locked ? 1 : 0}|${tagsKey}`
    let row = cache.rows.get(el.id)
    if (!row || row.key !== key) {
      row = {
        key,
        card: {
          id: el.id,
          title: titleOf(canvas.text.of(el.id)),
          status: card.status,
          who: card.who,
          start: card.start,
          due: card.due,
          tags: displayTags(el, board).map((t) => ({ key: t.key, name: t.name })),
          locked,
        },
      }
    }
    rows.set(el.id, row)
    if (cache.last[out.length] !== row.card) same = false
    out.push(row.card)
  }
  if (same && out.length === cache.last.length) {
    cache.rows = rows
    return cache.last
  }
  cache.rows = rows
  cache.last = out
  return out
}
