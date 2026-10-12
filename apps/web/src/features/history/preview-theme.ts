// OWNER: W2 (wave M, M2-4, FTU-9). What the time-travel preview draws in the board's colours (pure, Node-tested).
//
// The preview is the engine's exporter drawing a checkpoint's elements into a bitmap (canvas/preview). In dark mode
// the exporter passes every element colour through Lobby's dark table (canvas/engine/theme.ts: the note palette's
// designed dark fills, Lobby's inks, and Excalidraw's own filter for greys). Two things came out unreadable:
//  - a frame's name: the exporter adds it as a text element in FRAME_STYLE's dark name colour, and that colour went
//    through the table a second time (a light ink, filtered to a dark one), so the title nearly vanished;
//  - a note's label on a fill that is not one of the palette's swatches (a pasted pastel): the label is stored in the
//    engine's default ink, which the table turns into CHALK (light), light on a light pastel.
// The preview now hands the exporter a copy of the elements in which
//  - each frame has no name of its own (the exporter's label for it is empty) and a text element named
//    `lobby-preview-label:<frame id>` sits where the name goes, in Lobby's ink (stored as INK, which the table draws
//    as CHALK in dark and as INK in light: the theme's ink, like the live canvas's frame names), and
//  - each note's label that is in a default ink is in `noteInkFor(fill, theme)` (W1's rule: the higher-contrast of INK
//    and CHALK on that fill), written as the colour the exporter must be given to draw exactly that. A label in a colour
//    the person chose keeps it (N1, wave M follow-up 2: it was drawn in the default ink), as on the live canvas, where
//    only a default ink is answered differently (canvas/engine/theme.ts noteInkOverride).
// Nothing here touches the live board or the checkpoint: the copy is what the bitmap is made from.

import { CHALK, INK, lobbyDarkColor, noteInkFor } from '../../canvas/engine/theme.ts'

type El = Readonly<Record<string, unknown>>

/** The id of the text element that carries a frame's name in the preview (`<prefix><frame id>`). */
export const PREVIEW_LABEL_PREFIX = 'lobby-preview-label:'

/** The frame a preview label stands for (a click on a title picks its frame), or null when `id` is not a label. */
export const frameOfPreviewLabel = (id: string): string | null =>
  id.startsWith(PREVIEW_LABEL_PREFIX) ? id.slice(PREVIEW_LABEL_PREFIX.length) : null

/** A frame's name as the engine draws it: the font and the gap above the frame (FRAME_STYLE, with Lobby's offset). */
const LABEL_FONT_SIZE = 14
const LABEL_LINE_HEIGHT = 1.25
const LABEL_GAP = 6
/** Helvetica: what the exporter's own label uses (a system font, nothing to load). */
const LABEL_FONT_FAMILY = 2
/** The width of one character of a 14 px Helvetica name, for cutting a long name at the frame's edge. */
const LABEL_CHAR_WIDTH = 7.4

/**
 * Lobby's ink as an ink the dark table draws as it is, not as CHALK: a hair off INK (a colour that is not a hex of the
 * table and not a neutral grey is drawn unchanged, canvas/engine/theme.ts lobbyDarkColor). The dark preview needs it
 * when a note's fill is light and its label must stay dark.
 */
export const INK_DRAWN_AS_IS = '#1b2331'

/**
 * The colour to store on a text element so the exporter draws it in `ink` (INK or CHALK, `noteInkFor`'s answers) in
 * `theme`. Light: as it is. Dark: the exporter filters every colour, so the stored colour is the one whose dark answer
 * is `ink`. null for any other ink: the label is left as it was stored.
 */
export function storedInkFor(ink: string, theme: 'light' | 'dark'): string | null {
  if (theme === 'light') return ink
  const as = ink.toLowerCase()
  // CHALK is what the dark table draws INK as; INK itself needs the nudged ink, which is drawn as it is
  if (as === CHALK.toLowerCase()) return INK
  if (as === INK.toLowerCase()) return INK_DRAWN_AS_IS
  return null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown, or = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : or)

/**
 * Whether a stored ink is a default one (the dark table draws it as CHALK: Lobby's INK, the engine's #1e1e1e, black),
 * not a colour somebody picked: the same test as the live canvas's (canvas/engine/theme.ts noteInkOverride).
 */
const isDefaultInk = (c: unknown): boolean => typeof c === 'string' && lobbyDarkColor(c) === CHALK

/** The fill a note's label sits on (its container's), or null when the element is not a note's label. */
function noteFillOf(el: El, byId: ReadonlyMap<string, El>): string | null {
  if (el.type !== 'text') return null
  const containerId = str(el.containerId)
  const container = containerId ? byId.get(containerId) : undefined
  return container?.type === 'stickynote' ? (str(container.backgroundColor) ?? '#ffffff') : null
}

/** A frame's name (a frame that has none is called "Frame", as the engine's own label does). */
const frameName = (f: El): string => {
  const n = str(f.name)
  return n === null ? 'Frame' : n
}

/** The text element that carries a frame's name: above the frame's top left, cut at the frame's width. */
function labelFor(frame: El): El | null {
  const name = frameName(frame).replace(/\s+/g, ' ').trim()
  const id = str(frame.id)
  if (!name || !id) return null
  const width = Math.max(1, num(frame.width))
  const fit = Math.max(1, Math.floor(width / LABEL_CHAR_WIDTH))
  const text = name.length > fit ? `${name.slice(0, Math.max(1, fit - 1))}…` : name
  const height = LABEL_FONT_SIZE * LABEL_LINE_HEIGHT
  return {
    id: `${PREVIEW_LABEL_PREFIX}${id}`,
    type: 'text',
    x: num(frame.x),
    y: num(frame.y) - LABEL_GAP - height,
    width: Math.min(width, text.length * LABEL_CHAR_WIDTH),
    height,
    angle: 0,
    // the theme's ink: INK stored, which the dark table draws as CHALK
    strokeColor: INK,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: null,
    text,
    originalText: text,
    fontSize: LABEL_FONT_SIZE,
    fontFamily: LABEL_FONT_FAMILY,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: LABEL_LINE_HEIGHT,
  }
}

/**
 * `elements` as the preview draws them in `theme` (see the header): frames without a name of their own, each with a
 * label in the theme's ink, and note labels in `noteInkFor`'s ink. Order is kept (a label follows its frame, so it is
 * drawn over the frame's clip like the engine's own); the checkpoint's elements are not changed.
 */
export function themedPreviewElements(elements: readonly unknown[], theme: 'light' | 'dark'): unknown[] {
  const list = elements.filter((e): e is El => typeof e === 'object' && e !== null)
  const byId = new Map<string, El>()
  for (const e of list) {
    const id = str(e.id)
    if (id) byId.set(id, e)
  }
  const out: unknown[] = []
  for (const e of list) {
    if (e.isDeleted === true) {
      out.push(e)
      continue
    }
    if (e.type === 'frame' || e.type === 'magicframe') {
      // an empty name: the exporter's own label is nothing; ours is the one drawn
      out.push({ ...e, name: '' })
      const label = labelFor(e)
      if (label) out.push(label)
      continue
    }
    const fill = noteFillOf(e, byId)
    if (fill !== null && isDefaultInk(e.strokeColor)) {
      const stored = storedInkFor(noteInkFor(fill, theme), theme)
      out.push(stored !== null && stored !== e.strokeColor ? { ...e, strokeColor: stored } : e)
      continue
    }
    out.push(e)
  }
  return out
}
