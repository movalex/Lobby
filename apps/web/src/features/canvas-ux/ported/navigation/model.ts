// The navigation feature's reads of the canvas: what an element is called in the search filters and
// the select-by-type menus (the tldraw build's shape types, so both boards agree on what an "image" is),
// the searchable elements, the frames in presentation order, locks and frame membership. Pure over
// `LobbyCanvas` reads (reactive inside useValue) and plain elements (Node-tested).

import {
  type Box,
  type ElementSearchHit,
  frameOutlineOf,
  presentationOrderOf,
  searchElements,
} from '@draftroom/board-ops/elements'
import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { type CanvasElement, items, type LobbyCanvas } from '../../../../canvas/api/index.ts'
import { minsOf } from '../../../present-export/live/agenda.ts'
import { matchesFilter, type SearchFilter } from '../../search-filter.ts'
import type { ShapeLite } from '../../select-by-type.ts'

/**
 * The tldraw shape type an element stands for in the search filters and select-by-type categories
 * (search-filter.ts): note, text, geo (rectangle, ellipse, diamond), arrow, frame, the file card, image and
 * video (a video file, shown as a card on the new canvas, is still an "image" like tldraw's video shape);
 * `line`, `draw` and `highlight` have no category; a bound label is null (its words are its container's).
 */
export function legacyTypeOf(el: CanvasElement): string | null {
  const kind = items.itemKindOf(el)
  switch (kind) {
    case 'note':
    case 'text':
    case 'arrow':
    case 'frame':
    case 'image':
    case 'line':
    case 'draw':
    case 'highlight':
      return kind
    case 'shape':
      return 'geo'
    case 'file-card': {
      const file = items.lobbyValue(el, 'file') as { kind?: string } | undefined
      return file?.kind === 'video' ? 'video' : FILE_CARD_TYPE
    }
    default:
      return null
  }
}

/** The element's own lock, its container's (a label) or its frame's (tldraw: a shape inside a locked frame). */
export function lockedInCanvas(el: CanvasElement, get: (id: string) => CanvasElement | undefined): boolean {
  if (el.locked) return true
  const container = el.type === 'text' && el.containerId ? get(el.containerId) : undefined
  if (container?.locked) return true
  const frameId = (container ?? el).frameId
  return frameId ? get(frameId)?.locked === true : false
}

/** The content items (no bound labels) as select-by-type sees them. */
export function liteOf(el: CanvasElement, canvas: Pick<LobbyCanvas, 'get' | 'isHidden'>): ShapeLite | null {
  const type = legacyTypeOf(el)
  if (type === null) return null
  return {
    id: el.id,
    type,
    ancestors: el.frameId ? [el.frameId] : [],
    locked: lockedInCanvas(el, (id) => canvas.get(id)),
    hidden: canvas.isHidden(el.id),
  }
}

/** Every content item of the board as select-by-type sees it. */
export function boardLites(canvas: Pick<LobbyCanvas, 'items' | 'get' | 'isHidden'>): ShapeLite[] {
  const out: ShapeLite[] = []
  for (const el of items.contentItems(canvas.items())) {
    const l = liteOf(el, canvas)
    if (l) out.push(l)
  }
  return out
}

/**
 * The selection (its bound labels mapped to their containers) and, for "Keep only", the selection with
 * what is inside its frames (Excalidraw selects a whole group with any member, so groups need nothing).
 */
export function selectionLites(canvas: Pick<LobbyCanvas, 'items' | 'get' | 'isHidden' | 'selection'>): {
  selected: ShapeLite[]
  withInside: ShapeLite[]
} {
  const ids = new Set<string>()
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (!el) continue
    ids.add(items.containerOf(el, (x) => canvas.get(x)).id)
  }
  const all = items.contentItems(canvas.items())
  const selected: ShapeLite[] = []
  const inside: ShapeLite[] = []
  for (const el of all) {
    const l = liteOf(el, canvas)
    if (!l) continue
    if (ids.has(el.id)) selected.push(l)
    else if (el.frameId && ids.has(el.frameId)) inside.push(l)
  }
  return { selected, withInside: [...selected, ...inside] }
}

