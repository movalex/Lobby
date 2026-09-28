/**
 * Server-made notes and labels (plan §2.11): place-notes, the converter, AI seeds and the
 * lease-expiry re-layout build `stickynote` + bound `text` pairs with Excalidraw's own code, so a
 * note made in Node lays out like one made in the browser.
 *
 * The same builder runs in the browser probe (`apps/web/test/engine-probe/browser`) with Chromium's
 * canvas metrics, which is how spike check A3 compares the two.
 */
import { raw, rawCommon } from './raw.ts'
import type {
  LobbyFontFamily,
  StickyNoteElement,
  StickyNoteLayout,
  StickyNoteLayoutOpts,
  TextElement,
} from './types.ts'

/** Lobby's note defaults (plan §2.3.2, §2.11). */
export const NOTE_DEFAULTS = {
  size: 200,
  fontFamily: 6 as LobbyFontFamily,
  baseFontSize: 20,
  roughness: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: '#fff3bf',
} as const

export interface NoteSpec {
  id: string
  x: number
  y: number
  text: string
  /** note width; the note is square at creation (`baseHeight` = `width` unless given) */
  width?: number
  baseHeight?: number
  angle?: number
  fontFamily?: LobbyFontFamily
  /** the size the user picked: the ceiling the auto-fit shrinks from */
  baseFontSize?: number
  backgroundColor?: string
  strokeColor?: string
  index?: string | null
  /** ids and seeds are passed so a server-made note is deterministic */
  labelId?: string
  seed?: number
}

export interface BuiltNote {
  note: StickyNoteElement
  label: TextElement | null
}

/** Typed `getStickyNoteLayout` (element `index.js:6964-7042`). Pure. */
export const layoutStickyNote = (
  note: StickyNoteElement,
  label: TextElement | null,
  opts?: StickyNoteLayoutOpts,
): StickyNoteLayout => raw.getStickyNoteLayout(note, label, opts)

/**
 * Build a sticky note with its label, laid out. `created` is always null so Excalidraw draws no
 * creation-date footer (plan §2.11; `getStickyNoteFooter` returns null for null `created`).
 */
export const buildStickyNote = (spec: NoteSpec): BuiltNote => {
  const width = spec.width ?? NOTE_DEFAULTS.size
  const baseHeight = spec.baseHeight ?? width
  const fontFamily = spec.fontFamily ?? NOTE_DEFAULTS.fontFamily
  const baseFontSize = spec.baseFontSize ?? NOTE_DEFAULTS.baseFontSize
  const strokeColor = spec.strokeColor ?? NOTE_DEFAULTS.strokeColor
  const labelId = spec.labelId ?? `${spec.id}.t`
  const hasText = spec.text.length > 0
  const note0 = raw.newStickyNoteElement({
    type: 'stickynote',
    id: spec.id,
    x: spec.x,
    y: spec.y,
    width,
    height: baseHeight,
    baseHeight,
    angle: spec.angle ?? 0,
    strokeColor,
    backgroundColor: spec.backgroundColor ?? NOTE_DEFAULTS.backgroundColor,
    roughness: NOTE_DEFAULTS.roughness,
    index: spec.index ?? null,
    seed: spec.seed ?? 1,
    created: null,
    boundElements: hasText ? [{ id: labelId, type: 'text' }] : null,
  })
  if (!hasText) {
    const lay = layoutStickyNote(note0, null)
    return { note: { ...note0, ...lay.container }, label: null }
  }
  const label0 = raw.newTextElement({
    id: labelId,
    x: spec.x + width / 2,
    y: spec.y + baseHeight / 2,
    text: spec.text,
    originalText: spec.text,
    fontSize: baseFontSize,
    baseFontSize,
    fontFamily,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: spec.id,
    strokeColor,
    roughness: NOTE_DEFAULTS.roughness,
    angle: spec.angle ?? 0,
    seed: spec.seed ?? 1,
    autoResize: true,
  })
  const lay = layoutStickyNote(note0, label0)
  const note = { ...note0, ...lay.container }
  const label = lay.text ? { ...label0, ...lay.text } : label0
  return { note, label }
}

/** Wrap one label's `originalText` the way the note layout does (`wrapText`, index.js:6062). */
export const wrapLabelText = (
  text: string,
  fontFamily: LobbyFontFamily,
  fontSizePx: number,
  maxWidth: number,
) => raw.wrapText(text, fontString(fontFamily, fontSizePx), maxWidth)

/** The font string Excalidraw measures with, fallbacks included. */
export const fontString = (fontFamily: LobbyFontFamily, fontSizePx: number) =>
  rawCommon.getFontString({ fontFamily, fontSize: fontSizePx })

export const fontFamilyName = (family: LobbyFontFamily) =>
  family === 5 ? 'Excalifont' : family === 8 ? 'Comic Shanns' : 'Nunito'

/** Whether Excalidraw would draw the creation-date footer on this note (`getStickyNoteFooter`). */
export const stickyNoteHasFooter = (
  note: Pick<StickyNoteElement, 'created' | 'width' | 'height'>,
  now?: number,
) => raw.getStickyNoteFooter(note, now) !== null
