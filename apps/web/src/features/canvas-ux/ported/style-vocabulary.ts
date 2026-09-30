// The style panel's vocabulary on the Excalidraw canvas (docs/EXCALIDRAW-CONTRACTS.md §6.2 "styles-theme":
// "StyleValues use the engine's field names; the palette names are 3a's"). People pick what they picked on
// the tldraw board, a colour by name (13, tldraw's), a fill, a dash, a size and a font, and this module
// turns the pick into engine fields (canvas/api `StyleValues`) and reads the fields back into names.
//
// The values are the ones the tldraw → Excalidraw converter writes (packages/tldraw-import/src/palette.ts
// and convert.ts `styleFromTl`, pinned by style-vocabulary.test.ts), so a converted board and a board
// drawn on the new canvas speak the same colours: a shape's colour is its stroke (tldraw's `solid`, with
// Lobby's readable grey), its fill the same colour's `semi`/`fill`/`pattern` shade, a note's colour its
// fill from Lobby's note palette (../palette.ts). Excalidraw stores light values and darkens the canvas
// with a filter in dark mode, so only light values are stored (THEME_FILTER shows a swatch as drawn).
//
// Pure.
import type { MixedStyles, StyleValues } from '../../../canvas/api/index.ts'
import { NOTE_PALETTE, type NoteColorName } from '../palette.ts'

export const COLOR_NAMES = [
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
  'white',
] as const
export type ColorName = (typeof COLOR_NAMES)[number]

/** tldraw 5.4.2's names for its colours (the picker's labels, `color-style.*`). */
export const COLOR_LABELS: Readonly<Record<ColorName, string>> = {
  black: 'Black',
  grey: 'Grey',
  'light-violet': 'Light violet',
  violet: 'Violet',
  blue: 'Blue',
  'light-blue': 'Light blue',
  yellow: 'Yellow',
  orange: 'Orange',
  green: 'Green',
  'light-green': 'Light green',
  'light-red': 'Light red',
  red: 'Red',
  white: 'White',
}

/** tldraw 5.4.2's light shades per colour, [solid, semi, pattern], with Lobby's grey ink (GREY_INK.light). */
export const SHADES: Readonly<Record<ColorName, { solid: string; semi: string; pattern: string }>> = {
  black: { solid: '#1d1d1d', semi: '#e8e8e8', pattern: '#494949' },
  grey: { solid: '#5f6b7a', semi: '#eceef0', pattern: '#bcc3c9' },
  'light-violet': { solid: '#e085f4', semi: '#f5eafa', pattern: '#e9acf8' },
  violet: { solid: '#ae3ec9', semi: '#ecdcf2', pattern: '#bd63d3' },
  blue: { solid: '#4465e9', semi: '#dce1f8', pattern: '#6681ee' },
  'light-blue': { solid: '#4ba1f1', semi: '#ddedfa', pattern: '#6fbbf8' },
  yellow: { solid: '#f1ac4b', semi: '#f9f0e6', pattern: '#fecb92' },
  orange: { solid: '#e16919', semi: '#f8e2d4', pattern: '#f78438' },
  green: { solid: '#099268', semi: '#d3e9e3', pattern: '#39a785' },
  'light-green': { solid: '#4cb05e', semi: '#dbf0e0', pattern: '#65cb78' },
  'light-red': { solid: '#f87777', semi: '#f4dadb', pattern: '#fe9e9e' },
  red: { solid: '#e03131', semi: '#f4dadb', pattern: '#e55959' },
  white: { solid: '#ffffff', semi: '#f5f5f5', pattern: '#f9f9f9' },
}
/** tldraw's 'semi' fill: its light canvas colour (TL_SOLID_BACKGROUND in the converter). */
export const SEMI_FILL = '#fcfffe'
/** Lobby's note ink: every note and its label (tldraw-import LOBBY_INK). */
export const NOTE_INK = '#1b2330'
export const TRANSPARENT = 'transparent'

/**
 * Excalidraw's dark mode: the canvas is drawn through this CSS filter (THEME_FILTER, @excalidraw/common),
 * so a swatch in dark mode shows the colour as the canvas will draw it.
 */
export const THEME_FILTER = 'invert(93%) hue-rotate(180deg)'

// ---- notes ------------------------------------------------------------------------------------------

/** A note's stored fill for a palette name (the light fill of ../palette.ts NOTE_PALETTE). */
export const noteFillOf = (name: NoteColorName): string =>
  (NOTE_PALETTE.find((s) => s.name === name) ?? NOTE_PALETTE[0])?.light.fill ?? '#f8e48f'

