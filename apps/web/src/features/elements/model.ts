// OWNER: WS3 (wave Q). The Elements panel's model, apart from React so Node tests run it: the tiles of the three
// sources, the one search over them, the tab counts, Favourites and Recents from the mark keys, and what a key does in
// the tile grid. The panel is a combobox: the search box keeps the keyboard, Up and Down move the active tile a row
// (Left and Right a tile while nothing is typed; in the grid itself, always), Home and End go to the ends, Enter
// inserts the active tile, Escape clears the search, then closes the panel.
import {
  elementDragPayload,
  ICON_SET_NAMES,
  type IconIndex,
  type IconSetId,
  LIBRARY_LIMITS,
  type LibraryItemSummary,
  type LibraryMarkTarget,
  LibraryTag,
  libraryMarkKey,
  parseLibraryMarkKey,
} from '@draftroom/contracts'
import {
  type PieceCategory,
  type PieceInfo,
  pieceInfo,
  searchPieces,
} from '@draftroom/templates/pieces/catalog'
import type { IconsApi } from './icons-port.ts'

export const ELEMENT_TABS = [
  { id: 'icons', label: 'Icons' },
  { id: 'shapes', label: 'Shapes' },
  { id: 'library', label: 'Library' },
] as const
export type ElementTab = (typeof ELEMENT_TABS)[number]['id']

export type Tile =
  | {
      readonly source: 'icon'
      readonly id: string
      readonly set: IconSetId
      readonly name: string
      readonly label: string
      /** the set's pinned version (the mark key carries it) */
      readonly version: string
    }
  | { readonly source: 'piece'; readonly id: string; readonly info: PieceInfo; readonly label: string }
  | {
      readonly source: 'item'
      readonly id: string
      readonly item: LibraryItemSummary
      readonly label: string
    }

/** A tile's drag payload (text/plain `lobby-element:<source>:<id>`). */
export const tileDrag = (t: Tile) => elementDragPayload({ source: t.source, id: t.id })
/** A tile's stable key (React keys, DOM ids, marks before the version). */
export const tileKey = (t: Tile) => `${t.source}:${t.id}`

export function markTarget(t: Tile): LibraryMarkTarget {
  if (t.source === 'icon') return { source: 'icon', set: t.set, name: t.name, version: t.version }
  return { source: t.source, id: t.id }
}
export const tileMarkKey = (t: Tile) => libraryMarkKey(markTarget(t))

