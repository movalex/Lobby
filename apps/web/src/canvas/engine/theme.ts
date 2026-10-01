// Lobby's look on the Excalidraw canvas (wave 5, owner 2C; docs/research/excalidraw/REVIEW-W5-EARLY.md
// W5-10, W5-15): frame names and outlines that read, an off-white canvas, and a dark mode that keeps
// Lobby's colours instead of Excalidraw's invert-and-rotate of every colour.
//
//  - W5-10: frame names were #999999 on white (2.65:1; 3.84:1 dark) and frame outlines light grey on a
//    white canvas. Names now use Lobby's ink (#1b2330 light, #ebe8e1 dark: >= 4.5:1 on the canvas), the
//    outline a grey of >= 3:1, and the canvas is tldraw's #f9fafb (exports keep their own white,
//    canvas/export/scene.ts). Excalidraw reads these from FRAME_STYLE (@excalidraw/common) when it draws
//    a frame (its outline on the canvas, its name in the DOM and in exports), so they are set there once.
//  - W5-15: Excalidraw draws dark mode by passing every element colour through `applyDarkModeFilter`
//    (invert 93 %, hue-rotate 180°), which turned Ember #f1ac4b into #874c00, Signal red into #ff8383 and
//    the note fills muddy. Its results go through one module-level cache; Lobby takes that cache (the
//    `set` of a first probe call shows which Map it is) and answers it first: tldraw 5.4.2's designed dark
//    shade for every colour of the palette Lobby draws with (the style panel's and the converter's), the
//    note palette's designed dark fills, Lobby's inks; any other explicit colour unchanged; and only
//    neutral greys (the engine's default ink and white) through Excalidraw's own filter.
//
// One deliberate difference from tldraw: a note's label carries one ink for every note colour, so a colour
// map cannot give "Paper" (white) notes dark ink on a light fill in dark mode as tldraw did; Paper becomes
// a dark paper with light ink instead (readable, >= 4.5:1, pinned by theme.test.ts).
//
// Browser and Node (pure apart from the install).
import { applyDarkModeFilter, FRAME_STYLE } from '@excalidraw/common'
import { GREY_INK, NOTE_PALETTE } from '../../features/canvas-ux/palette.ts'

/** The canvas (light): tldraw's light background. */
export const CANVAS_LIGHT = '#f9fafb'
/** The canvas (dark): tldraw's dark background, hsl(240, 5%, 6.5%). */
export const CANVAS_DARK = '#101011'
/** Lobby's ink: frame names, note labels. */
export const INK = '#1b2330'
/** Lobby's dark-mode ink (the note palette's dark text). */
export const CHALK = '#f4f1ea'
/** Frame names in dark mode (the review's ink token). */
export const FRAME_NAME_DARK = '#ebe8e1'
/** Frame outlines: >= 3:1 on the canvas in both modes. */
export const FRAME_OUTLINE_LIGHT = '#7d8799'
export const FRAME_OUTLINE_DARK = '#6b7280'
/** "Paper" notes and white strokes in dark mode (see the header). */
export const PAPER_DARK = '#2b2f35'

/**
 * tldraw 5.4.2's light → dark shades (DEFAULT_THEME.colors, ThemeManager/defaultThemes.mjs): solid, fill,
 * linedFill, semi, pattern and highlightSrgb of its 13 colours, the colours Lobby's style panel stores and
 * the converter writes. Where two shades share a light value tldraw's first is kept (red's semi = light-red's).
 */
const TLDRAW_DARK: Readonly<Record<string, string>> = {
  '#1d1d1d': '#f2f2f2',
  '#363636': '#ffffff',
  '#e8e8e8': '#2c3036',
  '#494949': '#989898',
  '#fddd00': '#d2b700',
  '#9fa8b2': '#9398b0',
  '#bbc1c9': '#8388a5',
  '#eceef0': '#33373c',
  '#bcc3c9': '#7c8187',
  '#cbe7f1': '#9cb4cb',
  '#e085f4': '#e599f7',
  '#e9abf7': '#dc71f4',
  '#f5eafa': '#383442',
  '#e9acf8': '#9770a9',
  '#ff88ff': '#c400c7',
  '#ae3ec9': '#ae3ec9',
  '#be68d4': '#8f2fa7',
  '#ecdcf2': '#342938',
  '#bd63d3': '#763a8b',
  '#c77cff': '#9e00ee',
  '#4465e9': '#4f72fc',
  '#6580ec': '#3c5cdd',
  '#dce1f8': '#262d40',
  '#6681ee': '#3a4b9e',
  '#10acff': '#0079d2',
  '#4ba1f1': '#4dabf7',
  '#7abaf5': '#2793ec',
  '#ddedfa': '#2a3642',
  '#6fbbf8': '#4d7aa9',
  '#00f4ff': '#00bdc8',
  '#f1ac4b': '#ffc034',
  '#f5c27a': '#ffae00',
  '#f9f0e6': '#3b352b',
  '#fecb92': '#fecb92',
  '#e16919': '#f76707',
  '#ea8643': '#f54900',
  '#f8e2d4': '#3b2e27',
  '#f78438': '#9f552d',
  '#ffa500': '#d07a00',
  '#099268': '#099268',
  '#0bad7c': '#087856',
  '#d3e9e3': '#253231',
  '#39a785': '#366a53',
  '#00ffc8': '#009774',
  '#4cb05e': '#40c057',
  '#7ec88c': '#37a44b',
  '#dbf0e0': '#2a3830',
  '#65cb78': '#4e874e',
  '#65f641': '#00a000',
  '#f87777': '#ff8787',
  '#f99a9a': '#ff6666',
  '#f4dadb': '#3c2b2b',
  '#fe9e9e': '#a56767',
  '#ff7fa3': '#db005b',
  '#e03131': '#e03131',
  '#e75f5f': '#c31d1d',
  '#e55959': '#8f3734',
  '#ff636e': '#de002c',
  '#f5f5f5': '#f5f5f5',
  '#f9f9f9': '#f9f9f9',
}