/** The palette name of a stored note fill, or null for a colour outside the palette. */
export function noteColorOf(fill: unknown): NoteColorName | null {
  if (typeof fill !== 'string') return null
  const f = fill.toLowerCase()
  return NOTE_PALETTE.find((s) => s.light.fill.toLowerCase() === f)?.name ?? null
}

// ---- colour and fill ----------------------------------------------------------------------------------

export const FILLS = ['none', 'semi', 'solid', 'pattern'] as const
export type FillName = (typeof FILLS)[number]
export const FILL_LABELS: Readonly<Record<FillName, string>> = {
  none: 'None',
  semi: 'Semi',
  solid: 'Solid',
  pattern: 'Pattern',
}

/** The colour name of a stroke colour, or null (a colour made elsewhere, or a converted legacy one). */
export function colorNameOf(stroke: unknown): ColorName | null {
  if (typeof stroke !== 'string') return null
  const s = stroke.toLowerCase()
  // tldraw's own grey (#9fa8b2) is Lobby's grey too: converted text and templates carry both
  if (s === '#9fa8b2') return 'grey'
  return COLOR_NAMES.find((n) => SHADES[n].solid === s) ?? null
}

/** The fill name of a (background, fillStyle) pair, or null when it is none of the four. */
export function fillNameOf(background: unknown, fillStyle: unknown): FillName | null {
  if (typeof background !== 'string') return null
  const b = background.toLowerCase()
  if (b === TRANSPARENT) return 'none'
  if (fillStyle === 'hachure' || fillStyle === 'cross-hatch' || fillStyle === 'zigzag') return 'pattern'
  if (b === SEMI_FILL) return 'semi'
  return 'solid'
}

/** The engine fields of a shape with this colour and fill. */
export function shapeFields(color: ColorName, fill: FillName): StyleValues {
  const c = SHADES[color]
  switch (fill) {
    case 'none':
      return { strokeColor: c.solid, backgroundColor: TRANSPARENT, fillStyle: 'solid' }
    case 'semi':
      return { strokeColor: c.solid, backgroundColor: SEMI_FILL, fillStyle: 'solid' }
    case 'solid':
      return { strokeColor: c.solid, backgroundColor: c.semi, fillStyle: 'solid' }
    case 'pattern':
      return { strokeColor: c.solid, backgroundColor: c.pattern, fillStyle: 'hachure' }
  }
}

// ---- dash, size, font, alignment ------------------------------------------------------------------------

export const DASHES = ['draw', 'solid', 'dashed', 'dotted'] as const
export type DashName = (typeof DASHES)[number]
export const DASH_LABELS: Readonly<Record<DashName, string>> = {
  draw: 'Draw',
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted',
}
/** tldraw's `draw` dash is Excalidraw's hand-drawn roughness (the converter's rule). */
export function dashFields(dash: DashName): StyleValues {
  if (dash === 'draw') return { strokeStyle: 'solid', roughness: 1 }
  return { strokeStyle: dash, roughness: 0 }
}
export function dashNameOf(strokeStyle: unknown, roughness: unknown): DashName | null {
  if (strokeStyle === 'dashed' || strokeStyle === 'dotted') return strokeStyle
  if (strokeStyle !== 'solid') return null
  return typeof roughness === 'number' && roughness > 0 ? 'draw' : 'solid'
}

export const SIZES = ['s', 'm', 'l', 'xl'] as const
export type SizeName = (typeof SIZES)[number]
export const SIZE_LABELS: Readonly<Record<SizeName, string>> = {
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  xl: 'Extra large',
}
/**
 * Stroke width per size: the engine's own widths (thin 1, medium 2, bold 4, extra bold 8; @excalidraw/common
 * STROKE_WIDTH), so a shape drawn with the engine's tools and one resized here read the same. tldraw's widths
 * (2, 3.5, 5, 10) are what converted boards carry: they keep them, and show no size until one is picked.
 */
export const STROKE_WIDTH: Readonly<Record<SizeName, number>> = { s: 1, m: 2, l: 4, xl: 8 }
/** A pen stroke's width per size (the engine's FREEDRAW_STROKE_WIDTH). */
export const FREEDRAW_WIDTH: Readonly<Record<SizeName, number>> = { s: 0.5, m: 1, l: 2, xl: 4 }
/**
 * The next shape's width key per size, as a width the canvas's next style takes (thin, medium, bold: the
 * engine has no extra bold key for new shapes).
 */
