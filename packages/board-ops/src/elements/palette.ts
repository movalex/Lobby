/**
 * Lobby's colours on the new canvas: the 13 colour names (tldraw's colour-style names, which boards, the
 * templates and the CSV keep using) and the literal light-mode values Excalidraw stores for them. Excalidraw
 * stores literal colours and darkens them with its canvas filter, so only light values exist here.
 *
 * The values are the converter's (`packages/tldraw-import/src/palette.ts`: tldraw 5.4.2's light theme with
 * Lobby's overrides from `apps/web/src/features/canvas-ux/palette.ts`, the 13 note fills with their ink and
 * GREY_INK for grey text and strokes), so a template made on the new canvas and a converted board look the
 * same. `elements/palette.test.ts` checks both tables stay equal.
 *
 * Pure: no imports.
 */

export const LOBBY_COLOR_NAMES = [
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
export type LobbyColorName = (typeof LOBBY_COLOR_NAMES)[number]

export interface LobbyColorSet {
  /** strokes, text, labels (tldraw `solid`; grey is Lobby's readable GREY_INK) */
  readonly solid: string
  /** the full-colour fill (tldraw `fill`) */
  readonly fill: string
  /** the pale tint (tldraw's `semi` colour, used by the 'solid' fill style) */
  readonly semi: string
  /** Lobby's sticky-note fill */
  readonly noteFill: string
  /** Lobby's sticky-note ink */
  readonly noteText: string
}

/** Lobby's note ink. */
export const LOBBY_INK = '#1b2330'
/** Lobby's readable grey (GREY_INK.light) replaces tldraw's grey solid. */
export const LOBBY_GREY_INK = '#5f6b7a'
/** The near-white card fill (tldraw light `colors.solid`, the 'semi' fill style's background). */
export const LOBBY_SEMI_FILL = '#fcfffe'
/** A frame's outline (the converter's value). */
export const LOBBY_FRAME_STROKE = '#bbb'

// [solid, fill, semi] from tldraw 5.4.2's light theme, grey's solid replaced by LOBBY_GREY_INK
const TL: Record<LobbyColorName, readonly [string, string, string]> = {
  black: ['#1d1d1d', '#1d1d1d', '#e8e8e8'],
  blue: ['#4465e9', '#4465e9', '#dce1f8'],
  green: ['#099268', '#099268', '#d3e9e3'],
  grey: [LOBBY_GREY_INK, '#9fa8b2', '#eceef0'],
  'light-blue': ['#4ba1f1', '#4ba1f1', '#ddedfa'],
  'light-green': ['#4cb05e', '#4cb05e', '#dbf0e0'],
  'light-red': ['#f87777', '#f87777', '#f4dadb'],
  'light-violet': ['#e085f4', '#e085f4', '#f5eafa'],
  orange: ['#e16919', '#e16919', '#f8e2d4'],
  red: ['#e03131', '#e03131', '#f4dadb'],
  violet: ['#ae3ec9', '#ae3ec9', '#ecdcf2'],
  yellow: ['#f1ac4b', '#f1ac4b', '#f9f0e6'],
  white: ['#ffffff', '#ffffff', '#f5f5f5'],
}

/** Lobby's note fills (COL-06), light mode; every note's ink is LOBBY_INK. */
const NOTE_FILL: Record<LobbyColorName, string> = {
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

export const LOBBY_PALETTE: Readonly<Record<LobbyColorName, LobbyColorSet>> = Object.freeze(
  Object.fromEntries(
    LOBBY_COLOR_NAMES.map((name) => {
      const [solid, fill, semi] = TL[name]
      return [name, Object.freeze({ solid, fill, semi, noteFill: NOTE_FILL[name], noteText: LOBBY_INK })]
    }),
  ) as Record<LobbyColorName, LobbyColorSet>,
)

export const isLobbyColorName = (v: unknown): v is LobbyColorName =>
  typeof v === 'string' && (LOBBY_COLOR_NAMES as readonly string[]).includes(v)

/** The colour set of a colour name (unknown names read as black, like tldraw's validator). */
export const lobbyColor = (name: unknown): LobbyColorSet =>
  isLobbyColorName(name) ? LOBBY_PALETTE[name] : LOBBY_PALETTE.black

const norm = (hex: unknown) => (typeof hex === 'string' ? hex.trim().toLowerCase() : '')

/** The name of a sticky-note fill, or null when it is not one of Lobby's 13. */
export function noteColorName(backgroundColor: unknown): LobbyColorName | null {
  const hex = norm(backgroundColor)
  return LOBBY_COLOR_NAMES.find((n) => NOTE_FILL[n] === hex) ?? null
}

/**
 * The name of a stroke or text colour, or null. `black` and `white` fills equal their strokes; the first
 * name in LOBBY_COLOR_NAMES order wins a tie (none exists among the strokes).
 */
export function strokeColorName(strokeColor: unknown): LobbyColorName | null {
  const hex = norm(strokeColor)
  return LOBBY_COLOR_NAMES.find((n) => TL[n][0] === hex) ?? null
}
