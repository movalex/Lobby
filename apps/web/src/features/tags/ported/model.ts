// Tags on canvas elements: the pure part of the ported feature (docs/EXCALIDRAW-MIGRATION.md §3.3, §3.4,
// §4.7). The port of ../model.ts from shape meta to the new canvas's storage:
//  - on an element, one `customData.lobby['tag:<key>']` = {name, color} per tag (canvas-schema
//    custom-data.ts; today's `meta['drTags:<key>']`), at most MAX_TAGS_PER_SHAPE;
//  - the board's list, one `lb_doc['tagDef:<key>']` = {name, color} per tag (canvas-schema doc.ts; today's
//    document `meta['drTagList:<key>']`), at most 200. The server refuses a `tag:<key>` whose
//    `tagDef:<key>` is not in lb_doc (or in the same push), so a write that puts a tag on an element that
//    the list does not have yet lists it in the same push.
//
// Rules decided here (as in ../model.ts; the engine-neutral ones are ../tag-core.ts):
// - Taggable: sticky notes, file cards, images, shapes (mind-map topics) and free text.
// - The board's entry decides a tag's name and colour everywhere; an element's own copy is the fallback.
// - Order: by name (case- and accent-insensitive, numbers in numeric order), then key.
// - Every change is planned here as `customData.lobby` patches (a null value removes a key) plus the doc
//   keys to set, so the canvas side writes it as one transact (one undo step) and one doc write.
//
// Pure: contracts, canvas-schema's key names, the canvas API's readers.

import { TAG_KEY_PREFIX } from '@draftroom/canvas-schema/custom-data'
import { TAG_DEF_KEY_PREFIX } from '@draftroom/canvas-schema/doc'
import {
  isTagColor,
  MAX_TAGS_PER_SHAPE,
  normalizeTagName,
  parseTagValue,
  type TagColor,
  type TagDef,
  tagKey,
  tagNameError,
} from '@draftroom/contracts'
import { type CanvasElement, items as itemsApi } from '../../../canvas/api/index.ts'
import {
  type BoardTagMap,
  type BoardTagRow,
  boardTagMap,
  compareTags,
  type Planned,
  type SelectionTagState,
  tagRowsOf,
} from '../tag-core.ts'

export type { BoardTagMap, BoardTagRow, Planned, SelectionTagState }

/** The kinds (canvas/api items.ts `itemKindOf`) that take tags. */
export const TAGGABLE_KINDS: ReadonlySet<string> = new Set(['note', 'file-card', 'image', 'shape', 'text'])

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

export function isTaggable(el: CanvasElement | undefined): el is CanvasElement {
  if (!isLive(el)) return false
  const kind = itemsApi.itemKindOf(el)
  return kind !== null && TAGGABLE_KINDS.has(kind)
}

/** How chips sit on an element (../tags.css): inside a note, a card or media; above a shape or text. */
export type ChipPlacement = 'note' | 'card' | 'above'
export function chipPlacement(el: CanvasElement): ChipPlacement {
  const kind = itemsApi.itemKindOf(el)
  if (kind === 'note') return 'note'
  return kind === 'shape' || kind === 'text' ? 'above' : 'card'
}

// An element's `customData.lobby` object is replaced on every change: parse each one once (a board-wide
// scan is then one map lookup per element).
const parsed = new WeakMap<object, readonly TagDef[]>()
const NONE: readonly TagDef[] = Object.freeze([])