export const NEXT_STROKE_WIDTH: Readonly<Record<SizeName, number>> = { s: 1, m: 2, l: 4, xl: 4 }
/** Free text font size per size (tldraw's FONT_SIZES). */
export const TEXT_SIZE: Readonly<Record<SizeName, number>> = { s: 18, m: 24, l: 36, xl: 44 }
/** Note and label font size per size (tldraw's LABEL_FONT_SIZES). */
export const LABEL_SIZE: Readonly<Record<SizeName, number>> = { s: 18, m: 22, l: 26, xl: 32 }

/** The size name nearest to a value on one of the scales (a converted board may hold scaled values). */
export function sizeNameOf(value: unknown, scale: Readonly<Record<SizeName, number>>): SizeName | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  let best: SizeName | null = null
  let gap = Number.POSITIVE_INFINITY
  for (const s of SIZES) {
    const d = Math.abs(scale[s] - value)
    if (d < gap) {
      best = s
      gap = d
    }
  }
  return gap <= 0.01 ? best : null
}

export const FONTS = ['draw', 'sans', 'mono'] as const
export type FontName = (typeof FONTS)[number]
export const FONT_LABELS: Readonly<Record<FontName, string>> = { draw: 'Draw', sans: 'Sans', mono: 'Mono' }
/** Excalifont 5, Nunito 6, Comic Shanns 8 (canvas-schema LOBBY_FONT_FAMILIES); tldraw's serif has none. */
export const FONT_FAMILY: Readonly<Record<FontName, number>> = { draw: 5, sans: 6, mono: 8 }
export const fontNameOf = (family: unknown): FontName | null =>
  FONTS.find((f) => FONT_FAMILY[f] === family) ?? null

export const ALIGNS = ['left', 'center', 'right'] as const
export type AlignName = (typeof ALIGNS)[number]
export const ALIGN_LABELS: Readonly<Record<AlignName, string>> = {
  left: 'Start',
  center: 'Middle',
  right: 'End',
}
export const VALIGNS = ['top', 'middle', 'bottom'] as const
export type VAlignName = (typeof VALIGNS)[number]
export const VALIGN_LABELS: Readonly<Record<VAlignName, string>> = {
  top: 'Top',
  middle: 'Middle',
  bottom: 'Bottom',
}

/** tldraw's opacity steps (`opacity-style.*`), as Excalidraw's 0-100. */
export const OPACITY_STEPS = [10, 25, 50, 75, 100] as const
export const opacityStepOf = (value: unknown): number | null =>
  typeof value === 'number'
    ? OPACITY_STEPS.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a))
    : null

// ---- arrows ------------------------------------------------------------------------------------------

/** Arrowheads Lobby offers (tldraw's names where Excalidraw has the same head). */
export const ARROWHEADS = ['none', 'arrow', 'triangle', 'bar', 'dot', 'diamond'] as const
export type ArrowheadName = (typeof ARROWHEADS)[number]
export const ARROWHEAD_LABELS: Readonly<Record<ArrowheadName, string>> = {
  none: 'None',
  arrow: 'Arrow',
  triangle: 'Triangle',
  bar: 'Bar',
  dot: 'Dot',
  diamond: 'Diamond',
}
const HEAD_FIELD: Readonly<Record<ArrowheadName, string | null>> = {
  none: null,
  arrow: 'arrow',
  triangle: 'triangle',
  bar: 'bar',
  dot: 'circle',
  diamond: 'diamond',
}
export const arrowheadField = (name: ArrowheadName): string | null => HEAD_FIELD[name]
export function arrowheadNameOf(value: unknown): ArrowheadName | null {
  if (value === null) return 'none'
  return ARROWHEADS.find((n) => HEAD_FIELD[n] === value) ?? null
}

// ---- reading a MixedStyles back ---------------------------------------------------------------------------

/** One field of `of()`: its value, 'mixed', or undefined when no element of the selection has it. */
export type Shared<T> = T | 'mixed' | undefined

/** A MixedStyles field mapped through `name` ('mixed' stays, an unknown value reads as 'mixed'). */
export function sharedName<T>(styles: MixedStyles, field: keyof MixedStyles, name: (v: unknown) => T | null) {
  const v = styles[field]
  if (v === undefined) return undefined
  if (v === 'mixed') return 'mixed' as const
  return name(v) ?? ('mixed' as const)
}
