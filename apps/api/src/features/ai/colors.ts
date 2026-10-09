// Lobby's colour names of an element, for a plain-language command's index (wave L, L1-4): the model sees
// "a red note", never a hex value. The values are board-ops' (packages/board-ops/src/elements/palette.ts:
// the 13 note fills and the stroke colours Excalidraw stores), copied here because the api's main process
// never loads @draftroom/board-ops/elements (it pulls the Excalidraw engine in, which the api runs only in
// its conversion worker). test/features/ai/colors.test.ts keeps both tables equal to board-ops'.
//
// Pure: no imports but the names.

import { AI_COLOR_NAMES, type AiColorName } from '@draftroom/contracts'

/** Lobby's note fills, light mode (board-ops NOTE_FILL). */
export const NOTE_FILLS: Readonly<Record<AiColorName, string>> = {
  black: '#f8e48f',
  blue: '#a7b7f6',
  green: '#93cfa6',
  grey: '#d6d9de',
  'light-blue': '#a6d8f3',
  'light-green': '#cde7a2',
  'light-red': '#f6bfc4',
  'light-violet': '#e3c9f4',
  orange: '#f4a874',
  red: '#ef8c82',
  violet: '#c5a4ea',
  yellow: '#f6c453',
  white: '#ffffff',
}

/** Stroke and text colours (board-ops LOBBY_PALETTE[name].solid). */
export const STROKES: Readonly<Record<AiColorName, string>> = {
  black: '#1d1d1d',
  blue: '#4465e9',
  green: '#099268',
  grey: '#5f6b7a',
  'light-blue': '#4ba1f1',
  'light-green': '#4cb05e',
  'light-red': '#f87777',
  'light-violet': '#e085f4',
  orange: '#e16919',
  red: '#e03131',
  violet: '#ae3ec9',
  yellow: '#f1ac4b',
  white: '#ffffff',
}

const norm = (hex: unknown) => (typeof hex === 'string' ? hex.trim().toLowerCase() : '')

/** The name of a sticky-note fill, or null when it is not one of Lobby's 13 (board-ops noteColorName). */
export const noteColorName = (backgroundColor: unknown): AiColorName | null =>
  AI_COLOR_NAMES.find((n) => NOTE_FILLS[n] === norm(backgroundColor)) ?? null

/** The name of a stroke or text colour, or null (board-ops strokeColorName: the first name wins a tie). */
export const strokeColorName = (strokeColor: unknown): AiColorName | null =>
  AI_COLOR_NAMES.find((n) => STROKES[n] === norm(strokeColor)) ?? null
