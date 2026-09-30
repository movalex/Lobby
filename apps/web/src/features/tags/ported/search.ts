// Board search by tag on the new canvas (the port of ../search.ts onto board-ops/elements'
// `searchElements`; MAK-12's tag filter, COL-11 "search can filter by tag"). Pure. The same rules:
// - Words find elements by their tags too: "research" finds a note tagged Research even when its text
//   never says so (every word must match the text or a tag name, like searchElements' AND).
// - `#word` only matches tags: "#res" = carries a tag with a word starting with "res" ("Research",
//   "User research"; case- and accent-insensitive). Several `#` terms must all match.
// - The panel's tag filter (a tag key) keeps only the elements carrying that tag; with no words it lists
//   all of them, in reading order.
// Without any tag term or filter, the results are exactly searchElements'.
// Hidden elements (a collapsed mind-map branch) are the caller's to leave out, as for searchElements.

import {
  asElements,
  type ElementSearchHit,
  elementBounds,
  foldForSearch,
  kindOf,
  lookupOf,
  searchableElementText,
  searchElements,
} from '@draftroom/board-ops/elements'
import type { TagDef } from '@draftroom/contracts'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { type BoardTagMap, displayTags, isTaggable } from './model.ts'

export interface TagQuery {
  /** The query without its `#` terms (for searchElements and for highlighting). */
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
  /** Only elements carrying this tag key. */
  tag: string | null
  board: BoardTagMap
}

/**
 * searchElements plus tags (see the header). `elements` are what the search panel searches (the board's
 * live, visible elements). Tag-only results come in reading order (top to bottom, then left to right, by position).
 */
export function searchElementsWithTags(
  elements: Iterable<CanvasElement>,
  query: string,
  opts: TagSearchOptions,
): ElementSearchHit[] {
  const { text, tagTerms } = parseTagQuery(query)
  const filtered = opts.tag !== null || tagTerms.length > 0
  if (!filtered && !text) return []

  const list = asElements(elements)
  const get = lookupOf(list)
  const tagsOf = new Map<string, TagDef[]>()
  const passes = (el: CanvasElement): boolean => {
    if (!isTaggable(el)) return false
    const tags = displayTags(el, opts.board)
    if (!tags.length) return false
    if (opts.tag !== null && !tags.some((t) => t.key === opts.tag)) return false
    if (!tagTerms.every((term) => tags.some((t) => tagMatchesTerm(t, term)))) return false
    tagsOf.set(el.id, tags)
    return true
  }
  // Filtered: the only possible results. Unfiltered: the tagged elements a word may find by a tag name.
  const candidates = (list as unknown as CanvasElement[]).filter(passes)
  if (filtered && !candidates.length) return []

  const hitOf = (el: CanvasElement, withNames: boolean): ElementSearchHit => {
    const own = searchableElementText(el as never, get)
    const tags = tagsOf.get(el.id) ?? []
    const names = tags.map((t) => `#${t.name}`).join(' ')
    const body = own ? snippetOf(own) : ''
    return {
      id: el.id,
      type: el.type,
      kind: kindOf(el as never),
      text: own,
      snippet: withNames && names ? (body ? `${body} · ${names}` : names) : body || names || '(no text)',
      score: 0,
    }
  }

  if (!text) {
    // top to bottom, then left to right (scene positions: Excalidraw's x/y are absolute)
    return candidates
      .map((el) => ({ el, p: elementBounds(el as never) }))
      .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x || (a.el.id < b.el.id ? -1 : 1))
      .slice(0, opts.limit)
      .map(({ el }) => hitOf(el, false))
  }

  // Words: the text matches from searchElements, then candidates whose text plus tag names match.
  const allowed = new Set(candidates.map((el) => el.id))
  const base = searchElements(list, text, { limit: filtered ? 1000 : opts.limit })
  const hits = filtered ? base.filter((h) => allowed.has(h.id)) : base
  const found = new Set(hits.map((h) => h.id))
  const terms = [...new Set(foldForSearch(text).split(' ').filter(Boolean))]
  for (const el of candidates) {
    if (found.has(el.id)) continue
    const tags = tagsOf.get(el.id) ?? []
    const hay = foldForSearch(
      `${searchableElementText(el as never, get)} ${tags.map((t) => t.name).join(' ')}`,
    )
    if (terms.every((t) => hay.includes(t))) hits.push(hitOf(el, true))
  }
  return hits.slice(0, opts.limit)
}