/** The valid tags stored on an element (key order, at most MAX_TAGS_PER_SHAPE). Do not mutate the result. */
export function elementTags(el: CanvasElement | undefined): readonly TagDef[] {
  const lobby = el?.customData?.lobby
  if (!lobby) return NONE
  let tags = parsed.get(lobby)
  if (!tags) {
    const out: TagDef[] = []
    for (const [k, v] of Object.entries(lobby)) {
      if (!k.startsWith(TAG_KEY_PREFIX)) continue
      const t = parseTagValue(k.slice(TAG_KEY_PREFIX.length), v)
      if (t) out.push(t)
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    tags = out.length > MAX_TAGS_PER_SHAPE ? out.slice(0, MAX_TAGS_PER_SHAPE) : out
    parsed.set(lobby, tags)
  }
  return tags
}

/** The board's tag list from lb_doc's `tagDef:*` entries (invalid ones ignored). */
export function boardTagsOf(entries: ReadonlyMap<string, unknown>): BoardTagMap {
  const list: TagDef[] = []
  for (const [k, v] of entries) {
    if (!k.startsWith(TAG_DEF_KEY_PREFIX)) continue
    const t = parseTagValue(k.slice(TAG_DEF_KEY_PREFIX.length), v)
    if (t) list.push(t)
  }
  return boardTagMap(list)
}

/** An element's tags as people see them: the board's name and colour where it lists the tag; sorted. */
export function displayTags(el: CanvasElement | undefined, board: BoardTagMap): TagDef[] {
  const own = elementTags(el)
  if (!own.length) return []
  return own.map((t) => board.get(t.key) ?? t).sort(compareTags)
}

/** Every tag on the board: the listed ones and the ones elements carry, with counts; sorted by name. */
export function boardTagRows(board: BoardTagMap, elements: Iterable<CanvasElement>): BoardTagRow[] {
  const carried: (readonly TagDef[])[] = []
  for (const el of elements) if (isTaggable(el)) carried.push(elementTags(el))
  return tagRowsOf(board, carried)
}

// ---- planning ------------------------------------------------------------------------------------

export const tagElementKey = (key: string) => `${TAG_KEY_PREFIX}${key}`
export const tagDefKey = (key: string) => `${TAG_DEF_KEY_PREFIX}${key}`
const tagValue = (t: TagDef) => ({ name: t.name, color: t.color })

/** One element's `customData.lobby` changes (null removes a key). */
export interface ElementTagPatch {
  id: string
  lobby: Record<string, { name: string; color: TagColor } | null>
}

export interface TagPlan {
  elements: ElementTagPatch[]
  /** lb_doc keys to set (null removes) */
  doc: Record<string, { name: string; color: TagColor } | null>
}

/** Whether all, some or none of the taggable elements carry `key`. */
export function selectionTagState(elements: readonly CanvasElement[], key: string): SelectionTagState {
  let n = 0
  let with_ = 0
  for (const el of elements) {
    if (!isTaggable(el)) continue
    n++
    if (elementTags(el).some((t) => t.key === key)) with_++
  }
  if (n === 0 || with_ === 0) return 'none'
  return with_ === n ? 'all' : 'some'
}

export interface SetTagResult extends TagPlan {
  /** Elements left out because they already carry MAX_TAGS_PER_SHAPE tags. */
  full: number
}

/**
 * Adds `tag` to (on) or removes it from (off) every taggable, unlocked element of `elements`. Adding also
 * lists the tag on the board when it is not listed yet (`listed`): the server takes a tag only with its
 * definition.
 */
export function planSetTag(
  elements: readonly CanvasElement[],
  tag: TagDef,
  on: boolean,
  listed: boolean,
  isLocked: (el: CanvasElement) => boolean = (el) => el.locked,
): SetTagResult {
  const out: ElementTagPatch[] = []
  let full = 0
  for (const el of elements) {
    if (!isTaggable(el) || isLocked(el)) continue
    const own = elementTags(el)
    const has = own.some((t) => t.key === tag.key)
    if (on) {
      if (has) continue
      if (own.length >= MAX_TAGS_PER_SHAPE) {
        full++
        continue
      }
      out.push({ id: el.id, lobby: { [tagElementKey(tag.key)]: tagValue(tag) } })
    } else if (has) out.push({ id: el.id, lobby: { [tagElementKey(tag.key)]: null } })
  }
  const doc = on && !listed && out.length > 0 ? { [tagDefKey(tag.key)]: tagValue(tag) } : {}
  return { elements: out, doc, full }
}

/**
 * Renames a tag on the board and on every element carrying it. A name that differs only in case keeps the
 * key. A name that is another tag's refuses (no silent merge).
 */
export function planRename(
  rows: readonly BoardTagRow[],
  elements: Iterable<CanvasElement>,
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
  const out: ElementTagPatch[] = []
  for (const el of elements) {
    if (!isTaggable(el) || !elementTags(el).some((t) => t.key === fromKey)) continue
    const lobby: ElementTagPatch['lobby'] = { [tagElementKey(key)]: tagValue(tag) }
    if (key !== fromKey) lobby[tagElementKey(fromKey)] = null
    out.push({ id: el.id, lobby })
  }
  const doc: TagPlan['doc'] = { [tagDefKey(key)]: tagValue(tag) }
  if (key !== fromKey) doc[tagDefKey(fromKey)] = null
  return { ok: true, value: { tag, elements: out, doc } }
}

/** A new colour for a tag, on the board and on every element carrying it (their copies stay in step). */
export function planRecolor(
  rows: readonly BoardTagRow[],
  elements: Iterable<CanvasElement>,
  key: string,
  color: TagColor,
): Planned<TagPlan> {
  const row = rows.find((r) => r.key === key)
  if (!row) return { ok: false, error: 'That tag is no longer on this board.' }
  if (!isTagColor(color)) return { ok: false, error: 'Pick one of the note colours.' }
  const tag: TagDef = { key, name: row.name, color }
  const out: ElementTagPatch[] = []
  for (const el of elements) {
    if (!isTaggable(el)) continue
    const own = elementTags(el).find((t) => t.key === key)
    if (!own || (own.color === color && own.name === row.name)) continue
    out.push({ id: el.id, lobby: { [tagElementKey(key)]: tagValue(tag) } })
  }
  return { ok: true, value: { elements: out, doc: { [tagDefKey(key)]: tagValue(tag) } } }
}

/** "Delete everywhere": off the board's list and off every element carrying it (locked ones too). */
export function planDeleteEverywhere(elements: Iterable<CanvasElement>, key: string): TagPlan {
  const out: ElementTagPatch[] = []
  for (const el of elements) {
    if (!isTaggable(el) || !elementTags(el).some((t) => t.key === key)) continue
    out.push({ id: el.id, lobby: { [tagElementKey(key)]: null } })
  }
  return { elements: out, doc: { [tagDefKey(key)]: null } }
}

/** Space-separated tag keys of an element (keys contain no whitespace), '' without tags. */
export function tagTokens(el: CanvasElement | undefined): string {
  let out = ''
  for (const t of elementTags(el)) out = out ? `${out} ${t.key}` : t.key
  return out
}

/**
 * Chip level of detail from the zoom (screen size of an 11 px chip): full chips from 60 %, colour dots
 * from 25 %, nothing below (../runtime.ts tagsLodFor).
 */
export const LOD_FULL_ZOOM = 0.6
export const LOD_DOTS_ZOOM = 0.25
export type TagsLod = 'full' | 'dots' | 'off'
export const tagsLodFor = (zoom: number): TagsLod =>
  zoom >= LOD_FULL_ZOOM ? 'full' : zoom >= LOD_DOTS_ZOOM ? 'dots' : 'off'
