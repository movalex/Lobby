// How topics and their lines look on the new canvas (pure constants). The same design as ../style.ts
// (tldraw palette names: an orange central topic, one palette colour per first-level branch, deeper topics
// in their branch's colour on a plain fill), written as the literal light-mode values Excalidraw stores,
// exactly as the converter writes a tldraw geo topic and its elbow line (packages/tldraw-import/src/
// convert.ts: stroke = the colour's `solid`, a 'solid' fill = its `semi` tint, a 'semi' fill = the near-white
// card fill, stroke width and label size by tldraw size s/m/l), so a new map and a converted one look alike.
// The canvas's own dark filter darkens them (§4.2 "Dark mode").

import {
  isLobbyColorName,
  LOBBY_PALETTE,
  LOBBY_SEMI_FILL,
  type LobbyColorName,
  noteColorName,
  strokeColorName,
} from '@draftroom/board-ops/elements'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { BRANCH_COLORS, nextBranchColor, ROOT_COLOR } from '../style.ts'

export { BRANCH_COLORS, NEW_ROOT_TEXT, nextBranchColor, ROOT_COLOR } from '../style.ts'

/** Lobby's label ink (tldraw's 'black' label colour, as the converter stores it). */
export const LABEL_INK = LOBBY_PALETTE.black.solid
/** Lobby's sans font (Excalidraw font family id; the converter's `sans`). */
export const TOPIC_FONT_FAMILY = 6

/** tldraw sizes as the converter maps them (convert.ts STROKE and LABEL). */
const STROKE = { s: 2, m: 3.5, l: 5 } as const
const LABEL = { s: 18, m: 22, l: 26 } as const

export interface TopicLevelStyle {
  strokeWidth: number
  /** 'solid' (the colour's tint) or 'semi' (the near-white card fill), as in ../style.ts */
  fill: 'solid' | 'semi'
  fontSize: number
  /** width range and minimum height; the width follows the text between the two */
  minW: number
  maxW: number
  minH: number
}

export function levelStyle(depth: number): TopicLevelStyle {
  if (depth <= 0)
    return { strokeWidth: STROKE.l, fill: 'solid', fontSize: LABEL.l, minW: 200, maxW: 360, minH: 84 }
  if (depth === 1)
    return { strokeWidth: STROKE.m, fill: 'solid', fontSize: LABEL.m, minW: 150, maxW: 300, minH: 64 }
  return { strokeWidth: STROKE.s, fill: 'semi', fontSize: LABEL.s, minW: 120, maxW: 280, minH: 56 }
}

/** The element fields of a topic of `color` at `depth` (a rectangle's stroke and fill). */
export function topicColors(
  color: LobbyColorName,
  depth: number,
): { strokeColor: string; backgroundColor: string } {
  const c = LOBBY_PALETTE[color]
  const st = levelStyle(depth)
  return { strokeColor: c.solid, backgroundColor: st.fill === 'solid' ? c.semi : LOBBY_SEMI_FILL }
}

/** Line thickness from a parent to a child at `depth` (tldraw 'm' for first-level lines, else 's'). */
export const edgeStrokeWidth = (depth: number) => (depth <= 1 ? STROKE.m : STROKE.s)

/** The line colour for a child of `color` (its `solid`). */
export const edgeStrokeColor = (color: LobbyColorName) => LOBBY_PALETTE[color].solid

const PALETTE_NAMES: ReadonlySet<string> = new Set([...BRANCH_COLORS, ROOT_COLOR, 'black', 'white'])

/**
 * The palette colour an element shows, or null (a colour that is not one of the map's): a sticky note by
 * its fill, anything else by its stroke. The port of ../runtime.ts `colorOf` (tldraw's `props.color`).
 */
export function colorNameOf(el: CanvasElement | undefined): LobbyColorName | null {
  if (!el) return null
  const e = el as { strokeColor?: string; backgroundColor?: string }
  const name = el.type === 'stickynote' ? noteColorName(e.backgroundColor) : strokeColorName(e.strokeColor)
  return name && PALETTE_NAMES.has(name) && isLobbyColorName(name) ? name : null
}

/** The colour of a new topic at `depth` under `parent` (../runtime.ts `colorForNew`). */
export function colorForNew(
  depth: number,
  parentColor: LobbyColorName | null,
  firstLevelColors: readonly string[],
): LobbyColorName {
  if (depth > 1) return parentColor && parentColor !== ROOT_COLOR ? parentColor : 'blue'
  return nextBranchColor(firstLevelColors) as LobbyColorName
}
