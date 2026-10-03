/**
 * The board document, `lb_doc` (docs/EXCALIDRAW-MIGRATION.md §3.4, D11): per-key last writer wins,
 * under the same clock as elements, validated per key. A push carries `doc: {set: {key: value | null}}`
 * (null removes the key); `changes` carry the same shape. Frozen at the spike B contracts step C0.
 *
 * Pure: zod and `@draftroom/contracts` (browser-safe), no engine code.
 */
import { parseTagValue } from '@draftroom/contracts'
import { z } from 'zod'
import { ELEMENT_ID_PATTERN, MAX_TAG_DEFS } from './limits.ts'

export const TAG_DEF_KEY_PREFIX = 'tagDef:'

/** Who may write a key (the server enforces it; `server` = never a client). */
export type DocWriter = 'owner' | 'facilitator' | 'editor' | 'server'

const Coord = z.number().finite()

/** `startView`: the board's start view (today's `document.meta.drStartView`, `pageId` dropped). */
export const StartViewValue = z.strictObject({
  x: Coord,
  y: Coord,
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
  frameId: z.string().regex(ELEMENT_ID_PATTERN).optional(),
})
/** `workshop`: facilitation settings (today's `drWorkshop`). */
export const WorkshopDocValue = z.strictObject({ hideNoteAuthors: z.boolean(), hideCursors: z.boolean() })
/** `tagDef:<tagKey>`: one tag of the board's list (today's `drTagList:<key>`), at most 200. */
export const TagDefValue = z.strictObject({
  name: z.string().min(1).max(100),
  color: z.string().min(1).max(32),
})
/**
 * `import`: written by the server only, at conversion (§5.3): where the board came from, the converter
 * version, the frozen page offsets of pages 2..n (`legacyPages`, reused by every later conversion of this
 * board's records, §5.1) and ids the converter had to change (`legacyIds`), plus lossy-code counts (§5.2).
 */
export const ImportDocValue = z.strictObject({
  from: z.literal('tldraw-5.4.2'),
  converterVersion: z.string().min(1).max(64),
  at: z.number().int().nonnegative(),
  legacyPages: z.record(
    z.string().min(1).max(200),
    z.strictObject({
      dx: Coord,
      dy: Coord,
      index: z.number().int().nonnegative(),
      name: z.string().max(200),
    }),
  ),
  legacyIds: z.record(z.string().min(1).max(250), z.string().regex(ELEMENT_ID_PATTERN)),
  lossy: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), z.number().int().nonnegative()),
})

export interface DocKeySpec {
  readonly match: 'exact' | 'prefix'
  readonly name: string
  readonly value: z.ZodType
  readonly writer: DocWriter
  /**
   * A name-only guest of a writing role may write it too (CR-3D-5). Only the tag list: a workshop guest
   * makes tags as tldraw let it, while `workshop` (the facilitator's) and `startView` stay the members'.
   * The room also caps a guest's tag-list writes (limits.ts GUEST_TAG_DEF_CAP).
   */
  readonly guests?: boolean
}

export const DOC_KEY_SPECS: readonly DocKeySpec[] = [
  { match: 'exact', name: 'startView', value: StartViewValue, writer: 'owner' },
  { match: 'exact', name: 'workshop', value: WorkshopDocValue, writer: 'facilitator' },
  { match: 'prefix', name: TAG_DEF_KEY_PREFIX, value: TagDefValue, writer: 'editor', guests: true },
  { match: 'exact', name: 'import', value: ImportDocValue, writer: 'server' },
]

/** The spec of a doc key, or null (an unknown key is `INVALID`). */
export function docKeySpec(key: string): DocKeySpec | null {
  for (const s of DOC_KEY_SPECS) {
    if (s.match === 'exact' ? key === s.name : key.startsWith(s.name) && key.length > s.name.length) return s
  }
  return null
}

/** Why a client may not set `key` to `value` (null removes), or null when the value is valid. */
export function docValueProblem(key: string, value: unknown): string | null {
  const spec = docKeySpec(key)
  if (!spec) return `unknown doc key ${JSON.stringify(key.slice(0, 64))}`
  if (value === null) return null
  if (!spec.value.safeParse(value).success) return `invalid value for ${spec.name}`
  if (spec.name === TAG_DEF_KEY_PREFIX && parseTagValue(key.slice(TAG_DEF_KEY_PREFIX.length), value) === null)
    return 'tag definition does not match its key'
  return null
}

/**
 * Whether a client role may write `key` (owners write everything but `import`). A name-only guest
 * (`guest`) writes only the keys whose spec allows guests, and only as its role allows.
 */
export function canWriteDocKey(
  key: string,
  role: 'owner' | 'editor' | 'commenter' | 'viewer',
  opts: { readonly guest?: boolean } = {},
): boolean {
  const spec = docKeySpec(key)
  if (!spec || spec.writer === 'server') return false
  if (opts.guest && !spec.guests) return false
  if (role === 'owner') return true
  if (role === 'editor') return spec.writer === 'editor' || spec.writer === 'facilitator'
  return false
}

export const MAX_DOC_TAG_DEFS = MAX_TAG_DEFS

/** A doc write as a push carries it, and as `changes` carry it (null removes the key). */
export const DocSet = z.strictObject({
  set: z.record(z.string().min(1).max(200), z.unknown()),
})
export type DocSet = z.infer<typeof DocSet>
