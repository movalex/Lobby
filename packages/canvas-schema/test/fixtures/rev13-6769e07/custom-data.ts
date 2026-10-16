// FROZEN FIXTURE, never edit. This is
//   packages/canvas-schema/src/custom-data.ts
// of commit 6769e07 (the web deployed on staging since wave S: CONTRACTS_REV 13), as
// `git show 6769e07:<that path>` gives it (blob 557d7122a4a0). The deployed web parses every server
// frame with these schemas (its socket transport, apps/web/src/canvas/sync/transport/socket.ts at that
// commit: `ServerMessage.safeParse` on each text frame, the gzip snapshot through `decodeSnapshotFrame`),
// so the stale-pair tests parse the room's frames with them (docs/EXCALIDRAW-CONTRACTS.md §0b, the
// per-reader downgrade rule). Changed from the commit:
// these header lines, and its `@draftroom/contracts` import, which reads the frozen copies
// beside it (contracts-mindmap.ts, contracts-tags.ts).
/**
 * The `customData` key registry (docs/EXCALIDRAW-MIGRATION.md §3.3), frozen at the spike B contracts
 * step C0. Only two top-level keys exist: `lobby` (client-writable, per key, by class) and `lobbyServer`
 * (server-owned). Every `customData.lobby` key has a spec here: its class, its value schema, its size and
 * what `onDuplicate` does with it. A key with no spec is `INVALID`.
 *
 * The CLASS rules (who may write a key, and when) are enforced by the server (`apps/sync/src/room/
 * custom-data.ts`, O1); this file only says which class a key is in and what a valid value looks like.
 *
 * Pure: zod and `@draftroom/contracts` (browser-safe), no engine code.
 */
import { z } from 'zod'
import { MINDMAP_SIDES } from './contracts-mindmap.ts'
import { parseTagValue } from './contracts-tags.ts'
import {
  ASSET_ID_PATTERN,
  ELEMENT_ID_PATTERN,
  jsonByteLength,
  MAX_ALT_CHARS,
  MAX_FILE_NAME_CHARS,
  MAX_LOBBY_CUSTOM_DATA_BYTES,
  MAX_TAGS_PER_ELEMENT,
  MAX_UID_CHARS,
  PLUS_ONES_BUDGET_BYTES,
  PLUS_ONES_MAX,
  REACTIONS_BUDGET_BYTES,
  REACTIONS_MAX,
  VERSION_ID_PATTERN,
} from './limits.ts'
import { parseReactionKey, REACTION_KEY_PREFIX } from './reactions.ts'

/** The two top-level `customData` keys (§3.3). Anything else is `INVALID`. */
export const CUSTOM_DATA_KEYS = ['lobby', 'lobbyServer'] as const

/**
 * The five classes (§3.3):
 * 1. `server-owned` — `customData.lobbyServer`; only the server writes it; a client value is replaced by the stored one.
 * 2. `create-only` — accepted only in the op that creates the element; `by` must equal the writer's uid
 *    (stamped if absent); later changes are `INVALID`; removal allowed for the `by` user or an owner.
 * 3. `identity-bound` — `plusOne:<uid>`: add or remove only where `<uid>` is the writer's uid; an addition
 *    while a dot vote is open is `VOTE_OPEN`. `react:<code>:<uid>` (wave N, CONTRACTS_REV 13; reactions.ts):
 *    the same owner rule (`identityUidOf`), on sticky notes only, never VOTE_OPEN, and an owner may remove
 *    anyone's (the sync's rules, apps/sync/src/room/custom-data.ts).
 * 4. `api-validated` — `file` (canonicalized from the file-refs answer; `versionId` must equal the
 *    version in `fileId`; `name` is client-writable) and `pdfPage` (derived from the `.p<n>` suffix).
 * 5. `free` — zod per key.
 */
export type CustomDataClass = 'server-owned' | 'create-only' | 'identity-bound' | 'api-validated' | 'free'

/**
 * What `onDuplicate` (Ctrl+D, Alt-drag, paste) does with a key (§3.3 "On duplicate / paste"):
 * `keep` it; `strip` it; `relink` the element ids inside it to the copies, or strip it when the copy
 * leaves the tree (`mindmap`, `mindmapEdge`); `strip-index` removes only `present.index`.
 */
export type DuplicateRule = 'keep' | 'strip' | 'relink' | 'strip-index'

export interface LobbyKeySpec {
  /** `exact`: the key is `name`; `prefix`: the key is `name` + a suffix (`tag:<tagKey>`, `plusOne:<uid>`). */
  readonly match: 'exact' | 'prefix'
  readonly name: string
  readonly class: Exclude<CustomDataClass, 'server-owned'>
  /** The value's schema. For `prefix` keys the suffix is checked by `suffix`. */
  readonly value: z.ZodType
  readonly suffix?: (suffix: string, value: unknown) => boolean
  /** UTF-8 JSON bytes of the value. */
  readonly maxBytes: number
  readonly duplicate: DuplicateRule
  /** Whether a LOCKED element still takes this key (see LockExemption); absent: never. */
  readonly lockExempt?: LockExemption
}

