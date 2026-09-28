// Board search by tag (MAK-12's tag filter; COL-11 "search can filter by tag"), on top of board-ops
// `searchBoard`. Pure.
//
// - Words find notes and cards by their tags too: "research" finds a note tagged Research even when its
//   text never says so (every word must match the text or a tag name, like searchBoard's AND).
// - `#word` only matches tags: "#res" = carries a tag with a word starting with "res" ("Research",
//   "User research"; case- and accent-insensitive). Several `#` terms must all match.
// - The panel's tag filter (a tag key) keeps only the notes and cards carrying that tag; with no words it
//   lists all of them, in reading order.
// Without any tag term or filter, the results are exactly searchBoard's.

import { extractSearchableText, foldForSearch, type SearchHit, searchBoard } from '@draftroom/board-ops'
import type { TagDef } from '@draftroom/contracts'
import type { TLPageId, TLRecord, TLShape } from 'tldraw'
import { type BoardTagMap, displayTags, isTaggable } from './model.ts'

export interface TagQuery {
  /** The query without its `#` terms (for searchBoard and for highlighting). */
  text: string
  /** Folded `#` terms, without the `#`. */
  tagTerms: string[]
}

export function parseTagQuery(query: string): TagQuery {
  const words = query.trim().split(/\s+/u).filter(Boolean)
  const text: string[] = []
  const tagTerms: string[] = []
  for (const w of words) {
    if (w.startsWith('#') && w.length > 1) {
      const t = foldForSearch(w.replace(/^#+/u, ''))
      if (t) tagTerms.push(t)
    } else if (w !== '#') text.push(w)
  }
  return { text: text.join(' '), tagTerms }
}

/** The text part of a query (what the result snippets highlight). */
export const textOfQuery = (query: string) => parseTagQuery(query).text

const SNIPPET_CHARS = 120
function snippetOf(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat
}

/** `#term` matches a tag when its name, or one of the name's words, starts with the term. */
function tagMatchesTerm(t: TagDef, term: string): boolean {
  const name = foldForSearch(t.name)
  return name.startsWith(term) || name.split(/[\s\-_/.]+/u).some((w) => w.startsWith(term))
}

export interface TagSearchOptions {
  limit: number
  /** Only notes and cards carrying this tag key. */
  tag: string | null
  board: BoardTagMap
}

/**
 * searchBoard plus tags (see the header). `records` are what the search panel searches: the page, its
 * shapes and the assets. Tag-only results come in reading order (top to bottom, then left to right).
 */
export function searchBoardWithTags(
  records: readonly TLRecord[],
  query: string,
  opts: TagSearchOptions,
): SearchHit[] {
  const { text, tagTerms } = parseTagQuery(query)
  const filtered = opts.tag !== null || tagTerms.length > 0
  if (!filtered && !text) return []

  const shapes = new Map<string, TLShape>()
  let pageId: TLPageId | null = null
  for (const r of records) {
    if (r.typeName === 'shape') shapes.set(r.id, r)
    else if (r.typeName === 'page' && pageId === null) pageId = r.id
  }
  const tagsOf = new Map<string, TagDef[]>()
  const passes = (s: TLShape): boolean => {
    if (!isTaggable(s)) return false
    const tags = displayTags(s.meta, opts.board)
    if (!tags.length) return false
    if (opts.tag !== null && !tags.some((t) => t.key === opts.tag)) return false
    if (!tagTerms.every((term) => tags.some((t) => tagMatchesTerm(t, term)))) return false
    tagsOf.set(s.id, tags)
    return true
  }
  // Filtered: the only possible results. Unfiltered: the tagged shapes a word may find by a tag name.
  const candidates = [...shapes.values()].filter(passes)
  if (filtered && !candidates.length) return []

  if (!text) {
    const pos = pagePositions(shapes)
    return candidates
      .map((s) => ({ s, p: pos(s) }))
      .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x || (a.s.id < b.s.id ? -1 : 1))
      .slice(0, opts.limit)
      .map(({ s }) => tagOnlyHit(s, pageId, tagsOf.get(s.id) ?? []))
  }

  // Words: the text matches from searchBoard, then candidates whose text plus tag names match.
  const allowed = new Set(candidates.map((s) => s.id))
  const base = searchBoard(records, text, { limit: filtered ? 1000 : opts.limit })
  const hits = filtered ? base.filter((h) => allowed.has(h.shapeId)) : base
  const found = new Set(hits.map((h) => h.shapeId))
  const terms = [...new Set(foldForSearch(text).split(' ').filter(Boolean))]
  for (const s of candidates) {
    if (found.has(s.id)) continue
    const tags = tagsOf.get(s.id) ?? []
    const hay = foldForSearch(`${extractSearchableText(s)} ${tags.map((t) => t.name).join(' ')}`)
    if (terms.every((t) => hay.includes(t))) hits.push(tagOnlyHit(s, pageId, tags, true))
  }
  return hits.slice(0, opts.limit)
}

/** A hit that searchBoard did not produce; `withNames` adds the tag names (they are why it matched). */
function tagOnlyHit(
  s: TLShape,
  pageId: TLPageId | null,
  tags: readonly TagDef[],
  withNames = false,
): SearchHit {
  const text = extractSearchableText(s)
  const names = tags.map((t) => `#${t.name}`).join(' ')
  const body = text ? snippetOf(text) : ''
  return {
    shapeId: s.id,
    type: s.type,
    text,
    snippet: withNames && names ? (body ? `${body} · ${names}` : names) : body || names || '(no text)',
    score: 0,
    pageId: pageId ?? ('page:page' as TLPageId),
  }
}

/** Page position of a shape: its own x/y plus its ancestors' (rotation ignored: ordering only). */
function pagePositions(shapes: ReadonlyMap<string, TLShape>) {
  const cache = new Map<string, { x: number; y: number }>()
  const at = (s: TLShape, depth = 0): { x: number; y: number } => {
    const hit = cache.get(s.id)
    if (hit) return hit
    const parent = shapes.get(s.parentId)
    const base = parent && depth < 64 ? at(parent, depth + 1) : { x: 0, y: 0 }
    const p = { x: base.x + s.x, y: base.y + s.y }
    cache.set(s.id, p)
    return p
  }
  return (s: TLShape) => at(s)
}
