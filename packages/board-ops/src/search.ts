import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import type { TLPageId, TLRecord, TLShape, TLShapeId } from '@tldraw/tlschema'
import { BoardIndex, isRecordObject, propsOf, stringProp } from './board-index.ts'
import { plainTextOf } from './rich-text.ts'
import { parseSearchQuery, scoreText, searchLimit } from './text-match.ts'

export { foldForSearch } from './text-match.ts'

export interface SearchHit {
  shapeId: TLShapeId
  type: string
  /** Full searchable text of the shape (see `extractSearchableText`). */
  text: string
  /** Whitespace-collapsed excerpt of `text` around the first match, with `…` where it was cut. */
  snippet: string
  /** Higher is better: exact text (>= 1000) > contains the phrase at a word start (>= 100) > per-term word/prefix/substring points. */
  score: number
  pageId: TLPageId
}

/** Looks up an asset's file name (`props.name` of the asset record) by asset id. */
export type AssetNameLookup = (assetId: string) => string | undefined

/**
 * The user-visible text of a shape: rich-text content/labels of notes, text, geo and arrows (plain text,
 * see `plainTextOf`), frame names, `dr-file-card` file names, image/video alt text. Unknown shape types
 * with a `richText` prop are read too. With `assetName`, images and videos also carry their asset's
 * file name ("alt text · ref-01.jpg"), so an upload can be found by the name it was uploaded with.
 * Returns `''` when there is nothing to index; never throws.
 */
export function extractSearchableText(record: TLShape, assetName?: AssetNameLookup): string {
  try {
    switch (record.type) {
      case 'note':
      case 'text':
      case 'geo':
      case 'arrow':
        return plainTextOf(propsOf(record).richText)
      case 'frame':
      case FILE_CARD_TYPE:
        return stringProp(record, 'name')
      case 'image':
      case 'video': {
        const alt = stringProp(record, 'altText')
        const assetId = stringProp(record, 'assetId')
        const name = assetId && assetName ? (assetName(assetId) ?? '').trim() : ''
        return alt && name ? `${alt} · ${name}` : alt || name
      }
      default: {
        const props = propsOf(record)
        return 'richText' in props ? plainTextOf(props.richText) : ''
      }
    }
  } catch {
    return ''
  }
}

/** File names of the asset records among `records` (typeName 'asset', `props.name`). */
function assetNames(records: readonly unknown[]): AssetNameLookup {
  const names = new Map<string, string>()
  for (const r of records) {
    if (!isRecordObject(r) || r.typeName !== 'asset' || typeof r.id !== 'string') continue
    const props = isRecordObject(r.props) ? r.props : {}
    if (typeof props.name === 'string' && props.name.trim()) names.set(r.id, props.name)
  }
  return (id) => names.get(id)
}

/**
 * Searches every shape's `extractSearchableText` (images and videos also by the file name of their
 * asset, when the asset records are among `records`). Matching is case- and diacritic-insensitive
 * ('cafe' finds 'Café'), the query is split on whitespace and every term must match (AND). Ranking:
 * whole text equals the query > text contains the query as a phrase starting at a word boundary >
 * per term (whole word 3, word start 2, substring 1); ties prefer shorter texts, then page order,
 * then id. Non-shape records, orphaned shapes (no page ancestor) and shapes without text are
 * ignored. Queries are cut to 256 characters and 12 distinct terms. `limit` defaults to 50 (max 1000).
 * Never throws on malformed records.
 */
export function searchBoard(
  records: Iterable<TLRecord>,
  query: string,
  opts?: { limit?: number },
): SearchHit[] {
  const limit = searchLimit(opts?.limit)
  const q = limit === 0 ? null : parseSearchQuery(query)
  if (!q) return []

  const list = Array.isArray(records) ? (records as readonly TLRecord[]) : [...records]
  const board = new BoardIndex(list)
  const assetName = assetNames(list)
  const hits: SearchHit[] = []
  for (const shape of board.shapes.values()) {
    const pageId = board.pageOf(shape.id)
    if (!pageId) continue
    const text = extractSearchableText(shape, assetName)
    if (!text) continue
    const match = scoreText(text, q)
    if (!match) continue
    hits.push({
      shapeId: shape.id,
      type: shape.type,
      text,
      snippet: match.snippet,
      score: match.score,
      pageId,
    })
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.text.length - b.text.length ||
      board.pageRank(a.pageId) - board.pageRank(b.pageId) ||
      (a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0),
  )
  return hits.slice(0, limit)
}