/**
 * A `customData.lobby` key a LOCKED element still takes (CR-3F-2, CR-3b-4; §2.4.3 step 5). A lock keeps an
 * element's content and place; these keys are neither:
 * - `own`: the writer's own identity-bound key only (`plusOne:<uid>` where `<uid>` is the writer): a
 *   participant's +1 on a facilitator's locked template note. Another uid's key stays LOCKED;
 * - `frame-account`: on a frame, from an account only (`present`): the facilitator orders and skips locked
 *   slides. A name-only guest can neither lock nor unlock (§3.5), so a locked frame's place is not theirs.
 * Every other key, and every group but `z` and a lone `meta.locked`, stays LOCKED. The server decides
 * (apps/sync/src/room/custom-data.ts lockExemptKey); the client only offers what the server takes.
 */
export type LockExemption = 'own' | 'frame-account'

const Uid = z.string().min(1).max(MAX_UID_CHARS)
const ElementRef = z.string().regex(ELEMENT_ID_PATTERN)
const Session = z.string().min(1).max(200)

/** `tag:<tagKey>` → `{name, color}` exactly as today's tag contract validates it (`parseTagValue`). */
const TagValue = z.strictObject({ name: z.string().min(1).max(100), color: z.string().min(1).max(32) })
/**
 * `plusOne:<uid>` → `true`. The value is kept this short on purpose: §3.5's +1 budget (16 KiB) must hold
 * 200 keys of 60-character uids (about 76 B each with `true`; an epoch-ms value would make it 85 B, 17 KB).
 * The order of +1s is therefore not stored; readers order them by uid.
 */
const PlusOneValue = z.literal(true)
/**
 * `react:<code>:<uid>` → `true` (wave N; reactions.ts), as short as a +1 for the same reason: REACTIONS_MAX keys
 * must fit REACTIONS_BUDGET_BYTES.
 */
const ReactionValue = z.literal(true)
/** `file`: the card's stable facts (§2.10.4); live facts come from the api at runtime, never from here. */
export const FileValue = z.strictObject({
  assetId: z.string().regex(ASSET_ID_PATTERN),
  versionId: z.string().regex(VERSION_ID_PATTERN),
  kind: z.enum(['image', 'pdf', 'video', 'other']),
  name: z.string().max(MAX_FILE_NAME_CHARS),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
})
export type FileValue = z.infer<typeof FileValue>
/** `pdfPage`: the page of a placed PDF page (derived from `fileId`'s `.p<n>`). */
const PdfPageValue = z.number().int().min(1).max(9_999)
/**
 * `kind`: what Lobby made an element as, when its type alone does not say (`highlight` for a
 * highlighter `freedraw`, §3.1). A short lowercase word; the converter may add kinds.
 */
const KindValue = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
/** `ai`: made by an AI run for user `by`. */
const AiValue = z.strictObject({ by: Uid, run: z.string().min(1).max(64).optional() })
/** `privateFrame`: a private-brainstorm frame of session `session`, made by `by`. */
const PrivateFrameValue = z.strictObject({ session: Session, by: Uid })
/** `mindmap`: a topic's place in its map (today's `drMindmap`, with element ids instead of `shape:` refs). */
export const MindmapValue = z.strictObject({
  rootId: ElementRef,
  parentId: ElementRef.nullable(),
  side: z.enum(MINDMAP_SIDES),
  collapsed: z.boolean(),
})
/** `mindmapEdge`: the arrow from `parentId` to `childId` (today's `drMindmapEdge`). */
export const MindmapEdgeValue = z.strictObject({
  rootId: ElementRef,
  parentId: ElementRef,
  childId: ElementRef,
})
/** `alt`: alternative text. */
const AltValue = z.string().max(MAX_ALT_CHARS)
/** The minutes a frame may plan for its section of the run of show (`present.mins`, wave L). */
export const PRESENT_MINS_MIN = 1
export const PRESENT_MINS_MAX = 240
/**
 * `present`: a frame's place in the presentation. `mins` (wave L, L6-4; CONTRACTS_REV 12, protocol.ts
 * PRESENT_MINS_REV): the minutes W5's run of show plans for the frame's section, an integer from 1 to 240.
 * Additive and optional, so ELEMENT_SCHEMA_VERSION is unchanged; it shares the key's lock exemption
 * (`frame-account`) and its duplicate rule (`strip-index` keeps `mins` and `skip` on a copy). A sync older
 * than rev 12 refuses it (strict), so a web writes it only in a rev-12 room.
 */
