// OWNER: 3i. What the live region says about the selection (docs/EXCALIDRAW-MIGRATION.md §4.8 (1)): the
// replacement for tldraw's `generateShapeAnnouncementMessage` (tldraw/lib/ui/components/A11y.mjs). Pure.
//
// Copy (the plan's form "Sticky note: <text>", "Frame: <name>", with tldraw's position kept):
//   one element        "Sticky note: Faster builds. 2 of 5"      (no text: "Rectangle. 3 of 5")
//   inside a frame     "Sticky note: Keep me. 1 of 2 in Retro"   (an unnamed frame: "… in a frame")
//   one group          "Group of 3 shapes. 4 of 5"
//   several            "3 shapes selected"                       (tldraw's "{num} shapes selected")
import { type CanvasElement, items } from '../../../canvas/api/index.ts'
import type { OrderEntry } from './reading-order.ts'

/** The spoken name of an element's kind (tldraw's tool names with Lobby's overrides: Pen, Connector). */
export function kindLabel(el: CanvasElement): string {
  switch (items.itemKindOf(el)) {
    case 'note':
      return 'Sticky note'
    case 'text':
    case 'label':
      return 'Text'
    case 'shape':
      return el.type === 'ellipse' ? 'Ellipse' : el.type === 'diamond' ? 'Diamond' : 'Rectangle'
    case 'arrow':
      return 'Connector'
    case 'line':
      return 'Line'
    case 'draw':
      return 'Pen'
    case 'highlight':
      return 'Highlight'
    case 'image':
      return 'Image'
    case 'file-card':
      return 'File'
    case 'frame':
      return 'Frame'
    default:
      return 'Item'
  }
}

/** The words an element carries: a note's or shape's label, a text's words, a frame's name, a file's name. */
export function wordsOf(el: CanvasElement, get: items.Lookup): string {
  const own = items.textOf(el, get).replace(/\s+/g, ' ').trim()
  if (own) return own
  const file = items.lobbyValue(el, 'file') as { name?: unknown } | undefined
  return typeof file?.name === 'string' ? file.name.trim() : ''
}

/** Longest stretch of an element's words the region reads out (a whole page of text is not useful). */
export const MAX_SPOKEN_CHARS = 200

export function clip(words: string, max = MAX_SPOKEN_CHARS): string {
  return words.length <= max ? words : `${words.slice(0, max - 1).trimEnd()}…`
}

/** "Sticky note: Faster builds" / "Rectangle": what an element is, with its words. */
export function describeElement(el: CanvasElement, get: items.Lookup): string {
  const words = clip(wordsOf(el, get))
  return words ? `${kindLabel(el)}: ${words}` : kindLabel(el)
}

export interface SelectionContext {
  get: items.Lookup
  /** the selection's level, in reading order */
  order: readonly OrderEntry[]
  /** the frame of that level (null: the top level) */
  frame: CanvasElement | null
}

/** The live region's words for a selection ('' for none). */
export function describeSelection(selection: readonly string[], c: SelectionContext): string {
  // labels count as their containers; deleted ids are dropped
  const ids = [
    ...new Set(
      selection
        .map((id) => c.get(id))
        .filter((el): el is CanvasElement => !!el && !(el as { isDeleted?: boolean }).isDeleted)
        .map((el) => items.containerOf(el, c.get).id),
    ),
  ]
  if (!ids.length) return ''
  const sel = new Set(ids)
  const entry = c.order.find((e) => e.ids.length === sel.size && e.ids.every((id) => sel.has(id))) ?? null
  const where = entry ? position(c.order.indexOf(entry), c.order.length, c.frame, c.get) : ''
  if (entry?.group) return `Group of ${entry.ids.length} shapes${where}`
  if (ids.length > 1) return `${ids.length} shapes selected`
  const el = c.get(ids[0] as string)
  if (!el) return ''
  return `${describeElement(el, c.get)}${connections(el, c.get)}${where}`
}

// ---- wave L (W4, L4-1): what a shape is connected to ----------------------------------------------------------
//
//   one connected shape     "Rectangle: Process, connected to Review. 2 of 5"
//   several                 "Rectangle: Process, connected to Decision and Review. 2 of 5"
//   more than CONNECTIONS_SPOKEN   "…, connected to A, B, C, D, E and 3 more. 2 of 9"
// A shape is named by its words, else its kind. Connectors and lines themselves say nothing more.

/** How many connected shapes the region names before "and N more". */
export const CONNECTIONS_SPOKEN = 5

/** ", connected to A and B" for a shape with bound connectors, '' otherwise. */
export function connections(el: CanvasElement, get: items.Lookup): string {
  if (el.type === 'arrow' || el.type === 'line') return ''
  const names: string[] = []
  const seen = new Set<string>()
  for (const arrowId of items.arrowsOf(el)) {
    const a = get(arrowId)
    if (!a || (a as { isDeleted?: boolean }).isDeleted || a.type !== 'arrow') continue
    const { start, end } = items.arrowEnds(a)
    const other = start === el.id ? end : end === el.id ? start : null
    if (!other || other === el.id || seen.has(other)) continue
    const o = get(other)
    if (!o || (o as { isDeleted?: boolean }).isDeleted) continue
    seen.add(other)
    names.push(clip(wordsOf(o, get), 60) || kindLabel(o))
  }
  if (!names.length) return ''
  const shown = names.slice(0, CONNECTIONS_SPOKEN)
  const more = names.length - shown.length
  const list =
    more > 0
      ? `${shown.join(', ')} and ${more} more`
      : shown.length === 1
        ? (shown[0] as string)
        : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  return `, connected to ${list}`
}

function position(index: number, total: number, frame: CanvasElement | null, get: items.Lookup): string {
  if (index < 0) return ''
  const inFrame = frame ? ` in ${clip(wordsOf(frame, get), 60) || 'a frame'}` : ''
  return `. ${index + 1} of ${total}${inFrame}`
}