/** "arrow-right" → "Arrow right" (an icon's readable name). */
export const iconLabel = (name: string) => {
  const words = name.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const setVersion = (index: IconIndex | null, set: IconSetId) =>
  index?.sets.find((s) => s.id === set)?.version ?? null

export function iconTile(index: IconIndex, set: IconSetId, name: string): Tile | null {
  const version = setVersion(index, set)
  if (!version) return null
  return { source: 'icon', id: `${set}:${name}`, set, name, label: iconLabel(name), version }
}

export const pieceTile = (info: PieceInfo): Tile => ({
  source: 'piece',
  id: info.id,
  info,
  label: info.name,
})

export const itemTile = (item: LibraryItemSummary): Tile => ({
  source: 'item',
  id: item.id,
  item,
  label: item.name,
})

// ---- search ----------------------------------------------------------------------------------------------------

export interface SearchInput {
  readonly query: string
  readonly icons: { readonly api: IconsApi; readonly index: IconIndex } | null
  readonly iconSet: IconSetId | 'all'
  readonly shapeCategory: PieceCategory | 'all'
  /** the Library tab's loaded items (already filtered by scope and folder) */
  readonly items: readonly LibraryItemSummary[]
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/** The library items `query` finds (name and tags; every word must match one of them). */
export function searchItems(items: readonly LibraryItemSummary[], query: string): LibraryItemSummary[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...items]
  return items.filter((it) => {
    const name = fold(it.name)
    const tags = it.tags.map(fold)
    return words.every((w) => name.includes(w) || tags.some((t) => t.startsWith(w)))
  })
}

export interface SearchResults {
  readonly icons: readonly Tile[]
  readonly shapes: readonly Tile[]
  readonly library: readonly Tile[]
}

/** Every source's tiles for one search (an empty query lists each source in its own order). */
export function searchAll(s: SearchInput): SearchResults {
  const icons: Tile[] = []
  if (s.icons) {
    const set = s.iconSet === 'all' ? null : s.iconSet
    for (const [iset, name] of s.icons.api.search(s.icons.index, s.query.trim(), { set })) {
      const t = iconTile(s.icons.index, iset, name)
      if (t) icons.push(t)
    }
  }
  const shapes = searchPieces(s.query, s.shapeCategory).map(pieceTile)
  const library = searchItems(s.items, s.query).map(itemTile)
  return { icons, shapes, library }
}

/** A tab's count as its label shows it ("99+" above 99). */
export const countLabel = (n: number) => (n > 99 ? '99+' : String(n))

/** The first tab after `tab` (in the tabs' order, wrapping) with results, for "No icons match: 3 shapes do". */
export function otherMatches(
  r: SearchResults,
  tab: ElementTab,
  tabs: readonly ElementTab[],
): { tab: ElementTab; count: number }[] {
  return tabs
    .filter((t) => t !== tab)
    .map((t) => ({ tab: t, count: r[t].length }))
    .filter((x) => x.count > 0)
}

// ---- favourites and recents ------------------------------------------------------------------------------------

export interface MarkLookup {
  readonly index: IconIndex | null
  readonly items: ReadonlyMap<string, LibraryItemSummary>
  /** the Library tab is offered (an item mark is hidden otherwise) */
  readonly library: boolean
}

/**
 * The tile a mark key names, or null when it is hidden: an icon of another set version (renamed or gone in this one),
 * an unknown piece, an item that is not among the readable ones, or any item without the library.
 */
export function tileOfMark(key: string, look: MarkLookup): Tile | null {
  const t = parseLibraryMarkKey(key)
  if (!t) return null
  if (t.source === 'icon') {
    if (!look.index || setVersion(look.index, t.set) !== t.version) return null
    if (!look.index.icons.some((e) => e[0] === t.set && e[1] === t.name)) return null
    return iconTile(look.index, t.set, t.name)
  }
  if (t.source === 'piece') {
    const info = pieceInfo(t.id)
    return info ? pieceTile(info) : null
  }
  const item = look.library ? look.items.get(t.id) : undefined
  return item && !item.deletedAt ? itemTile(item) : null
}

/** The tiles of `keys` that are not hidden, in order, each once. */
export function tilesOfMarks(keys: readonly string[], look: MarkLookup): Tile[] {
  const seen = new Set<string>()
  const out: Tile[] = []
  for (const k of keys) {
    const t = tileOfMark(k, look)
    if (!t || seen.has(tileKey(t))) continue
    seen.add(tileKey(t))
    out.push(t)
  }
  return out
}

// ---- the keyboard ----------------------------------------------------------------------------------------------

/** Where a flat tile index sits: its section (Favourites, Recents, the results), row and column. */
interface Cell {
  readonly section: number
  readonly row: number
  readonly col: number
}

function cellOf(sections: readonly number[], index: number, cols: number): Cell | null {
  let start = 0
  for (let s = 0; s < sections.length; s++) {
    const size = sections[s] as number
    if (index < start + size) {
      const i = index - start
      return { section: s, row: Math.floor(i / cols), col: i % cols }
    }
    start += size
  }
  return null
}

const startOf = (sections: readonly number[], s: number) => sections.slice(0, s).reduce((a, b) => a + b, 0)
const rowsOf = (size: number, cols: number) => Math.ceil(size / cols)

/** The index a row up (-1) or down (+1) from `index`, the same column where that row is long enough. */
export function rowMove(sections: readonly number[], index: number, cols: number, dir: 1 | -1): number {
  const c = cellOf(sections, index, cols)
  if (!c) return index
  const at = (s: number, row: number) => {
    const size = sections[s] as number
    const first = row * cols
    return startOf(sections, s) + Math.min(first + c.col, size - 1)
  }
  const size = sections[c.section] as number
  const row = c.row + dir
  if (row >= 0 && row < rowsOf(size, cols)) return at(c.section, row)
  // into the next (or previous) section that has tiles
  for (let s = c.section + dir; s >= 0 && s < sections.length; s += dir) {
    const n = sections[s] as number
    if (n > 0) return at(s, dir === 1 ? 0 : rowsOf(n, cols) - 1)
  }
  return index
}

export interface GridKeyResult {
  readonly active: number
  /** the key was used (the panel stops it) */
  readonly handled: boolean
  readonly insert?: true
  /** Escape with something typed: clear the search */
  readonly clear?: true
  /** Escape with nothing typed: close the panel */
  readonly close?: true
  /** open the active tile's actions (the context-menu key, Shift+F10) */
  readonly actions?: true
}

const clampIndex = (i: number, n: number) => (n === 0 ? 0 : Math.max(0, Math.min(n - 1, i)))

export interface GridKeyState {
  readonly active: number
  /** the tile counts of the grid's sections, in order (Favourites, Recents, the results) */
  readonly sections: readonly number[]
  readonly columns: number
  readonly query: string
  /** the search box has the keyboard (with `query` typed, Left, Right, Home and End move its caret instead) */
  readonly inSearch: boolean
  readonly shift?: boolean
}

/** What `key` (KeyboardEvent.key) does to the active tile. */
export function gridKey(key: string, s: GridKeyState): GridKeyResult {
  const n = s.sections.reduce((a, b) => a + b, 0)
  const at = clampIndex(s.active, n)
  const cols = Math.max(1, s.columns)
  const caret = s.inSearch && s.query.length > 0
  const move = (to: number): GridKeyResult => ({ active: clampIndex(to, n), handled: true })
  const keep: GridKeyResult = { active: at, handled: false }
  switch (key) {
    case 'ArrowDown':
      return move(rowMove(s.sections, at, cols, 1))
    case 'ArrowUp':
      return move(rowMove(s.sections, at, cols, -1))
    case 'ArrowRight':
      return caret ? keep : move(at + 1)
    case 'ArrowLeft':
      return caret ? keep : move(at - 1)
    case 'Home':
      return caret ? keep : move(0)
    case 'End':
      return caret ? keep : move(n - 1)
    case 'Enter':
      return n ? { active: at, handled: true, insert: true } : { active: at, handled: true }
    case 'ContextMenu':
      return n ? { active: at, handled: true, actions: true } : keep
    case 'F10':
      return s.shift && n ? { active: at, handled: true, actions: true } : keep
    case 'Escape':
      return s.query ? { active: 0, handled: true, clear: true } : { active: at, handled: true, close: true }
    default:
      return keep
  }
}

/** The credit line under the Icons tab. */
export const ICON_CREDIT = `Icons: ${ICON_SET_NAMES.lucide} (ISC), ${ICON_SET_NAMES.tabler} (MIT)`

// ---- names and tags --------------------------------------------------------------------------------------------

export interface ParsedTags {
  readonly tags: string[]
  /** a tag the library does not take (too long, a symbol first), or more than its limit; null when none */
  readonly problem: string | null
}

/** "Flow, Chart , flow" → ['flow', 'chart']: commas separate, case folds, each once, at most LIBRARY_LIMITS.tags. */
export function parseTags(text: string): ParsedTags {
  const out: string[] = []
  for (const raw of text.split(',')) {
    const t = raw.trim()
    if (!t) continue
    const parsed = LibraryTag.safeParse(t)
    if (!parsed.success) {
      const shown = [...t].slice(0, 40).join('')
      const rule = `letters and numbers, at most ${LIBRARY_LIMITS.tagChars}`
      return { tags: out, problem: `“${shown}” can’t be a tag: use ${rule}.` }
    }
    if (!out.includes(parsed.data)) out.push(parsed.data)
  }
  if (out.length > LIBRARY_LIMITS.tags)
    return { tags: out.slice(0, LIBRARY_LIMITS.tags), problem: `At most ${LIBRARY_LIMITS.tags} tags.` }
  return { tags: out, problem: null }
}

/** A name the library takes (trimmed, one line, at most LIBRARY_LIMITS.nameChars), or null. */
export function itemNameOrNull(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || [...t].length > LIBRARY_LIMITS.nameChars) return null
  return t
}

/** A folder name the library takes, or null. */
export function folderNameOrNull(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || [...t].length > LIBRARY_LIMITS.folderNameChars) return null
  return t
}
