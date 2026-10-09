// OWNER: W3 (wave L, L3-3). The board as the grammar (./grammar.ts) reads it: a plain snapshot of the live
// content items (no bound labels, nothing a mind-map collapse hides), with each item's kind, Lobby colour
// name, frame, tags, words and bounds, the frames and the selection. Read once per palette query.
import { noteColorName, strokeColorName } from '@draftroom/board-ops/elements'
import type { AiColorName } from '@draftroom/contracts'
import { type CanvasElement, items, type LobbyCanvas } from '../../../canvas/api/index.ts'
import { isPolygonLine } from '../../canvas-ux/ported/polygons.ts'
import { elementTags } from '../../tags/ported/model.ts'
import type { BoardFacts, FactItem, KindName } from './grammar.ts'

/** tldraw's own grey, which converted boards and templates carry too (style-vocabulary.ts colorNameOf). */
const TLDRAW_GREY = '#9fa8b2'

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The groups that hold a polygon's outline: their transparent rectangle is its holder, not a shape. */
function polygonGroups(all: readonly CanvasElement[]): Set<string> {
  const out = new Set<string>()
  for (const e of all) if (isPolygonLine(e) && e.groupIds[0]) out.add(e.groupIds[0])
  return out
}

function isHolder(el: CanvasElement, polygons: ReadonlySet<string>): boolean {
  if (el.type !== 'rectangle') return false
  const r = el as { strokeColor?: string; backgroundColor?: string }
  return (
    r.strokeColor === 'transparent' &&
    r.backgroundColor === 'transparent' &&
    !!el.groupIds[0] &&
    polygons.has(el.groupIds[0])
  )
}

/** The grammar's kind of an element (null: none it names, such as a pen stroke or a polygon's holder). */
export function factKindOf(el: CanvasElement, polygons: ReadonlySet<string> = new Set()): KindName | null {
  if (isPolygonLine(el)) return 'shape'
  switch (items.itemKindOf(el)) {
    case 'note':
      return 'note'
    case 'text':
      return 'text'
    case 'shape':
      return isHolder(el, polygons) ? null : 'shape'
    case 'arrow':
    case 'line':
      return 'connector'
    case 'frame':
      return 'frame'
    case 'image':
      return 'image'
    case 'file-card':
      return 'file'
    default:
      return null
  }
}

/** An element's Lobby colour name: a note's fill, anything else's stroke (null outside the palette). */
export function colorNameOf(el: CanvasElement): AiColorName | null {
  const e = el as { backgroundColor?: string; strokeColor?: string }
  if (el.type === 'stickynote') return noteColorName(e.backgroundColor)
  if (typeof e.strokeColor === 'string' && e.strokeColor.toLowerCase() === TLDRAW_GREY) return 'grey'
  return strokeColorName(e.strokeColor)
}

/** The selection as the items it stands for (a selected label is its container), live and shown. */
export function selectionRoots(canvas: Pick<LobbyCanvas, 'selection' | 'get' | 'isHidden'>): string[] {
  const out = new Set<string>()
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (!live(el)) continue
    const root = items.containerOf(el, (x) => canvas.get(x))
    if (live(root) && !canvas.isHidden(root.id)) out.add(root.id)
  }
  return [...out]
}

export function boardFacts(
  canvas: Pick<LobbyCanvas, 'items' | 'get' | 'bounds' | 'isHidden' | 'selection'>,
): BoardFacts {
  const all = canvas.items()
  const polygons = polygonGroups(all)
  const get = (id: string) => canvas.get(id)
  const out: FactItem[] = []
  const frames: { id: string; name: string }[] = []
  for (const el of items.contentItems(all)) {
    if (canvas.isHidden(el.id)) continue
    const kind = factKindOf(el, polygons)
    if (!kind) continue
    const b = canvas.bounds(el.id) ?? { x: el.x, y: el.y, width: el.width, height: el.height }
    if (el.type === 'frame')
      frames.push({ id: el.id, name: String((el as { name?: string | null }).name ?? '') })
    out.push({
      id: el.id,
      kind,
      color: colorNameOf(el),
      frameId: el.frameId,
      tags: elementTags(el).map((t) => t.name),
      text: items.textOf(el, get),
      bounds: { x: b.x, y: b.y, w: b.width, h: b.height },
    })
  }
  const known = new Set(out.map((i) => i.id))
  return { items: out, frames, selection: selectionRoots(canvas).filter((id) => known.has(id)) }
}
