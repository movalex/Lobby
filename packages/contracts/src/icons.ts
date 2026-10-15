// The Elements panel's built-in icons (wave Q; OWNER: WS1 after the wave Q foundation; docs/WAVE-Q-CONTRACTS.md §3).
//
// Two pinned sets (packages/icon-sets: lucide-static 1.49.0, ISC; @tabler/icons 3.48.0 outline, MIT) are converted at
// build time into line, ellipse and rectangle primitives on the sets' 24-unit grid, and served same-origin as static,
// content-hashed files under ICON_ASSET_PREFIX (WS1's Vite plugin; a missing file is a 404, never index.html):
//
//   index.<hash>.json      IconIndex: every icon's set, name, tags, category and shard (searched client-side;
//                          loaded the first time the Icons tab opens)
//   shard-<n>.<hash>.json  IconShard: the geometry of the icons of shard n (fetched when a result in it scrolls into
//                          view or is inserted)
//
// The web learns the index file's hashed name at build time (WS1's plugin), never from a fixed name. Nothing here is
// in the board's main chunk, and no icon is ever an image element: an inserted icon is native line/ellipse/rectangle
// elements (strokeColor recolours them) with `customData.lobby.kind` ICON_ELEMENT_KIND and `alt` iconAltText(…), one
// fresh group around them. A favourite or recent icon is the mark key `icon:<set>:<name>@<setVersion>`
// (./library.ts libraryMarkKey); a key whose version is not the current set's is hidden.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

export const ICON_SET_IDS = ['lucide', 'tabler'] as const
export const IconSetId = z.enum(ICON_SET_IDS)
export type IconSetId = z.infer<typeof IconSetId>

/** The display names (the panel's chips, the alt text, the footer credit). */
export const ICON_SET_NAMES: Readonly<Record<IconSetId, string>> = { lucide: 'Lucide', tabler: 'Tabler' }

/** Same origin; the CSP's default-src 'self' and the e2e network assertion cover it unchanged. */
export const ICON_ASSET_PREFIX = '/lobby-assets/icons/'
/** The licence texts of both sets, linked from the panel's footer. */
export const ICON_LICENSES_PATH = `${ICON_ASSET_PREFIX}LICENSES.txt`
export const ICON_INDEX_FILE_PATTERN = /^index\.[0-9a-f]{8,64}\.json$/
export const ICON_SHARD_FILE_PATTERN = /^shard-(\d{1,3})\.[0-9a-f]{8,64}\.json$/
/** Shards the icons are spread over (by a stable hash of `<set>:<name>`; WS1 picks the hash, the count is fixed). */
export const ICON_SHARD_COUNT = 64
const ICON_SHARD_MAX = ICON_SHARD_COUNT - 1

/** The sets' own grid: every coordinate of an icon is in [ICON_GRID_MIN, ICON_GRID_MAX]. */
export const ICON_GRID = 24
export const ICON_GRID_MIN = -1
export const ICON_GRID_MAX = 25
/** An icon becomes at most this many elements (the guest caps count elements: an icon is 1 to 12 of them). */
export const ICON_MAX_PRIMITIVES = 12
/** Points of one line primitive (canvas-schema MAX_LINEAR_POINTS is 1,000; an icon stays far below it). */
export const ICON_MAX_LINE_POINTS = 400
/** Coordinates carry at most this many decimals (0.01 grid units: invisible at 192 px). */
export const ICON_COORD_DECIMALS = 2

/** An icon name as both sets spell them (lowercase words joined by dashes, digits allowed). */
export const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const ICON_NAME_MAX = 64
/** A set's package version (an exact pin). */
export const ICON_SET_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

export const IconName = z.string().max(ICON_NAME_MAX).regex(ICON_NAME_PATTERN)
const SetVersion = z.string().regex(ICON_SET_VERSION_PATTERN)
const GridCoord = z.number().finite().gte(ICON_GRID_MIN).lte(ICON_GRID_MAX)
const GridSize = z
  .number()
  .finite()
  .gte(0)
  .lte(ICON_GRID_MAX - ICON_GRID_MIN)

/** `customData.lobby.kind` of every element of an inserted icon (create-only; canvas-schema KindValue accepts it). */
export const ICON_ELEMENT_KIND = 'icon'
/** The `alt` of an inserted icon's elements: "Lucide icon: arrow-right". */
export const iconAltText = (set: IconSetId, name: string) => `${ICON_SET_NAMES[set]} icon: ${name}`

// ---- the index ------------------------------------------------------------------------------------------

export const ICON_INDEX_FORMAT = 'lobby-icon-index'
export const ICON_INDEX_VERSION = 1
/** Tags per icon in the index (the sets have up to ~20; the rest add little to search). */
export const ICON_TAGS_MAX = 24
export const ICON_TAG_MAX_CHARS = 48

