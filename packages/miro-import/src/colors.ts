/**
 * Miro's colours on Lobby's palette:
 *  - sticky notes: Miro's 16 named note colours (REST API v2 `style.fillColor`, with the light-theme values Miro
 *    draws them in) → the nearest of Lobby's 13 note fills (`@draftroom/board-ops/elements` LOBBY_PALETTE) by
 *    OKLab distance. The table is computed once and frozen in a test; a match further than SUBSTITUTE_DELTA is
 *    reported (`color-substituted`). An unknown name reads as Miro's default (light yellow);
 *  - tags: Miro's 12 tag colours → Lobby's tag colours (contracts tags.ts TAG_COLORS), by hand (a near hue);
 *  - shapes, texts, connectors: Miro's own hex values are kept when they are plain hex (`#rgb`, `#rrggbb`,
 *    `#rrggbbaa`) and pass canvas-schema's isAllowedColor; anything else falls back.
 * Pure.
 */
import { LOBBY_COLOR_NAMES, LOBBY_PALETTE, type LobbyColorName } from '@draftroom/board-ops/elements'
import { isAllowedColor } from '@draftroom/canvas-schema/limits'
import type { TagColor } from '@draftroom/contracts'

/** Miro's sticky note colours (light theme), as the web app draws them. */
export const MIRO_STICKY_COLORS: Readonly<Record<string, string>> = {
  gray: '#f5f6f8',
  light_yellow: '#fff9b1',
  yellow: '#f5d128',
  orange: '#ff9d48',
  light_green: '#d5f692',
  green: '#c9df56',
  dark_green: '#93d275',
  cyan: '#67c6c0',
  light_pink: '#ffcee0',
  pink: '#ea94bb',
  violet: '#be88c7',
  red: '#f16c7f',
  light_blue: '#a6ccf5',
  blue: '#6cd8fa',
  dark_blue: '#9ea9ff',
  black: '#000000',
}
export const MIRO_DEFAULT_STICKY = 'light_yellow'

/** OKLab distance past which a note's colour counts as substituted in the report. */
export const SUBSTITUTE_DELTA = 0.06

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** `#rrggbb` → OKLab [L, a, b]. */
export function oklab(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const r = srgbToLinear(Number.parseInt(h.slice(0, 2), 16))
  const g = srgbToLinear(Number.parseInt(h.slice(2, 4), 16))
  const b = srgbToLinear(Number.parseInt(h.slice(4, 6), 16))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function oklabDistance(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

export interface NoteColor {
  readonly name: LobbyColorName
  readonly fill: string
  readonly distance: number
}

/**
 * Where the nearest fill would mislead: Lobby has no dark note, and Miro's black note (white words on black) is
 * nearest to a red fill by lightness alone; it becomes grey, reported as a substitution.
 */
const OVERRIDES: Readonly<Record<string, LobbyColorName>> = { '#000000': 'grey' }

function nearestNote(hex: string): NoteColor {
  const forced = OVERRIDES[hex]
  if (forced) {
    const fill = LOBBY_PALETTE[forced].noteFill
    return { name: forced, fill, distance: Math.max(oklabDistance(hex, fill), SUBSTITUTE_DELTA + 0.01) }
  }
  let best: NoteColor | null = null
  for (const name of LOBBY_COLOR_NAMES) {
    const fill = LOBBY_PALETTE[name].noteFill
    const distance = oklabDistance(hex, fill)
    if (!best || distance < best.distance) best = { name, fill, distance }
  }
  return best as NoteColor
}

/** Each Miro sticky colour's Lobby note colour (frozen in colors.test.ts). */
export const STICKY_TABLE: Readonly<Record<string, NoteColor>> = Object.freeze(
  Object.fromEntries(Object.entries(MIRO_STICKY_COLORS).map(([name, hex]) => [name, nearestNote(hex)])),
)

/** A sticky note's Lobby colour and whether it is a substitution worth reporting. */
export function stickyColor(fillColor: unknown): { color: NoteColor; substituted: boolean } {
  const key = typeof fillColor === 'string' && fillColor in STICKY_TABLE ? fillColor : MIRO_DEFAULT_STICKY
  const color = STICKY_TABLE[key] as NoteColor
  return { color, substituted: color.distance > SUBSTITUTE_DELTA }
}

/** Miro's tag colours → Lobby's tag colours; `exact: false` is a near hue (reported). */
export const TAG_COLOR_TABLE: Readonly<Record<string, { color: TagColor; exact: boolean }>> = {
  red: { color: 'red', exact: true },
  light_green: { color: 'light-green', exact: true },
  cyan: { color: 'light-blue', exact: false },
  yellow: { color: 'yellow', exact: true },
  magenta: { color: 'light-violet', exact: false },
  green: { color: 'green', exact: true },
  blue: { color: 'blue', exact: true },
  gray: { color: 'grey', exact: true },
  violet: { color: 'violet', exact: true },
  dark_green: { color: 'green', exact: false },
  dark_blue: { color: 'blue', exact: false },
  black: { color: 'black', exact: true },
}

export function tagColor(fillColor: unknown): { color: TagColor; exact: boolean } {
  return (
    (typeof fillColor === 'string' ? TAG_COLOR_TABLE[fillColor] : undefined) ?? {
      color: 'grey',
      exact: false,
    }
  )
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/

/** A Miro hex colour Lobby may store (lower case), or `fallback`. `transparent` stays itself. */
export function hexColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const c = v.trim().toLowerCase()
  if (c === 'transparent') return 'transparent'
  return HEX.test(c) && isAllowedColor(c) ? c : fallback
}

/** An `#rrggbbaa` colour's alpha (0-1), or 1. */
export function hexAlpha(hex: string): number {
  return /^#[0-9a-f]{8}$/.test(hex) ? Number.parseInt(hex.slice(7, 9), 16) / 255 : 1
}

/** `#rrggbbaa` without its alpha (Excalidraw draws the opacity from `opacity`). */
export const withoutAlpha = (hex: string) => (/^#[0-9a-f]{8}$/.test(hex) ? hex.slice(0, 7) : hex)
