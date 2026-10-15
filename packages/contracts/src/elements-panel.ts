// The Elements panel's insert payloads (wave Q; OWNER: WS3 after the wave Q foundation; docs/WAVE-Q-CONTRACTS.md §4).
//
// One dock panel, `elements` (it replaces the Shapes panel `pieces` when ELEMENTS_PANEL turns on; label "Elements",
// order 35), with three sources: built-in icons (./icons.ts), built-in shapes (packages/templates pieces) and the
// library (./library.ts). Every insert is native elements written in ONE canvas transaction (one undo step), placed by
// apps/web/src/features/elements/place.ts.
//
// A tile dragged onto the board carries text/plain `lobby-element:<source>:<id>` (one content handler, priority 200,
// takes it, like today's `lobby-piece:<id>`):
//   lobby-element:icon:<set>:<name>    a built-in icon (./icons.ts iconKey)
//   lobby-element:piece:<pieceId>      a built-in shape
//   lobby-element:item:<lbi_…>         a library item (placed through POST /api/boards/:bid/library/items/:id/place)
// Anything else is not the panel's and is left to the other handlers. A paste is never taken (only a drop).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { ICON_KEY_PATTERN, IconSize } from './icons.ts'
import { LIBRARY_ITEM_ID_PATTERN, PIECE_ID_PATTERN } from './library.ts'

export const ELEMENTS_PANEL_ID = 'elements'
export const ELEMENTS_PANEL_LABEL = 'Elements'
/** The palette command that opens it (PALETTE_COMMAND_IDS; pending until WS3 registers it). */
export const ELEMENTS_OPEN_COMMAND_ID = 'elements.open'

export const ELEMENT_SOURCES = ['icon', 'piece', 'item'] as const
export const ElementSource = z.enum(ELEMENT_SOURCES)
export type ElementSource = z.infer<typeof ElementSource>

export const ELEMENT_DRAG_PREFIX = 'lobby-element:'
/** The longest payload taken (a longer text is never a tile's). */
export const ELEMENT_DRAG_MAX_CHARS = 120

export interface ElementDragTarget {
  readonly source: ElementSource
  /** icon: `<set>:<name>`; piece: the piece id; item: the `lbi_…` id */
  readonly id: string
}

export const elementDragPayload = (t: ElementDragTarget) => `${ELEMENT_DRAG_PREFIX}${t.source}:${t.id}`

/** The tile a dropped text names, or null (not the panel's: leave it to the other handlers). */
export function parseElementDrag(text: unknown): ElementDragTarget | null {
  if (typeof text !== 'string' || text.length > ELEMENT_DRAG_MAX_CHARS) return null
  if (!text.startsWith(ELEMENT_DRAG_PREFIX)) return null
  const rest = text.slice(ELEMENT_DRAG_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon < 0) return null
  const source = ElementSource.safeParse(rest.slice(0, colon))
  if (!source.success) return null
  const id = rest.slice(colon + 1)
  const ok =
    source.data === 'icon'
      ? ICON_KEY_PATTERN.test(id)
      : source.data === 'piece'
        ? PIECE_ID_PATTERN.test(id)
        : LIBRARY_ITEM_ID_PATTERN.test(id)
  return ok ? { source: source.data, id } : null
}

/** Lobby's 13 theme-safe colours (board-ops elements/palette.ts LOBBY_COLOR_NAMES, mirrored; a web test compares). */
export const INSERT_COLOR_NAMES = [
  'black',
  'blue',
  'green',
  'grey',
  'light-blue',
  'light-green',
  'light-red',
  'light-violet',
  'orange',
  'red',
  'violet',
  'yellow',
  'white',
] as const
export const InsertColorName = z.enum(INSERT_COLOR_NAMES)
export type InsertColorName = z.infer<typeof InsertColorName>

/**
 * The panel's "before insert" bar, remembered per viewer (browser storage, a convenience only; a bad value falls back
 * to the defaults): the colour of icons and kits (null = the set's default ink), the icon size preset, one outer group
 * around everything inserted, and locking it.
 */
export const InsertOptions = z.strictObject({
  color: InsertColorName.nullable().catch(null),
  size: IconSize.catch('M'),
  keepTogether: z.boolean().catch(true),
  lock: z.boolean().catch(false),
})
export type InsertOptions = z.infer<typeof InsertOptions>
export const DEFAULT_INSERT_OPTIONS: InsertOptions = {
  color: null,
  size: 'M',
  keepTogether: true,
  lock: false,
}
