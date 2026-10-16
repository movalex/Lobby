/**
 * Miro's font families (REST API v2 `style.fontFamily`) on Lobby's four faces (canvas-schema LOBBY_FONT_FAMILIES):
 * monospace → Comic Shanns (8), handwriting → Excalifont (5), display faces → Lilita One (7), everything else →
 * Nunito (6). A serif face has no Lobby counterpart: it becomes Nunito and is reported (`font-substituted`), as is a
 * family Lobby does not know. Pure.
 */
import type { LobbyFontFamily } from '@draftroom/canvas-schema/engine'

const MONO = new Set(['roboto_mono', 'plex_mono', 'ibm_plex_mono', 'courier_new', 'source_code_pro'])
const DRAW = new Set(['caveat', 'permanent_marker', 'lemon_tuesday', 'spoof', 'shadows_into_light'])
const DISPLAY = new Set([
  'bangers',
  'abril_fatface',
  'titan_one',
  'rammetto_one',
  'gravitas_one',
  'fredoka_one',
  'graduate',
  'nixie_one',
])
const SANS = new Set([
  'arial',
  'open_sans',
  'roboto',
  'roboto_condensed',
  'noto_sans',
  'pt_sans',
  'pt_sans_narrow',
  'plex_sans',
  'ibm_plex_sans',
  'formular',
  'helvetica',
])
const SERIF = new Set([
  'georgia',
  'times_new_roman',
  'eb_garamond',
  'pt_serif',
  'roboto_slab',
  'plex_serif',
  'ibm_plex_serif',
  'tiempos_text',
  'noto_serif',
])

export function fontOf(family: unknown): { family: LobbyFontFamily; substituted: boolean } {
  const f = typeof family === 'string' ? family.trim().toLowerCase() : ''
  if (MONO.has(f)) return { family: 8, substituted: false }
  if (DRAW.has(f)) return { family: 5, substituted: false }
  if (DISPLAY.has(f)) return { family: 7, substituted: false }
  if (SANS.has(f) || f === '') return { family: 6, substituted: false }
  return { family: 6, substituted: SERIF.has(f) || f.length > 0 }
}
