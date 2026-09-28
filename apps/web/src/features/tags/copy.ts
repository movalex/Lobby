// User-visible words for tags, in one place (pure; tested).

import { MAX_TAGS_PER_SHAPE } from '@draftroom/contracts'

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "note", "card", "image", "shape" or (a mix) "item" for what a selection holds. */
export function thingName(kinds: { notes: number; cards: number; images?: number; shapes?: number }): {
  one: string
  many: string
} {
  const images = kinds.images ?? 0
  const shapes = kinds.shapes ?? 0
  const present = [kinds.notes, kinds.cards, images, shapes].filter((n) => n > 0).length
  if (present > 1) return { one: 'item', many: 'items' }
  if (kinds.cards > 0) return { one: 'card', many: 'cards' }
  if (images > 0) return { one: 'image', many: 'images' }
  if (shapes > 0) return { one: 'shape', many: 'shapes' }
  return { one: 'note', many: 'notes' }
}

/** The counts thingName takes, from the shapes' types. */
export function kindCounts(types: Iterable<string>, fileCardType: string) {
  const out = { notes: 0, cards: 0, images: 0, shapes: 0 }
  for (const t of types) {
    if (t === 'note') out.notes++
    else if (t === fileCardType) out.cards++
    else if (t === 'image' || t === 'video') out.images++
    else out.shapes++
  }
  return out
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
