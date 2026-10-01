// The face of a comment marker (pin) on both board pages: the author's colour, faded for a thread you have
// read, and the colour of the initials on it. White initials on a faded face were 3.3 to 4.5:1 for the
// presence palette (the early wave-5 review, W5-49), so the initials are white where white reaches 4.5:1
// and black otherwise: one of the two always reaches it (at least 4.58:1 on any colour).
import { contrastRatio } from '../../theme/contrast.ts'
import type { PinState } from './model.ts'

/** How much of the author's colour a read thread's face keeps (the rest is the marker's white). */
export const READ_FACE_SHARE = 0.78
/** The contrast the initials keep (WCAG AA for small text: they are 10.5 px). */
export const PIN_INK_MIN_CONTRAST = 4.5

const WHITE = '#ffffff'
const BLACK = '#000000'
/** A resolved thread's face (the check mark on it is white). */
const RESOLVED_FACE = '#5f6b7a'

export interface PinFace {
  /** the face's fill, opaque #rrggbb */
  readonly background: string
  /** the initials' colour, #rrggbb */
  readonly ink: string
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` as opaque `#rrggbb` (the alpha is dropped); null otherwise. */
export function opaqueHex(color: string): string | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(color.trim())
  if (!m) return null
  const h = (m[1] as string).toLowerCase()
  if (h.length === 3 || h.length === 4) return `#${[...h.slice(0, 3)].map((c) => c + c).join('')}`
  if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`
  return null
}

/** `color` at `share` over white (what an opacity of `share` on a white marker shows), as #rrggbb. */
export function overWhite(color: string, share: number): string {
  const hex = opaqueHex(color) ?? WHITE
  const n = Number.parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c * share + 255 * (1 - share))
  const out = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix)
  return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** White on `background` when that reaches 4.5:1, else black (which then does). */
export function inkOn(background: string): string {
  const bg = opaqueHex(background) ?? WHITE
  if (contrastRatio(bg, WHITE) >= PIN_INK_MIN_CONTRAST) return WHITE
  return contrastRatio(bg, BLACK) >= contrastRatio(bg, WHITE) ? BLACK : WHITE
}

/** The face of a marker by `authorColor` (a safe #hex colour) in `state`. */
export function pinFace(authorColor: string, state: PinState): PinFace {
  if (state === 'resolved') return { background: RESOLVED_FACE, ink: WHITE }
  const full = opaqueHex(authorColor) ?? WHITE
  const background = state === 'read' ? overWhite(full, READ_FACE_SHARE) : full
  return { background, ink: inkOn(background) }
}

/** The face's style: the custom properties comments.css reads (`.dr-cpin__face`). */
export function pinFaceStyle(
  authorColor: string,
  state: PinState,
): Record<'--dr-cpin-color' | '--dr-cpin-ink', string> {
  const face = pinFace(authorColor, state)
  return { '--dr-cpin-color': face.background, '--dr-cpin-ink': face.ink }
}
