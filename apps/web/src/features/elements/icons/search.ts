// OWNER: WS1 (wave Q, the icons). Client-side search over the icon index (about 6,500 icons): by name, tags and
// category, ranked, with optional set and category filters. Pure and synchronous: one pass over precomputed,
// lowercased fields (well under a millisecond per keystroke on a laptop; the tests hold it to a budget).
//
// Ranking (lower is better), for the whole query and then term by term (every term must match somewhere):
//   0 the name is the query (spaces read as dashes: "arrow right" is arrow-right)
//   1 the name starts with it
//   2 a word of the name starts with it
//   3 the name contains it
//   4 a tag is it          5 a tag starts with it        6 the category is or starts with it
//   7 a tag contains it
// A multi-term query that is not a name phrase scores 10 + the sum of its terms' ranks. Ties: the shorter name, then
// the set order of the index (Lucide, then Tabler), then the name.

import type { IconSetId } from '@draftroom/contracts'

export interface IconEntry {
  /** `<set>:<name>` (the shard key and the drag payload's id) */
  readonly key: string
  readonly set: IconSetId
  readonly name: string
  readonly tags: readonly string[]
  /** Tabler's category; null for Lucide (its package has none) */
  readonly category: string | null
  readonly shard: number
}

export interface IconSearchOptions {
  /** only this set */
  readonly set?: IconSetId | null
  /** only this category (exact, as `categories()` lists it) */
  readonly category?: string | null
  /** at most this many results (default 200) */
  readonly limit?: number
}

export interface IconCategory {
  readonly name: string
  readonly count: number
}

export interface IconSearch {
  /** ranked matches; an empty query lists the icons in index order (set, then name) */
  search(query: string, opts?: IconSearchOptions): IconEntry[]
  /** the categories (of one set, or all), by name, with their icon counts */
  categories(set?: IconSetId | null): IconCategory[]
}

export const DEFAULT_ICON_SEARCH_LIMIT = 200
const MAX_QUERY_CHARS = 64
const MAX_TERMS = 6

/** Lowercase, without diacritics, separators as single spaces. */
export function normalizeQuery(q: string): string {
  return q
    .slice(0, MAX_QUERY_CHARS)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

interface Prepared {
  readonly entry: IconEntry
  readonly order: number
  readonly name: string
  readonly words: readonly string[]
  readonly tags: readonly string[]
  readonly category: string
}

function rankTerm(p: Prepared, t: string): number {
  if (p.name === t) return 0
  if (p.name.startsWith(t)) return 1
  if (p.words.some((w) => w.startsWith(t))) return 2
  if (p.name.includes(t)) return 3
  let best = 99
  for (const tag of p.tags) {
    if (tag === t) return 4
    if (best > 5 && tag.startsWith(t)) best = 5
    else if (best > 7 && tag.includes(t)) best = 7
  }
  if (best > 6 && p.category && p.category.startsWith(t)) best = 6
  return best
}

export function createIconSearch(entries: readonly IconEntry[]): IconSearch {
  const prepared: Prepared[] = entries.map((entry, order) => ({
    entry,
    order,
    name: entry.name,
    words: entry.name.split('-'),
    tags: entry.tags.map((t) => normalizeQuery(t)),
    category: entry.category ? normalizeQuery(entry.category) : '',
  }))
  const matches = (p: Prepared, opts: IconSearchOptions) =>
    (!opts.set || p.entry.set === opts.set) && (!opts.category || p.entry.category === opts.category)
  return {
    search(query, opts = {}) {
      const limit = Math.max(0, Math.min(opts.limit ?? DEFAULT_ICON_SEARCH_LIMIT, entries.length))
      const q = normalizeQuery(query)
      const pool = opts.set || opts.category ? prepared.filter((p) => matches(p, opts)) : prepared
      if (!q) return pool.slice(0, limit).map((p) => p.entry)
      const phrase = q.replace(/ /g, '-')
      const terms = [...new Set(q.split(' '))].slice(0, MAX_TERMS)
      const hits: { p: Prepared; score: number }[] = []
      for (const p of pool) {
        let score: number
        if (p.name === phrase) score = 0
        else if (p.name.startsWith(phrase)) score = 1
        else if (terms.length === 1) score = rankTerm(p, phrase)
        else if (p.name.includes(phrase)) score = 3
        else {
          let sum = 10
          for (const t of terms) {
            const r = rankTerm(p, t)
            if (r === 99) {
              sum = 99
              break
            }
            sum += r
          }
          score = sum
        }
        if (score < 99) hits.push({ p, score })
      }
      hits.sort((a, b) => a.score - b.score || a.p.name.length - b.p.name.length || a.p.order - b.p.order)
      return hits.slice(0, limit).map((h) => h.p.entry)
    },
    categories(set) {
      const counts = new Map<string, number>()
      for (const e of entries)
        if (e.category && (!set || e.set === set)) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
      return [...counts.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([name, count]) => ({ name, count }))
    },
  }
}
