// User-visible words for tags, in one place (pure; tested).

import { MAX_TAGS_PER_SHAPE } from '@draftroom/contracts'

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "note", "card" or "item" for what a selection holds. */
export function thingName(kinds: { notes: number; cards: number }): { one: string; many: string } {
  if (kinds.cards === 0) return { one: 'note', many: 'notes' }
  if (kinds.notes === 0) return { one: 'card', many: 'cards' }
  return { one: 'item', many: 'items' }
}

/** After an add that had to leave out full shapes. */
export function fullNotice(full: number, thing: { one: string; many: string }): string | null {
  if (full <= 0) return null
  return full === 1
    ? `1 ${thing.one} already has ${MAX_TAGS_PER_SHAPE} tags, so it was left out.`
    : `${full} ${thing.many} already have ${MAX_TAGS_PER_SHAPE} tags, so they were left out.`
}

/** How many shapes carry a tag, for the panel and the filter bar. */
export const usageLabel = (count: number) => (count === 0 ? 'Not used yet' : `On ${plural(count, 'item')}`)

export const READONLY_HINT =
  'You can see and filter tags. Only people who can edit this board can change them.'