// ---- board search ---------------------------------------------------------------------------------------

export interface NavSearchHit {
  readonly id: string
  /** the tldraw shape type (search-filter.ts) */
  readonly type: string
  readonly snippet: string
}

/**
 * Board search over the live elements (board-ops `searchElements`: case- and accent-insensitive, every
 * word must match; notes, text, shape and connector labels, frame names, image alt text and file names),
 * hidden (collapsed) elements left out, narrowed by the type filter.
 */
export function searchCanvas(
  elements: readonly CanvasElement[],
  query: string,
  opts: {
    limit: number
    filter: SearchFilter
    isHidden(id: string): boolean
    /**
     * The search itself (default board-ops `searchElements`): the panel passes the tags feature's search,
     * where words also match tag names, `#word` matches tags only and `tag` narrows to one tag.
     */
    search?: (
      elements: readonly CanvasElement[],
      query: string,
      o: { limit: number },
    ) => readonly ElementSearchHit[]
    /** a tag filter is set: an empty query then lists that tag's carriers */
    tag?: string | null
  },
): NavSearchHit[] {
  if (!query.trim() && !opts.tag) return []
  const byId = new Map(elements.map((e) => [e.id, e]))
  const out: NavSearchHit[] = []
  // ask for more than the limit: hidden and filtered-out hits come off afterwards
  const search = opts.search ?? searchElements
  for (const h of search(elements, query, { limit: Math.min(1000, opts.limit * 4) })) {
    if (opts.isHidden(h.id)) continue
    const el = byId.get(h.id)
    const type = el ? legacyTypeOf(el) : null
    if (!type || !matchesFilter(type, opts.filter)) continue
    out.push({ id: h.id, type, snippet: h.snippet })
    if (out.length >= opts.limit) break
  }
  return out
}

// ---- frames -----------------------------------------------------------------------------------------------

export interface FrameRow {
  readonly id: string
  readonly name: string
  readonly skip: boolean
  readonly locked: boolean
  readonly bounds: Box
  /** customData.lobby.present.index, or null (the order then follows the layout) */
  readonly presentIndex: number | null
  /** customData.lobby.present.mins (wave L, L5-1 run of show), or null: no time planned */
  readonly mins: number | null
}

/** The board's frames in presentation order (board-ops `presentationOrderOf`; frames never nest on the new canvas). */
export function frameRows(elements: readonly CanvasElement[]): FrameRow[] {
  const frames = elements.filter((e) => e.type === 'frame' && !e.isDeleted)
  if (!frames.length) return []
  const byId = new Map(frames.map((f) => [f.id, f]))
  return presentationOrderOf(frames).map((e) => ({
    id: e.id,
    name: e.name,
    skip: e.skip,
    locked: byId.get(e.id)?.locked === true,
    bounds: e.bounds,
    presentIndex: e.presentIndex,
    mins: minsOf(items.lobbyValue(byId.get(e.id), 'present')),
  }))
}

/** The frames in reading order (no explicit order), for "Auto-order" and the first frame of a board. */
export const frameOutline = (elements: readonly CanvasElement[]) =>
  frameOutlineOf(elements.filter((e) => e.type === 'frame' && !e.isDeleted))

/** The unlocked frame whose bounds hold `point` (the smallest), or null. */
export function frameAt(
  canvas: Pick<LobbyCanvas, 'items' | 'bounds' | 'get'>,
  point: { x: number; y: number },
): CanvasElement | null {
  let best: { el: CanvasElement; area: number } | null = null
  for (const el of canvas.items()) {
    if (el.type !== 'frame' || el.isDeleted || el.locked) continue
    const b = canvas.bounds(el.id)
    if (!b || point.x < b.x || point.y < b.y || point.x > b.x + b.width || point.y > b.y + b.height) continue
    const area = b.width * b.height
    if (!best || area < best.area) best = { el, area }
  }
  return best?.el ?? null
}
