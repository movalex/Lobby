// FROZEN FIXTURE, never edit. This is
//   packages/contracts/src/tags.ts
// of commit 6769e07 (the web deployed on staging since wave S: CONTRACTS_REV 13), as
// `git show 6769e07:<that path>` gives it (blob cbf38a3a0298). The deployed web parses every server
// frame with these schemas (its socket transport, apps/web/src/canvas/sync/transport/socket.ts at that
// commit: `ServerMessage.safeParse` on each text frame, the gzip snapshot through `decodeSnapshotFrame`),
// so the stale-pair tests parse the room's frames with them (docs/EXCALIDRAW-CONTRACTS.md §0b, the
// per-reader downgrade rule). Changed from the commit:
// these header lines only.
// Tags on notes and file cards (docs/WAVE4-CONTRACTS.md §2 tags). Browser-safe. Owned by the tags owner.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// Tags are canvas data: they live in tldraw record meta and travel through the board's own sync, so
// there is no API route and no migration. The format below is the contract for every reader (the web
// app today; a server-side indexer later).
//
// Storage: ONE META KEY PER TAG.
//   shape meta     `drTags:<key>`    = { name, color }   on notes and file cards (at most 10 are read)
//   document meta  `drTagList:<key>` = { name, color }   the board's tag list (at most 200 are read)
// `<key>` is tagKey(name). A board-level entry decides how a tag looks everywhere on the board; the copy
// on each shape keeps the shape self-contained (pasted to another board, or while an entry is missing).
//
// Why not one `meta.drTags` object: @tldraw/sync-core 5.4.2 diffs a record's meta one level deep
// (diff.ts diffRecord → diffObject with nestedKeys {props, meta}); any object below that is sent whole
// (a `put`). A map in a single meta key is therefore last-writer-wins as a whole: two people tagging the
// same note, or an offline editor reconnecting, would silently drop each other's tags, and one new tag
// would rewrite the whole board list. With one key per tag every add and remove is its own `put` or
// `delete` op, so concurrent changes to different tags merge, and per-property undo
// (apps/web/src/sync-quality/perPropUndo.ts, meta.* granularity) reverts exactly the tags it changed.
//
// Everything is validated on read (never trusted): a value whose name does not normalize to itself,
// whose key is not tagKey(name), or whose color is not one of TAG_COLORS is ignored.

/** Shape meta key prefix: `drTags:<key>`. */
export const SHAPE_TAG_PREFIX = 'drTags:'
/** Document meta key prefix: `drTagList:<key>`. */
export const BOARD_TAG_PREFIX = 'drTagList:'

export const MAX_TAGS_PER_SHAPE = 10
export const MAX_TAGS_PER_BOARD = 200
export const TAG_NAME_MAX_CHARS = 24

/**
 * The note palette's colour names (tldraw colour-style values; Lobby's own swatches are applied to them
 * in apps/web/src/features/canvas-ux/palette.ts). A tag takes one of these.
 */
export const TAG_COLORS = [
  'black',
  'grey',
  'light-violet',
  'violet',
  'blue',
  'light-blue',
  'yellow',
  'orange',
  'green',
  'light-green',
  'light-red',
  'red',
  'white',
] as const
export type TagColor = (typeof TAG_COLORS)[number]

/** The order new tags take colours in: distinct hues first, the near-neutrals last. */
export const TAG_COLOR_ROTATION: readonly TagColor[] = [
  'blue',
  'green',
  'orange',
  'violet',
  'red',
  'light-blue',
  'yellow',
  'light-green',
  'light-violet',
  'light-red',
  'grey',
  'black',
  'white',
]

export interface TagValue {
  name: string
  color: TagColor
}
export interface TagDef extends TagValue {
  key: string
}

const TAG_COLOR_SET: ReadonlySet<string> = new Set(TAG_COLORS)
export const isTagColor = (v: unknown): v is TagColor => typeof v === 'string' && TAG_COLOR_SET.has(v)

