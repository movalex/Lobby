// Tags on notes, file cards, images and shapes: the pure part (docs/WAVE4-CONTRACTS.md §2 tags). The
// storage format and its validation live in @draftroom/contracts (tags.ts): one meta key per tag, on
// the shape (`drTags:<key>`) and in the board's list on the document record (`drTagList:<key>`).
//
// Rules decided here:
// - Taggable: sticky notes, file cards, images, videos, geo shapes (mind-map topics) and text.
// - The board's entry decides a tag's name and colour everywhere; a shape's own copy is the fallback
//   (pasted from another board, or an entry someone removed while this shape still carried it).
// - The board's tag list shown to people = the listed tags plus any tag a shape still carries.
// - Order: by name (case- and accent-insensitive, numbers in numeric order), then key.
// - Every change is planned here as whole next `meta` objects, so the editor side can write each record
//   once, in one undo step (and remove keys, which a partial update cannot do).

import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import {
  boardTagMetaKey,
  isTagColor,
  MAX_TAGS_PER_BOARD,
  MAX_TAGS_PER_SHAPE,
  normalizeTagName,
  parseShapeTags,
  shapeTagMetaKey,
  TAG_COLOR_ROTATION,
  type TagColor,
  type TagDef,
  tagKey,
  tagNameError,
} from '@draftroom/contracts'

export type Meta = Readonly<Record<string, unknown>>

export interface ShapeLike {
  id: string
  type: string
  meta: Meta
  isLocked?: boolean
}

/**
 * F2 / R8: images and videos (a mood board is tagged #warm / #option-b), and shapes and text (a mind
 * map's topics are geo shapes; action items are often plain text), besides notes and file cards.
 */
export const TAGGABLE_TYPES: ReadonlySet<string> = new Set([
  'note',
  FILE_CARD_TYPE,
  'image',
  'video',
  'geo',
  'text',
])
export const isTaggable = (shape: { type: string }) => TAGGABLE_TYPES.has(shape.type)

/** How chips sit on a shape (ShapeWrapper.tsx, tags.css): inside a note, a card or media; above a shape or text. */
export type ChipPlacement = 'note' | 'card' | 'above'
export function chipPlacement(type: string): ChipPlacement {
  if (type === 'note') return 'note'
  return type === 'geo' || type === 'text' ? 'above' : 'card'
}

// Records are immutable, so a meta object's tags never change: parse each one once (a board-wide scan
// is then one map lookup per shape).
const parsed = new WeakMap<object, readonly TagDef[]>()
/** The valid tags stored on a shape (key order). Do not mutate the result. */
export function shapeTags(meta: Meta): readonly TagDef[] {
  let tags = parsed.get(meta)
  if (!tags) {
    tags = parseShapeTags(meta)
    parsed.set(meta, tags)
  }
  return tags
}

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