const PresentValue = z.strictObject({
  index: z.number().int().nonnegative().optional(),
  skip: z.boolean().optional(),
  mins: z.number().int().min(PRESENT_MINS_MIN).max(PRESENT_MINS_MAX).optional(),
})

/** `prompt`, `slot`, `swatch`: a template's marker (a short word such as `image`, `color` or `true`). */
const MarkerValue = z.union([z.boolean(), z.string().min(1).max(64)])

export const TAG_KEY_PREFIX = 'tag:'
export const PLUS_ONE_KEY_PREFIX = 'plusOne:'

/** The registry, for the keys spike B's checks use (§8.6.2). Order does not matter; names are unique. */
export const LOBBY_KEY_SPECS: readonly LobbyKeySpec[] = [
  {
    match: 'prefix',
    name: TAG_KEY_PREFIX,
    class: 'free',
    value: TagValue,
    suffix: (key, value) => key.length <= 100 && !/\s/u.test(key) && parseTagValue(key, value) !== null,
    maxBytes: 256,
    duplicate: 'keep',
  },
  {
    match: 'prefix',
    name: PLUS_ONE_KEY_PREFIX,
    class: 'identity-bound',
    value: PlusOneValue,
    suffix: (uid) => Uid.safeParse(uid).success,
    maxBytes: 32,
    duplicate: 'strip',
    lockExempt: 'own',
  },
  // wave N (LM-10; CONTRACTS_REV 13, protocol.ts REACTIONS_REV and LOBBY_KEY_ADDITIONS): a reader below 13
  // never receives a patch that names one (protocol.ts opForReader), and a writer below 13 never writes one
  {
    match: 'prefix',
    name: REACTION_KEY_PREFIX,
    class: 'identity-bound',
    value: ReactionValue,
    suffix: (suffix) => parseReactionKey(REACTION_KEY_PREFIX + suffix) !== null,
    maxBytes: 32,
    duplicate: 'strip',
    lockExempt: 'own',
  },
  {
    match: 'exact',
    name: 'file',
    class: 'api-validated',
    value: FileValue,
    maxBytes: 1024,
    duplicate: 'keep',
  },
  {
    match: 'exact',
    name: 'pdfPage',
    class: 'api-validated',
    value: PdfPageValue,
    maxBytes: 16,
    duplicate: 'keep',
  },
  { match: 'exact', name: 'kind', class: 'create-only', value: KindValue, maxBytes: 64, duplicate: 'keep' },
  { match: 'exact', name: 'ai', class: 'create-only', value: AiValue, maxBytes: 256, duplicate: 'strip' },
  {
    match: 'exact',
    name: 'privateFrame',
    class: 'create-only',
    value: PrivateFrameValue,
    maxBytes: 512,
    duplicate: 'strip',
  },
  { match: 'exact', name: 'mindmap', class: 'free', value: MindmapValue, maxBytes: 512, duplicate: 'relink' },
  {
    match: 'exact',
    name: 'mindmapEdge',
    class: 'free',
    value: MindmapEdgeValue,
    maxBytes: 512,
    duplicate: 'relink',
  },
  {
    match: 'exact',
    name: 'alt',
    class: 'free',
    value: AltValue,
    maxBytes: 4 * MAX_ALT_CHARS + 8,
    duplicate: 'keep',
  },
  {
    match: 'exact',
    name: 'present',
    class: 'free',
    value: PresentValue,
    maxBytes: 64,
    duplicate: 'strip-index',
    lockExempt: 'frame-account',
  },
  // §3.3 class 5 lists `prompt`, `slot`, `swatch` (today's `draftroomPrompt`, `draftroomSlot`,
  // `draftroomSwatch` template markers); the converter carries them (spike B8, change request by O4)
  { match: 'exact', name: 'prompt', class: 'free', value: MarkerValue, maxBytes: 72, duplicate: 'keep' },
  { match: 'exact', name: 'slot', class: 'free', value: MarkerValue, maxBytes: 72, duplicate: 'keep' },
  { match: 'exact', name: 'swatch', class: 'free', value: MarkerValue, maxBytes: 72, duplicate: 'keep' },
]

const EXACT = new Map(LOBBY_KEY_SPECS.filter((s) => s.match === 'exact').map((s) => [s.name, s]))
const PREFIXED = LOBBY_KEY_SPECS.filter((s) => s.match === 'prefix')

/** The spec of a `customData.lobby` key, or null (an unknown key is `INVALID`). */
export function lobbyKeySpec(key: string): LobbyKeySpec | null {
  const exact = EXACT.get(key)
  if (exact) return exact
  for (const s of PREFIXED) if (key.startsWith(s.name) && key.length > s.name.length) return s
  return null
}

