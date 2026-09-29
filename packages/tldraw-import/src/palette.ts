/**
 * Lobby's effective LIGHT palette for converted boards: tldraw 5.4.2's `DEFAULT_THEME.colors.light`
 * (editor ThemeManager defaultThemes.ts) with Lobby's own overrides (apps/web/src/features/canvas-ux/
 * palette.ts: the 13 note fills with their ink, and GREY_INK for grey text and strokes). Excalidraw stores
 * literal colours and darkens them with a canvas filter, so only light values are stored.
 *
 * Ported from [DATA]'s prototype (`data/proto/palette.ts`, `tl-light-colors.json`).
 */

export const TL_COLOR_NAMES = [
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
export type TlColorName = (typeof TL_COLOR_NAMES)[number]

export interface ColorSet {
  readonly solid: string
  readonly fill: string
  readonly linedFill: string
  readonly semi: string
  readonly pattern: string
  readonly highlightSrgb: string
  /** Lobby's note fill (light) */
  readonly noteFill: string
  /** Lobby's note ink (light) */
  readonly noteText: string
}

// [solid, fill, linedFill, semi, pattern, highlightSrgb] from tldraw 5.4.2's light theme
const TL: Record<TlColorName, readonly [string, string, string, string, string, string]> = {
  black: ['#1d1d1d', '#1d1d1d', '#363636', '#e8e8e8', '#494949', '#fddd00'],
  blue: ['#4465e9', '#4465e9', '#6580ec', '#dce1f8', '#6681ee', '#10acff'],
  green: ['#099268', '#099268', '#0bad7c', '#d3e9e3', '#39a785', '#00ffc8'],
  grey: ['#9fa8b2', '#9fa8b2', '#bbc1c9', '#eceef0', '#bcc3c9', '#cbe7f1'],
  'light-blue': ['#4ba1f1', '#4ba1f1', '#7abaf5', '#ddedfa', '#6fbbf8', '#00f4ff'],
  'light-green': ['#4cb05e', '#4cb05e', '#7ec88c', '#dbf0e0', '#65cb78', '#65f641'],
  'light-red': ['#f87777', '#f87777', '#f99a9a', '#f4dadb', '#fe9e9e', '#ff7fa3'],
  'light-violet': ['#e085f4', '#e085f4', '#e9abf7', '#f5eafa', '#e9acf8', '#ff88ff'],
  orange: ['#e16919', '#e16919', '#ea8643', '#f8e2d4', '#f78438', '#ffa500'],
  red: ['#e03131', '#e03131', '#e75f5f', '#f4dadb', '#e55959', '#ff636e'],
  violet: ['#ae3ec9', '#ae3ec9', '#be68d4', '#ecdcf2', '#bd63d3', '#c77cff'],
  yellow: ['#f1ac4b', '#f1ac4b', '#f5c27a', '#f9f0e6', '#fecb92', '#fddd00'],
  white: ['#ffffff', '#ffffff', '#ffffff', '#f5f5f5', '#f9f9f9', '#ffffff'],
}

/** Lobby's note fills (COL-06), light mode; every note's ink is INK. */
const LOBBY_NOTE_FILL: Record<TlColorName, string> = {
  black: '#f8e48f',
  yellow: '#f6c453',
  orange: '#f4a874',
  'light-red': '#f6bfc4',
  red: '#ef8c82',
  'light-violet': '#e3c9f4',
  violet: '#c5a4ea',
  blue: '#a7b7f6',
  'light-blue': '#a6d8f3',
  green: '#93cfa6',
  'light-green': '#cde7a2',
  grey: '#d6d9de',
  white: '#ffffff',
}
/** Lobby's note ink. */
export const LOBBY_INK = '#1b2330'
/** Lobby's readable grey (GREY_INK.light) replaces tldraw's grey solid. */
export const LOBBY_GREY_INK = '#5f6b7a'
/** tldraw light `colors.solid` (the 'semi' fill's background). */
export const TL_SOLID_BACKGROUND = '#fcfffe'

export const PALETTE: Readonly<Record<TlColorName, ColorSet>> = Object.fromEntries(
  TL_COLOR_NAMES.map((name) => {
    const [solid, fill, linedFill, semi, pattern, highlightSrgb] = TL[name]
    return [
      name,
      {
        solid: name === 'grey' ? LOBBY_GREY_INK : solid,
        fill,
        linedFill,
        semi,
        pattern,
        highlightSrgb,
        noteFill: LOBBY_NOTE_FILL[name],
        noteText: LOBBY_INK,
      },
    ]
  }),
) as Record<TlColorName, ColorSet>

/** The colour set of a tldraw colour name (unknown names read as black, as tldraw's validator never lets them in). */
export const colorOf = (name: unknown): ColorSet =>
  (TL_COLOR_NAMES as readonly unknown[]).includes(name) ? PALETTE[name as TlColorName] : PALETTE.black
