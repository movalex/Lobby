// Select by type (MAK-17): "Select all notes / images / text / connectors… on this page" and "Keep only
// notes / images…" for the current selection. The categories are board search's type filters, so the
// two features never disagree on what an "image" is. Pure; the editor wiring is select-by-type-runtime.ts.
//
// Rules:
//  - Locked shapes (or shapes inside a locked frame/group) and hidden shapes are never selected, as
//    tldraw's own Select all does.
//  - "Keep only" looks inside selected frames and groups too: select a frame, keep only images, and the
//    frame's images are selected (the frame itself is not an image).
//  - A shape is dropped when a frame/group around it is also in the result (it moves with it anyway,
//    and tldraw should never be handed a parent and its child as one selection).

import { SEARCH_FILTERS, type SearchFilter } from './search-filter.ts'

export type TypeCategory = Exclude<SearchFilter, 'all'>

/** Menu order: the categories people ask for most first. */
export const TYPE_CATEGORY_ORDER: readonly TypeCategory[] = [
  'notes',
  'images',
  'text',
  'connectors',
  'shapes',
  'frames',
  'files',
]

export const TYPE_CATEGORIES: readonly { id: TypeCategory; label: string; types: readonly string[] }[] =
  TYPE_CATEGORY_ORDER.map((id) => {
    const f = SEARCH_FILTERS.find((x) => x.id === id)
    if (!f) throw new Error(`canvas-ux: unknown type category ${id}`)
    return { id, label: f.label, types: f.types }
  })

export function categoryOf(type: string): TypeCategory | null {
  return TYPE_CATEGORIES.find((c) => c.types.includes(type))?.id ?? null
}

export function categoryLabel(category: TypeCategory): string {
  return TYPE_CATEGORIES.find((c) => c.id === category)?.label ?? category
}

export interface ShapeLite {
  id: string
  type: string
  /** Ancestor shape ids (frames, groups), innermost first. */
  ancestors: readonly string[]
  /** The shape or one of its ancestors is locked. */
  locked: boolean
  hidden?: boolean
}

/** Ids of the shapes in `shapes` of `category` that can be selected, without parent/child pairs. */
export function pickCategory(shapes: readonly ShapeLite[], category: TypeCategory): string[] {
  const types = TYPE_CATEGORIES.find((c) => c.id === category)?.types ?? []
  const picked = shapes.filter((s) => types.includes(s.type) && !s.locked && !s.hidden)
  const ids = new Set(picked.map((s) => s.id))
  return picked.filter((s) => !s.ancestors.some((a) => ids.has(a))).map((s) => s.id)
}

/** How many selectable shapes of each category `shapes` holds (categories with none are omitted). */
export function countCategories(
  shapes: readonly ShapeLite[],
): { id: TypeCategory; label: string; count: number }[] {
  const out: { id: TypeCategory; label: string; count: number }[] = []
  for (const c of TYPE_CATEGORIES) {
    const count = pickCategory(shapes, c.id).length
    if (count > 0) out.push({ id: c.id, label: c.label, count })
  }
  return out
}

/**
 * "Keep only" is worth offering when it changes something: the selection (with what is inside its frames
 * and groups) holds more than one category, or holds nested shapes of a category the selection itself
 * is not (a frame with notes in it).
 */
export function keepOnlyChoices(
  selected: readonly ShapeLite[],
  withDescendants: readonly ShapeLite[],
): { id: TypeCategory; label: string; count: number }[] {
  const counts = countCategories(withDescendants)
  const selectedIds = selected
    .map((s) => s.id)
    .sort()
    .join(' ')
  return counts.filter((c) => pickCategory(withDescendants, c.id).sort().join(' ') !== selectedIds)
}