/** A shape's tags as people see them: the board's name and colour where it lists the tag; sorted. */
export function displayTags(meta: Meta, board: BoardTagMap): TagDef[] {
  const own = shapeTags(meta)
  if (!own.length) return []
  return own.map((t) => board.get(t.key) ?? t).sort(compareTags)
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

/** Space-separated tag keys of a shape (keys contain no whitespace), '' without tags. */
export function tagTokens(meta: Meta): string {
  let out = ''
  for (const t of shapeTags(meta)) out = out ? `${out} ${t.key}` : t.key
  return out
}

export interface BoardTagRow extends TagDef {
  /** Taggable shapes carrying it (all pages). */
  count: number
  /** In the board's list (false: only shapes carry it). */
  listed: boolean
}

/** Every tag on the board: the listed ones and the ones shapes carry, with counts; sorted by name. */
export function boardTagRows(board: BoardTagMap, shapes: Iterable<ShapeLike>): BoardTagRow[] {
  const rows = new Map<string, BoardTagRow>()
  for (const t of board.values()) rows.set(t.key, { ...t, count: 0, listed: true })
  for (const s of shapes) {
    if (!isTaggable(s)) continue
    for (const t of shapeTags(s.meta)) {
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

// ---- planning ------------------------------------------------------------------------------------

/** One shape's next meta (the whole object). */
export interface ShapeMetaChange {
  id: string
  type: string
  meta: Record<string, unknown>
}

/** Changes to the board's list: entries to write and keys to remove. */
export interface BoardListChange {
  set: TagDef[]
  remove: string[]
}

export interface TagPlan {
  shapes: ShapeMetaChange[]
  board: BoardListChange
}

const EMPTY_BOARD_CHANGE: BoardListChange = { set: [], remove: [] }

/** The document meta after `change` (other keys, other features' included, are kept). */
export function applyBoardChange(meta: Meta, change: BoardListChange): Record<string, unknown> {
  const next: Record<string, unknown> = { ...meta }
  for (const key of change.remove) delete next[boardTagMetaKey(key)]
  for (const t of change.set) next[boardTagMetaKey(t.key)] = { name: t.name, color: t.color }
  return next
}

const withoutKey = (meta: Meta, key: string) => {
  const next: Record<string, unknown> = { ...meta }
  delete next[shapeTagMetaKey(key)]
  return next
}
const withTag = (meta: Meta, t: TagDef, remove?: string) => {
  const next: Record<string, unknown> = { ...meta }
  if (remove !== undefined) delete next[shapeTagMetaKey(remove)]
  next[shapeTagMetaKey(t.key)] = { name: t.name, color: t.color }
  return next
}

export type SelectionTagState = 'all' | 'some' | 'none'

/** Whether all, some or none of the taggable shapes carry `key`. */
export function selectionTagState(shapes: readonly ShapeLike[], key: string): SelectionTagState {
  let n = 0
  let with_ = 0
  for (const s of shapes) {
    if (!isTaggable(s)) continue
    n++
    if (shapeTags(s.meta).some((t) => t.key === key)) with_++
  }
  if (n === 0 || with_ === 0) return 'none'
  return with_ === n ? 'all' : 'some'
}

export interface SetTagResult extends TagPlan {
  /** Shapes left out because they already carry MAX_TAGS_PER_SHAPE tags. */
  full: number
}

/**
 * Adds `tag` to (on) or removes it from (off) every taggable, unlocked shape of `shapes`. Adding also
 * lists the tag on the board when it is not listed yet (`listed`).
 */
export function planSetTag(
  shapes: readonly ShapeLike[],
  tag: TagDef,
  on: boolean,
  listed: boolean,
): SetTagResult {
  const out: ShapeMetaChange[] = []
  let full = 0
  for (const s of shapes) {
    if (!isTaggable(s) || s.isLocked) continue
    const own = shapeTags(s.meta)
    const has = own.some((t) => t.key === tag.key)
    if (on) {
      if (has) continue
      if (own.length >= MAX_TAGS_PER_SHAPE) {
        full++
        continue
      }
      out.push({ id: s.id, type: s.type, meta: withTag(s.meta, tag) })
    } else if (has) {
      out.push({ id: s.id, type: s.type, meta: withoutKey(s.meta, tag.key) })
    }
  }
  const board = on && !listed && out.length > 0 ? { set: [tag], remove: [] } : EMPTY_BOARD_CHANGE
  return { shapes: out, board, full }
}

export type Planned<T> = { ok: true; value: T } | { ok: false; error: string }

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

const toDef = (r: TagDef): TagDef => ({ key: r.key, name: r.name, color: r.color })

/**
 * Renames a tag on the board and on every shape carrying it. A name that differs only in case keeps the
 * key. A name that is another tag's refuses (no silent merge).
 */
export function planRename(
  rows: readonly BoardTagRow[],
  shapes: Iterable<ShapeLike>,
  fromKey: string,
  typed: string,
): Planned<TagPlan & { tag: TagDef }> {
  const from = rows.find((r) => r.key === fromKey)
  if (!from) return { ok: false, error: 'That tag is no longer on this board.' }
  const name = normalizeTagName(typed)
  const error = tagNameError(name)
  if (error) return { ok: false, error }
  const key = tagKey(name)
  if (key !== fromKey) {
    const clash = rows.find((r) => r.key === key)
    if (clash) return { ok: false, error: `There is already a tag called “${clash.name}”.` }
  }
  const tag: TagDef = { key, name, color: from.color }
  const out: ShapeMetaChange[] = []
  for (const s of shapes) {
    if (!isTaggable(s) || !shapeTags(s.meta).some((t) => t.key === fromKey)) continue
    out.push({ id: s.id, type: s.type, meta: withTag(s.meta, tag, key === fromKey ? undefined : fromKey) })
  }
  return {
    ok: true,
    value: { tag, shapes: out, board: { set: [tag], remove: key === fromKey ? [] : [fromKey] } },
  }
}

/** A new colour for a tag, on the board and on every shape carrying it (their copies stay in step). */
export function planRecolor(
  rows: readonly BoardTagRow[],
  shapes: Iterable<ShapeLike>,
  key: string,
  color: TagColor,
): Planned<TagPlan> {
  const row = rows.find((r) => r.key === key)
  if (!row) return { ok: false, error: 'That tag is no longer on this board.' }
  if (!isTagColor(color)) return { ok: false, error: 'Pick one of the note colours.' }
  const tag: TagDef = { key, name: row.name, color }
  const out: ShapeMetaChange[] = []
  for (const s of shapes) {
    if (!isTaggable(s)) continue
    const own = shapeTags(s.meta).find((t) => t.key === key)
    if (!own || (own.color === color && own.name === row.name)) continue
    out.push({ id: s.id, type: s.type, meta: withTag(s.meta, tag) })
  }
  return { ok: true, value: { shapes: out, board: { set: [tag], remove: [] } } }
}

/** "Delete everywhere": off the board's list and off every shape carrying it (locked ones too). */
export function planDeleteEverywhere(shapes: Iterable<ShapeLike>, key: string): TagPlan {
  const out: ShapeMetaChange[] = []
  for (const s of shapes) {
    if (!isTaggable(s) || !shapeTags(s.meta).some((t) => t.key === key)) continue
    out.push({ id: s.id, type: s.type, meta: withoutKey(s.meta, key) })
  }
  return { shapes: out, board: { set: [], remove: [key] } }
}