/** One icon in the index: `[set, name, tags, category, shard]`. category: Tabler's category; null for Lucide. */
export const IconIndexEntry = z.tuple([
  IconSetId,
  IconName,
  z.array(z.string().min(1).max(ICON_TAG_MAX_CHARS)).max(ICON_TAGS_MAX),
  z.string().min(1).max(48).nullable(),
  z.number().int().min(0).max(ICON_SHARD_MAX),
])
export type IconIndexEntry = z.infer<typeof IconIndexEntry>

export const IconSetInfo = z.strictObject({
  id: IconSetId,
  /** the pinned package's version (the mark keys carry it) */
  version: SetVersion,
  licence: z.enum(['ISC', 'MIT']),
  count: z.number().int().nonnegative(),
})
export type IconSetInfo = z.infer<typeof IconSetInfo>

export const IconIndex = z.strictObject({
  format: z.literal(ICON_INDEX_FORMAT),
  version: z.literal(ICON_INDEX_VERSION),
  sets: z.array(IconSetInfo).min(1).max(ICON_SET_IDS.length),
  /** the shard file names in shard order (`shards[n]` is shard n), relative to ICON_ASSET_PREFIX */
  shards: z.array(z.string().regex(ICON_SHARD_FILE_PATTERN)).length(ICON_SHARD_COUNT),
  /** sorted by set, then name; a (set, name) pair is listed once */
  icons: z.array(IconIndexEntry),
})
export type IconIndex = z.infer<typeof IconIndex>

// ---- a shard --------------------------------------------------------------------------------------------

export const ICON_SHARD_FORMAT = 'lobby-icon-shard'
export const ICON_SHARD_VERSION = 1

/**
 * One primitive on the 24-unit grid, drawn with the icon's stroke (and filled with it when `f`):
 *  - `line`: an open or closed polyline, `p` = flat `[x0, y0, x1, y1, …]` (arcs and Béziers flattened; a closed
 *    line does not repeat its first point; `f` only with `closed`);
 *  - `ellipse`: its bounding box (a circle is an ellipse with w = h);
 *  - `rect`: its box and corner radius `r` (0 = square corners).
 */
export const IconPrimitive = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('line'),
    p: z
      .array(GridCoord)
      .min(4)
      .max(ICON_MAX_LINE_POINTS * 2)
      .refine((p) => p.length % 2 === 0, 'p holds x, y pairs'),
    closed: z.literal(true).optional(),
    /** filled with the stroke's colour (a closed line only: Tabler's filled dots, squares and stacks; WS1) */
    f: z.literal(true).optional(),
  }),
  z.strictObject({
    t: z.literal('ellipse'),
    x: GridCoord,
    y: GridCoord,
    w: GridSize,
    h: GridSize,
    f: z.literal(true).optional(),
  }),
  z.strictObject({
    t: z.literal('rect'),
    x: GridCoord,
    y: GridCoord,
    w: GridSize,
    h: GridSize,
    r: z.number().finite().gte(0).lte(12).optional(),
    f: z.literal(true).optional(),
  }),
])
export type IconPrimitive = z.infer<typeof IconPrimitive>

/** An icon's geometry: its primitives, in the source's drawing order. */
export const IconGeometry = z.array(IconPrimitive).min(1).max(ICON_MAX_PRIMITIVES)
export type IconGeometry = z.infer<typeof IconGeometry>

/** The key of an icon in a shard and in a drag payload: `<set>:<name>`. */
export const iconKey = (set: IconSetId, name: string) => `${set}:${name}`
export const ICON_KEY_PATTERN = /^(lucide|tabler):([a-z0-9]+(?:-[a-z0-9]+)*)$/

/** `{set, name}` of an icon key, or null. */
export function parseIconKey(key: unknown): { set: IconSetId; name: string } | null {
  if (typeof key !== 'string' || key.length > 7 + ICON_NAME_MAX) return null
  const m = ICON_KEY_PATTERN.exec(key)
  if (!m?.[1] || !m[2]) return null
  return { set: m[1] as IconSetId, name: m[2] }
}

export const IconShard = z.strictObject({
  format: z.literal(ICON_SHARD_FORMAT),
  version: z.literal(ICON_SHARD_VERSION),
  shard: z.number().int().min(0).max(ICON_SHARD_MAX),
  icons: z.record(z.string().regex(ICON_KEY_PATTERN), IconGeometry),
})
export type IconShard = z.infer<typeof IconShard>

// ---- insert sizes -----------------------------------------------------------------------------------------

/**
 * The insert size presets (the panel's S / M / L): the icon's box in scene px, and the stroke width that keeps the
 * sets' 2-unit stroke on the 24 grid (Excalidraw does not scale strokeWidth on resize, so a resized icon keeps it).
 */
export const ICON_SIZES = ['S', 'M', 'L'] as const
export const IconSize = z.enum(ICON_SIZES)
export type IconSize = z.infer<typeof IconSize>
export interface IconSizePreset {
  readonly px: number
  readonly strokeWidth: number
}
export const ICON_SIZE_PRESETS: Readonly<Record<IconSize, IconSizePreset>> = {
  S: { px: 48, strokeWidth: 4 },
  M: { px: 96, strokeWidth: 8 },
  L: { px: 192, strokeWidth: 16 },
}
