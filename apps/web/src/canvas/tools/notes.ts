// Lobby's sticky notes (docs/EXCALIDRAW-MIGRATION.md §2.11) and its onDuplicate stamp (§2.3.2, §3.3).
// Pure: the engine's skeleton converter is passed in, so this runs in Node tests too.
//
// `created: null` hides Excalidraw's creation-date footer: getStickyNoteFooter -> getStickyNoteDateLabel
// returns null for `created === null` (@excalidraw/element dist/dev/index.js:6855-6857, drawn at
// :13623-13633). Excalidraw stamps `created` on every new element (_newElementBase, :16371, unless the
// caller passes one) and on every duplicate (duplicateElement: `copy.created = copy.updated`,
// :17937-17939). So:
//  - Lobby builds its notes with `created: null` in the skeleton AND `regenerateIds: false`:
//    convertToExcalidrawElements overwrites `created` with a timestamp whenever it regenerates ids
//    (`Object.assign(element, { id: randomId(), created })`, :24527-24528);
//  - `stampNoteDuplicates` (onDuplicate) sets `created: null` on duplicated notes. Excalidraw merges the
//    returned object into the duplicate (reconcileDuplicatedElements, :18139-18163).

/** Lobby's note size (§2.11: baseHeight = the note size, 200 px). */
export const LOBBY_NOTE_SIZE = 200
/** Lobby yellow, the default of the 13-colour palette (plan §2.3.2 names it but not its value). */
export const LOBBY_NOTE_YELLOW = '#ffd966'

export interface NoteOptions {
  id: string
  x: number
  y: number
  size?: number
  backgroundColor?: string
  /** The label text; omit for a note without a label. */
  text?: string
  labelId?: string
  fontSize?: number
  /** FONT_FAMILY.Nunito = 6 (§2.3.2). */
  fontFamily?: number
  groupIds?: string[]
}

/** The skeleton for convertToExcalidrawElements(..., { regenerateIds: false }). */
export function noteSkeleton(o: NoteOptions): Record<string, unknown> {
  const size = o.size ?? LOBBY_NOTE_SIZE
  const skeleton: Record<string, unknown> = {
    type: 'stickynote',
    id: o.id,
    x: o.x,
    y: o.y,
    width: size,
    height: size,
    baseHeight: size,
    backgroundColor: o.backgroundColor ?? LOBBY_NOTE_YELLOW,
    roughness: 0,
    created: null,
  }
  if (o.groupIds) skeleton.groupIds = o.groupIds
  if (o.text !== undefined) {
    skeleton.label = {
      text: o.text,
      fontFamily: o.fontFamily ?? 6,
      ...(o.fontSize ? { fontSize: o.fontSize } : {}),
      ...(o.labelId ? { id: o.labelId } : {}),
    }
  }
  return skeleton
}

export interface ElementLike {
  id: string
  type: string
  created?: number | null
  [key: string]: unknown
}

export type ConvertSkeletons<E extends ElementLike> = (
  skeletons: readonly Record<string, unknown>[],
  opts: { regenerateIds: false },
) => E[]

/** Builds a note (and its label) with `created: null`; throws if the engine stamped it anyway. */
export function buildNote<E extends ElementLike>(convert: ConvertSkeletons<E>, o: NoteOptions): E[] {
  const elements = convert([noteSkeleton(o)], { regenerateIds: false })
  const note = elements.find((e) => e.type === 'stickynote')
  if (!note || note.id !== o.id) throw new Error('buildNote: the engine did not keep the note id')
  if (note.created !== null) throw new Error(`buildNote: created is ${String(note.created)}, not null`)
  return elements
}

/**
 * onDuplicate (Ctrl+D, Alt-drag, paste, library insert): returns the elements with `created: null` on
 * every duplicated note, or undefined when there is nothing to change (Excalidraw keeps its own array).
 * `duplicateIds` are the ids of the copies (data.duplicateElements in Excalidraw's OnDuplicateData).
 */
export function stampNoteDuplicates<E extends ElementLike>(
  nextElements: readonly E[],
  duplicateIds: { has(id: string): boolean },
): E[] | undefined {
  let changed = false
  const out = nextElements.map((el) => {
    if (el.type === 'stickynote' && duplicateIds.has(el.id) && el.created !== null) {
      changed = true
      return { ...el, created: null }
    }
    return el
  })
  return changed ? out : undefined
}
