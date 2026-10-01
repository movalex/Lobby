/**
 * Board search over elements (the new canvas's `searchBoard`): the same matching and ranking as the tldraw
 * search (`../text-match.ts`: case- and diacritic-insensitive, every term must match, exact > phrase at a
 * word start > per term), over `elementText`. Deleted elements and bound labels are not hits (a label's
 * words are its container's text). Ties prefer shorter texts, then paint order, then id. Never throws on
 * malformed elements. Hidden elements (a collapsed mind-map branch) are the caller's to leave out.
 */
import { parseSearchQuery, scoreText, searchLimit } from '../text-match.ts'
import {
  asElements,
  type BoardElement,
  compareByIndex,
  elementText,
  isLabel,
  isLive,
  kindOf,
  lookupOf,
} from './read.ts'

export interface ElementSearchHit {
  /** the element id (the api object ref is `shape:<id>`, canvas-schema refs.ts) */
  id: string
  /** the element's type (`stickynote`, `text`, `rectangle`, `frame`, …) */
  type: string
  /** what Lobby calls it (`note`, `text`, `rectangle`, `file-card`, …; read.ts `kindOf`) */
  kind: string
  /** full searchable text (`elementText`) */
  text: string
  /** whitespace-collapsed excerpt around the first match, with `…` where it was cut */
  snippet: string
  /** higher is better (the tldraw search's scale) */
  score: number
}

/** The element's searchable text; '' for deleted elements and bound labels. */
export function searchableElementText(
  el: BoardElement,
  get: (id: string) => BoardElement | undefined,
): string {
  if (!isLive(el) || isLabel(el)) return ''
  return elementText(el, get)
}

/**
 * Searches every live element's text. `limit` defaults to 50 (at most 1000); queries are cut to 256
 * characters and 12 distinct terms.
 */
export function searchElements(
  elements: Iterable<unknown>,
  query: string,
  opts?: { limit?: number },
): ElementSearchHit[] {
  const limit = searchLimit(opts?.limit)
  const q = limit === 0 ? null : parseSearchQuery(query)
  if (!q) return []
  const list = asElements(elements)
  const get = lookupOf(list)
  const order = new Map([...list].sort(compareByIndex).map((e, i) => [e.id, i]))
  const hits: ElementSearchHit[] = []
  const seen = new Set<string>()
  for (const el of list) {
    if (seen.has(el.id)) continue
    seen.add(el.id)
    const text = searchableElementText(el, get)
    if (!text) continue
    const match = scoreText(text, q)
    if (!match) continue
    hits.push({
      id: el.id,
      type: el.type,
      kind: kindOf(el),
      text,
      snippet: match.snippet,
      score: match.score,
    })
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.text.length - b.text.length ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return hits.slice(0, limit)
}