// Invisible characters that only confuse a label: the Arabic letter mark, zero-width space, the LRM/RLM
// marks, bidi embeddings/overrides and isolates, and the BOM. Zero-width (non-)joiners stay: emoji
// sequences need them. (Code points, so the source stays plain ASCII.)
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
]
const isInvisible = (cp: number) => INVISIBLE.some(([from, to]) => cp >= from && cp <= to)
const CONTROLS = /\p{Cc}/gu

/**
 * What a typed tag name becomes: NFC, whitespace runs (line breaks and tabs included) collapsed to one
 * space, no other control or invisible bidi characters, trimmed, without leading `#` (people type
 * "#research"). May return '' or something too long: see tagNameError.
 */
export function normalizeTagName(input: string): string {
  let out = ''
  for (const ch of input.normalize('NFC').replace(/\s+/gu, ' ').replace(CONTROLS, '')) {
    if (!isInvisible(ch.codePointAt(0) ?? 0)) out += ch
  }
  return out
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/^#+\s*/u, '')
    .trim()
}

/** Characters as people count them closely enough for a 24-character cap (code points). */
export const tagNameLength = (name: string) => [...name].length

/** Why a (normalized) name cannot be a tag, or null when it can. */
export function tagNameError(name: string): string | null {
  if (!name) return 'Type a name for the tag.'
  if (tagNameLength(name) > TAG_NAME_MAX_CHARS)
    return `Tag names are at most ${TAG_NAME_MAX_CHARS} characters.`
  return null
}

/**
 * The identity of a tag: the normalized name, compatibility-folded (NFKC), lowercased, whitespace as
 * `-`. "Research", "research" and "  #RESEARCH " are one tag; "User research" and "user-research" too.
 * Never contains whitespace (so it can sit in a space-separated attribute).
 */
export function tagKey(name: string): string {
  return normalizeTagName(name).normalize('NFKC').toLowerCase().replace(/\s+/gu, '-')
}

/** A stored `{ name, color }` under `key`, or null when it is not a valid tag. */
export function parseTagValue(key: string, value: unknown): TagDef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { name, color } = value as Record<string, unknown>
  if (typeof name !== 'string' || !isTagColor(color)) return null
  if (normalizeTagName(name) !== name || tagNameError(name) !== null) return null
  if (!key || tagKey(name) !== key) return null
  return { key, name, color }
}

function parseTagEntries(meta: unknown, prefix: string, max: number): TagDef[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
  const out: TagDef[] = []
  for (const [metaKey, value] of Object.entries(meta)) {
    if (!metaKey.startsWith(prefix)) continue
    const tag = parseTagValue(metaKey.slice(prefix.length), value)
    if (tag) out.push(tag)
  }
  // Over the cap (only a forged or concurrently raced record gets there): the same subset for everyone.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out.length > max ? out.slice(0, max) : out
}

/** The tags stored on a shape's meta (valid ones only, at most MAX_TAGS_PER_SHAPE, in key order). */
export const parseShapeTags = (meta: unknown): TagDef[] =>
  parseTagEntries(meta, SHAPE_TAG_PREFIX, MAX_TAGS_PER_SHAPE)

/** The board's tag list from the document record's meta (at most MAX_TAGS_PER_BOARD, in key order). */
export const parseBoardTags = (meta: unknown): TagDef[] =>
  parseTagEntries(meta, BOARD_TAG_PREFIX, MAX_TAGS_PER_BOARD)

export const shapeTagMetaKey = (key: string) => `${SHAPE_TAG_PREFIX}${key}`
export const boardTagMetaKey = (key: string) => `${BOARD_TAG_PREFIX}${key}`

/** Whether a meta key holds a shape tag (valid or not), e.g. to strip all of them. */
export const isShapeTagMetaKey = (metaKey: string) => metaKey.startsWith(SHAPE_TAG_PREFIX)