/** Lobby's own light → dark colours (they win over tldraw's where both name one). */
function lobbyDarkTable(): Map<string, string> {
  const m = new Map<string, string>(Object.entries(TLDRAW_DARK))
  // the note palette's designed dark fills; "Paper" (white) see the header
  for (const s of NOTE_PALETTE) m.set(s.light.fill.toLowerCase(), s.dark.fill.toLowerCase())
  m.set('#ffffff', PAPER_DARK)
  // inks: Lobby's, the engine's default (every note label made on this canvas), tldraw's black, Lobby's grey
  m.set(INK, CHALK)
  m.set('#1e1e1e', CHALK)
  m.set('#000000', CHALK)
  m.set(GREY_INK.light.toLowerCase(), GREY_INK.dark.toLowerCase())
  // tldraw's semi fill (its light canvas colour) is its dark `solid`
  m.set('#fcfffe', '#010403')
  // the canvas and the frames
  m.set(CANVAS_LIGHT, CANVAS_DARK)
  m.set(FRAME_OUTLINE_LIGHT, FRAME_OUTLINE_DARK)
  return m
}

const TABLE = lobbyDarkTable()

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** `#rgb` / `#rrggbb` / `#rrggbbaa` as `#rrggbb` (lowercase) and the alpha suffix, or null. */
function normalizeHex(color: string): { rgb: string; alpha: string } | null {
  const m = HEX.exec(color.trim())
  if (!m) return null
  let h = (m[1] as string).toLowerCase()
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  return { rgb: `#${h.slice(0, 6)}`, alpha: h.slice(6) }
}

/** A grey (r, g and b within 10 of each other): drawn through Excalidraw's own dark filter. */
function isNeutral(rgb: string): boolean {
  const n = Number.parseInt(rgb.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return Math.max(r, g, b) - Math.min(r, g, b) <= 10
}

/**
 * The colour Lobby draws in dark mode for a stored (light) colour, or null to let Excalidraw's own filter
 * decide (neutral greys, and anything that is not a hex colour: `transparent`, names).
 */
export function lobbyDarkColor(color: string): string | null {
  const hex = normalizeHex(color)
  if (!hex) return null
  const mapped = TABLE.get(hex.rgb)
  if (mapped) return mapped + hex.alpha
  if (isNeutral(hex.rgb)) return null
  // any other explicit colour is drawn as it is (a brand colour, a picked one)
  return color
}

let installed = false

/**
 * Installs Lobby's look into the engine's module state, once: FRAME_STYLE's name colours and outline, and
 * Lobby's answers in front of the dark-mode colour cache. Returns whether the dark-mode hook is on (it is
 * off when the engine's cache could not be found: dark mode is then Excalidraw's own).
 */
export function installLobbyEngineTheme(): boolean {
  const style = FRAME_STYLE as {
    nameColorLightTheme: string
    nameColorDarkTheme: string
    strokeColor: string
  }
  style.nameColorLightTheme = INK
  style.nameColorDarkTheme = FRAME_NAME_DARK
  style.strokeColor = FRAME_OUTLINE_LIGHT
  if (installed) return true
  // the cache is the Map the filter stores a fresh colour in: catch it on one probe call
  const probe = `#${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`
  let cache: Map<string, string> | null = null
  const set = Map.prototype.set
  Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
    if (k === probe && cache === null) cache = this as Map<string, string>
    return set.call(this, k, v)
  }
  try {
    applyDarkModeFilter(probe, true)
  } finally {
    Map.prototype.set = set
  }
  const found = cache as Map<string, string> | null
  if (!found) return false
  const get = Map.prototype.get
  found.get = (k: string) => (typeof k === 'string' ? lobbyDarkColor(k) : null) ?? get.call(found, k)
  installed = true
  return true
}
