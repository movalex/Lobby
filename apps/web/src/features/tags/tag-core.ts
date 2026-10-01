// The engine-neutral rules of tags (pure; contracts only): order, the board's list as a map, chips, the
// colour a new tag gets, and what a typed name means. Shared by the tldraw feature (./model.ts, which
// re-exports these) and the ported one (./ported/model.ts), so both boards decide the same way.

import {
  MAX_TAGS_PER_BOARD,
  normalizeTagName,
  TAG_COLOR_ROTATION,
  type TagColor,
  type TagDef,
  tagKey,
  tagNameError,
} from '@draftroom/contracts'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
export function compareTags(a: TagDef, b: TagDef): number {
  return collator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

export type BoardTagMap = ReadonlyMap<string, TagDef>

export function boardTagMap(list: readonly TagDef[]): BoardTagMap {
  return new Map(list.map((t) => [t.key, t]))
}

/** Same entries (key, name, colour), in any order. */
export function sameBoardTags(a: BoardTagMap, b: BoardTagMap): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [key, t] of a) {
    const o = b.get(key)
    if (!o || o.name !== t.name || o.color !== t.color) return false
  }
  return true
}

/**
 * Which chips a shape shows: all of up to three; with more, the first two and "+N" (three names and a
 * counter on a 200 px note leave every name a few letters).
 */
export function chipLayout(tags: readonly TagDef[]): { shown: readonly TagDef[]; more: number } {
  if (tags.length <= 3) return { shown: tags, more: 0 }
  return { shown: tags.slice(0, 2), more: tags.length - 2 }
}

/** A name short enough to always show whole on a chip (8 characters). */
export const isShortTagName = (name: string) => [...name].length <= 8

export interface BoardTagRow extends TagDef {
  /** Taggable shapes carrying it (all pages). */
  count: number
  /** In the board's list (false: only shapes carry it). */
  listed: boolean
}

/**
 * Every tag on the board: the listed ones and the ones items carry, with counts; sorted by name.
 * `carried` yields each taggable item's own tags.
 */
export function tagRowsOf(board: BoardTagMap, carried: Iterable<readonly TagDef[]>): BoardTagRow[] {
  const rows = new Map<string, BoardTagRow>()
  for (const t of board.values()) rows.set(t.key, { ...t, count: 0, listed: true })
  for (const tags of carried) {
    for (const t of tags) {
      const row = rows.get(t.key)
      if (row) row.count++
      else rows.set(t.key, { ...t, count: 1, listed: false })
    }
  }
  return [...rows.values()].sort(compareTags)
}

/**
 * F15: names that say a colour get it ("warm" is not lavender). Whole words of the name, lower case.
 */
const NAMED_COLORS: Readonly<Record<string, TagColor>> = {
  warm: 'orange',
  hot: 'orange',
  sunny: 'orange',
  autumn: 'orange',
  orange: 'orange',
  red: 'red',
  urgent: 'red',
  blocker: 'red',
  risk: 'red',
  cool: 'blue',
  cold: 'blue',
  calm: 'blue',
  winter: 'blue',
  blue: 'blue',
  green: 'green',
  done: 'green',
  fresh: 'green',
  approved: 'green',
  yellow: 'yellow',
  violet: 'violet',
  purple: 'violet',
  grey: 'grey',
  gray: 'grey',
  neutral: 'grey',
}

/** The colour a tag's name asks for (its first word that names one), if any. */
export function colorForName(name: string): TagColor | null {
  for (const word of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const color = NAMED_COLORS[word]
    if (color) return color
  }
  return null
}

/**
 * The colour a new tag gets: the one its name asks for (colorForName), else the first of the rotation
 * no tag uses yet, else round-robin.
 */
export function nextTagColor(existing: readonly { color: TagColor }[], name = ''): TagColor {
  const named = colorForName(name)
  if (named) return named
  const used = new Set(existing.map((t) => t.color))
  const free = TAG_COLOR_ROTATION.find((c) => !used.has(c))
  return free ?? (TAG_COLOR_ROTATION[existing.length % TAG_COLOR_ROTATION.length] as TagColor)
}

export type SelectionTagState = 'all' | 'some' | 'none'

export type Planned<T> = { ok: true; value: T } | { ok: false; error: string }

const toDef = (r: TagDef): TagDef => ({ key: r.key, name: r.name, color: r.color })

/**
 * The tag a typed name means: the existing one with that key (listed or carried), or a new one with the
 * next free colour. `created` says which.
 */
export function resolveTypedTag(
  rows: readonly BoardTagRow[],
  typed: string,
): Planned<{ tag: TagDef; created: boolean }> {
  const name = normalizeTagName(typed)
  const error = tagNameError(name)
  if (error) return { ok: false, error }
  const key = tagKey(name)
  const existing = rows.find((r) => r.key === key)
  if (existing) return { ok: true, value: { tag: toDef(existing), created: false } }
  if (rows.length >= MAX_TAGS_PER_BOARD)
    return { ok: false, error: `A board holds up to ${MAX_TAGS_PER_BOARD} tags. Delete one first.` }
  return { ok: true, value: { tag: { key, name, color: nextTagColor(rows, name) }, created: true } }
}

/** Same rows (key, name, colour, count, listed), in the same order. */
export function sameRows(a: readonly BoardTagRow[], b: readonly BoardTagRow[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((r, i) => {
    const o = b[i]
    return (
      o !== undefined &&
      o.key === r.key &&
      o.name === r.name &&
      o.color === r.color &&
      o.count === r.count &&
      o.listed === r.listed
    )
  })
}
