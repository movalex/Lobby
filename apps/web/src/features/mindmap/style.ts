// How topics and their lines look (pure constants). Every colour is one of Lobby's 13 palette names
// (board-ops/elements LOBBY_COLOR_NAMES, tldraw's colour-style names kept on the new canvas), so the
// board's light and dark themes (and exports in either) resolve them; nothing here is a raw colour.
//  - Central topic: orange (Dark Burn Creative's colour), tinted fill, large.
//  - First-level branches: one palette colour each (never orange), tinted fill, medium.
//  - Deeper topics: their branch's colour as the outline on a plain fill, small.
// Labels stay 'black', which is dark on light boards and light on dark boards.

import type { LobbyColorName } from '@draftroom/board-ops/elements'

type TLDefaultColorStyle = LobbyColorName
type TLDefaultSizeStyle = 's' | 'm' | 'l' | 'xl'
type TLDefaultFillStyle = 'none' | 'semi' | 'solid' | 'pattern' | 'fill'

export const ROOT_COLOR: TLDefaultColorStyle = 'orange'

/** First-level branch colours, in the order new branches take them. */
export const BRANCH_COLORS: readonly TLDefaultColorStyle[] = [
  'blue',
  'green',
  'violet',
  'light-blue',
  'red',
  'light-green',
  'light-violet',
  'yellow',
  'light-red',
  'grey',
]

export interface TopicLevelStyle {
  size: TLDefaultSizeStyle
  fill: TLDefaultFillStyle
  /** Unscaled width range and minimum height; the width follows the text between the two. */
  minW: number
  maxW: number
  minH: number
}

export function levelStyle(depth: number): TopicLevelStyle {
  if (depth <= 0) return { size: 'l', fill: 'solid', minW: 200, maxW: 360, minH: 84 }
  if (depth === 1) return { size: 'm', fill: 'solid', minW: 150, maxW: 300, minH: 64 }
  return { size: 's', fill: 'semi', minW: 120, maxW: 280, minH: 56 }
}

/** The colour the n-th first-level branch gets (0-based), cycling through BRANCH_COLORS. */
export function branchColor(n: number): TLDefaultColorStyle {
  const i = ((n % BRANCH_COLORS.length) + BRANCH_COLORS.length) % BRANCH_COLORS.length
  return BRANCH_COLORS[i] as TLDefaultColorStyle
}

/**
 * The next branch colour for a root that already has branches in `used` colours: the first palette
 * colour not in use, else by count.
 */
export function nextBranchColor(used: readonly string[]): TLDefaultColorStyle {
  const free = BRANCH_COLORS.find((c) => !used.includes(c))
  return free ?? branchColor(used.length)
}

/** Line thickness from a parent to a child at `depth`. */
export function edgeSize(depth: number): TLDefaultSizeStyle {
  return depth <= 1 ? 'm' : 's'
}

/** What a new central topic says until it is renamed (selected, so typing replaces it). */
export const NEW_ROOT_TEXT = 'Central topic'
