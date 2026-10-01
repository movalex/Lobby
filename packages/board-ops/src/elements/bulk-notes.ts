/**
 * Paste as sticky notes on the new canvas (Miro-style "paste as notes", the element version of
 * `../bulk-notes.ts`): the same parser and grid (`../bulk-parse.ts`), and each note a `stickynote` with its
 * bound label, built and laid out by Excalidraw's own code through `@draftroom/canvas-schema/engine`
 * (`buildStickyNote`: `created: null`, the engine's sticky-note fit), like server-made notes.
 *
 * The notes look like today's pasted notes: Lobby's note fill for `color` (default `black`, "Butter"), the
 * hand-drawn face (tldraw's `draw` font is Excalifont on the new canvas) at the `m` label size (22 px).
 *
 * Text layout needs text metrics: in a browser the engine measures with the canvas (call this once Lobby's
 * fonts have loaded, `document.fonts.ready`, or the wraps follow the fallback font); in Node the caller
 * installs the server table first (`installServerTextMetrics`, as apps/sync does at start-up).
 */

import type { WireElement } from '@draftroom/canvas-schema/elements'
import { buildStickyNote, indexKeysBetween, isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { layoutBulkNotes, NOTE_SIZE } from '../bulk-parse.ts'
import { type IdSource, newElementId, randomInt31 } from './ids.ts'
import { isLobbyColorName, LOBBY_PALETTE, type LobbyColorName } from './palette.ts'

/** The label size of a pasted note (tldraw size `m`: 22 px) and its face (tldraw `draw`: Excalifont). */
export const PASTED_NOTE_FONT_SIZE = 22
export const PASTED_NOTE_FONT_FAMILY = 5

export interface ElementNotesOptions {
  /** Scene-space top-left of the grid. */
  origin: { x: number; y: number }
  /** A Lobby colour name (palette.ts); anything else is the default `black` ("Butter"). */
  color?: string
  /** The frame the notes go into (their `frameId`), or null. */
  frameId?: string | null
  /** Default 500, at most 5000. */
  maxNotes?: number
  /** Space between notes, default 20. */
  gap?: number
  /** Fresh indices above this key (the board's top index). */
  indexAbove?: string | null
  newId?: IdSource
}

/**
 * Notes (each a `stickynote` followed by its label) from pasted text; `noteIds` in grid order. Throws
 * `TypeError` for a non-finite origin or an invalid `indexAbove`.
 */
export function noteElementsFromText(
  text: string,
  opts: ElementNotesOptions,
): { elements: WireElement[]; noteIds: string[]; truncated: boolean } {
  const { origin } = opts
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y))
    throw new TypeError('noteElementsFromText: origin must have finite x and y')
  if (opts.indexAbove !== undefined && opts.indexAbove !== null && !isValidIndexKey(opts.indexAbove))
    throw new TypeError('noteElementsFromText: indexAbove is not a valid index key')
  const newId = opts.newId ?? newElementId
  const color: LobbyColorName = isLobbyColorName(opts.color) ? opts.color : 'black'
  const { placed, truncated } = layoutBulkNotes(text, origin, opts)
  const keys = indexKeysBetween(opts.indexAbove ?? null, null, placed.length * 2)
  const elements: WireElement[] = []
  const noteIds: string[] = []
  placed.forEach((p, i) => {
    const id = newId()
    const built = buildStickyNote({
      id,
      labelId: newId(),
      x: p.x,
      y: p.y,
      text: p.text,
      width: NOTE_SIZE,
      fontFamily: PASTED_NOTE_FONT_FAMILY,
      baseFontSize: PASTED_NOTE_FONT_SIZE,
      backgroundColor: LOBBY_PALETTE[color].noteFill,
      strokeColor: LOBBY_PALETTE[color].noteText,
      seed: randomInt31(),
    })
    const frameId = opts.frameId ?? null
    elements.push({
      ...built.note,
      frameId,
      index: keys[i * 2] ?? null,
      versionNonce: randomInt31(),
    } as unknown as WireElement)
    if (built.label)
      elements.push({
        ...built.label,
        frameId,
        index: keys[i * 2 + 1] ?? null,
        versionNonce: randomInt31(),
      } as unknown as WireElement)
    noteIds.push(id)
  })
  // plain JSON: the engine's constructors leave `customData: undefined` on a note
  for (const e of elements as unknown as Record<string, unknown>[])
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
  return { elements, noteIds, truncated }
}