/** The `<uid>` of a `plusOne:<uid>` key, or null. */
export const plusOneUid = (key: string): string | null =>
  key.startsWith(PLUS_ONE_KEY_PREFIX) && key.length > PLUS_ONE_KEY_PREFIX.length
    ? key.slice(PLUS_ONE_KEY_PREFIX.length)
    : null
/** The `<tagKey>` of a `tag:<tagKey>` key, or null. */
export const tagKeyOf = (key: string): string | null =>
  key.startsWith(TAG_KEY_PREFIX) && key.length > TAG_KEY_PREFIX.length
    ? key.slice(TAG_KEY_PREFIX.length)
    : null

/** Why one `customData.lobby` value is not valid, or null when it is. */
export function lobbyValueProblem(key: string, value: unknown): string | null {
  const spec = lobbyKeySpec(key)
  if (!spec) return `unknown customData.lobby key ${JSON.stringify(key.slice(0, 64))}`
  if (!spec.value.safeParse(value).success) return `invalid value for ${spec.name}`
  if (spec.suffix && !spec.suffix(key.slice(spec.name.length), value)) return `invalid key ${spec.name}…`
  if (jsonByteLength(value) > spec.maxBytes) return `${spec.name} is too large`
  return null
}

export type LobbyCheck = { ok: true } | { ok: false; code: 'INVALID' | 'TOO_LARGE'; detail: string }

/**
 * The whole `customData.lobby` of one element: every key known and valid, at most 10 tags, at most 200
 * `plusOne:*` keys within their own 16 KiB, at most 120 `react:*` keys within their own 6 KiB (wave N), and
 * everything else within 8 KiB (§3.5).
 */
export function checkLobbyData(lobby: Readonly<Record<string, unknown>>): LobbyCheck {
  let plusOnes = 0
  let reactions = 0
  let tags = 0
  const plus: Record<string, unknown> = {}
  const react: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(lobby)) {
    const problem = lobbyValueProblem(key, value)
    if (problem) return { ok: false, code: 'INVALID', detail: problem }
    if (key.startsWith(PLUS_ONE_KEY_PREFIX)) {
      plusOnes++
      plus[key] = value
    } else if (key.startsWith(REACTION_KEY_PREFIX)) {
      reactions++
      react[key] = value
    } else {
      if (key.startsWith(TAG_KEY_PREFIX)) tags++
      rest[key] = value
    }
  }
  if (plusOnes > PLUS_ONES_MAX)
    return { ok: false, code: 'INVALID', detail: `more than ${PLUS_ONES_MAX} +1s` }
  if (reactions > REACTIONS_MAX)
    return { ok: false, code: 'INVALID', detail: `more than ${REACTIONS_MAX} reactions` }
  if (tags > MAX_TAGS_PER_ELEMENT)
    return { ok: false, code: 'INVALID', detail: `more than ${MAX_TAGS_PER_ELEMENT} tags` }
  if (jsonByteLength(plus) > PLUS_ONES_BUDGET_BYTES)
    return { ok: false, code: 'TOO_LARGE', detail: '+1 keys over their budget' }
  if (jsonByteLength(react) > REACTIONS_BUDGET_BYTES)
    return { ok: false, code: 'TOO_LARGE', detail: 'reaction keys over their budget' }
  if (jsonByteLength(rest) > MAX_LOBBY_CUSTOM_DATA_BYTES)
    return { ok: false, code: 'TOO_LARGE', detail: 'customData.lobby over its budget' }
  return { ok: true }
}

/** Who made or edited an element, from the ticket (never from the client). */
export const Attribution = z.strictObject({ uid: Uid, name: z.string().max(200), guest: z.boolean() })
export type Attribution = z.infer<typeof Attribution>

/**
 * `customData.lobbyServer` (class 1, §3.3). Only the server writes it: `createdBy`/`createdAt` on
 * create, `lastEditedBy`/`lastEditedAt` on text changes of text elements (it replaces
 * `props.textLastEditedBy`), `privateNote` only through the `place-notes` endpoint. An anonymous reveal
 * writes `null` authors. Archive export strips `privateNote.author` and `lastEditedBy`.
 */
export const LobbyServer = z.strictObject({
  createdBy: Attribution.nullable(),
  createdAt: z.number().int().nonnegative(),
  lastEditedBy: Attribution.nullable(),
  lastEditedAt: z.number().int().nonnegative(),
  privateNote: z
    .strictObject({ session: Session, author: z.string().min(1).max(MAX_UID_CHARS).optional() })
    .optional(),
})
export type LobbyServer = z.infer<typeof LobbyServer>

/** `customData` as stored and on the wire: only `lobby` and `lobbyServer`. */
export const CustomData = z.strictObject({
  lobby: z.record(z.string().min(1).max(200), z.unknown()).optional(),
  lobbyServer: LobbyServer.optional(),
})
export type CustomData = z.infer<typeof CustomData>
