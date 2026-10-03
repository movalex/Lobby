/**
 * Server validation limits and the geometry rules every side shares (docs/EXCALIDRAW-MIGRATION.md §3.5).
 * Frozen at the spike B contracts step C0 (docs/research/excalidraw/spike-b/CONTRACTS.md): the server,
 * the client (it refuses before pushing), archive import and the converter all read these numbers.
 *
 * Pure: no imports, no DOM, no Node built-ins. Safe in browsers, in Node and in the NAS load image.
 */

// ---- ids and formats ---------------------------------------------------------------------------------

/**
 * An element id (and a group id). Excalidraw's own ids are 21-character nanoids (`[A-Za-z0-9_-]`);
 * converted ids are the tldraw id without `shape:`, plus the converter's `.t`, `.o` and `.g` suffixes
 * (§3.6). The set is the one `CommentShapeRef` accepts after `shape:` (packages/contracts comments.ts), so
 * every element id can be an api object ref (`shape:<id>`, refs.ts) with no Postgres migration. A comma
 * never appears in an id (the `?el=` deep link separates ids with `,`).
 */
export const ELEMENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/

/** `fileId` on the wire and on the server: a Lobby version id, or a placed PDF page `ver_….p<n>` (§3.1). */
export const FILE_ID_PATTERN = /^ver_[0-9A-Za-z]{10,40}(\.p[1-9][0-9]{0,3})?$/
/** A bare version id (no page suffix), as the file-refs lookup takes it (packages/contracts sync-internal.ts). */
export const VERSION_ID_PATTERN = /^ver_[0-9A-Za-z]{10,40}$/
export const ASSET_ID_PATTERN = /^ast_[0-9A-Za-z]{10,40}$/

/** The `.p<n>` page of a placed PDF page's `fileId`, or null. */
export const pdfPageOf = (fileId: string): number | null => {
  const m = /\.p([1-9][0-9]{0,3})$/.exec(fileId)
  return m?.[1] ? Number(m[1]) : null
}
/** `ver_X.p3` → `ver_X`. */
export const versionIdOf = (fileId: string): string => fileId.replace(/\.p[1-9][0-9]{0,3}$/, '')

/** The web client's local derivative suffix (§2.10.3, E9): stripped at the adapter boundary, never on the wire. */
export const LOCAL_FILE_SUFFIX_PATTERN = /@(thumb|display)$/
export const stripLocalFileSuffix = (fileId: string): string => fileId.replace(LOCAL_FILE_SUFFIX_PATTERN, '')

/** A user id as the ticket carries it (A3): at most 60 characters (also checked in packages/auth-tickets). */
export const MAX_UID_CHARS = 60

// ---- fonts and coordinates -------------------------------------------------------------------------

/**
 * The families Lobby serves and measures (§2.12): 5 Excalifont, 6 Nunito, 7 Lilita One (the display face
 * for template headings, lead decision D3, CONTRACTS_REV 7), 8 Comic Shanns. 1-4, 9 and 10 are INVALID.
 */
export const LOBBY_FONT_FAMILIES = [5, 6, 7, 8] as const
export type LobbyFontFamilyId = (typeof LOBBY_FONT_FAMILIES)[number]
export const isLobbyFontFamily = (v: unknown): v is LobbyFontFamilyId =>
  v === 5 || v === 6 || v === 7 || v === 8

/** `x`, `y`, `width` and `height` of every element, and every coordinate in scene units (E 16334-16343). */
export const COORD_LIMIT = 1_000_000

// ---- geometry: the tolerance and the rounding rule (revision 3.5) -------------------------------------

/**
 * `GEOMETRY_TOLERANCE_PX = 0.5`, in scene coordinates. The structural derived test (§2.5.2), the undo
 * compare-and-set of `path` (§2.8) and every geometry assertion of the tests (§6.2, B3 L6/L10, the C0
 * arrow acceptance tests) use it: they check "within the tolerance", never "exactly". Excalidraw's own
 * follow is not bit-exact (5.7e-14 for 41 of 1,000 unrotated follows; up to 0.42 px for a rotated arrow's
 * free end), and the server rounds.
 */
export const GEOMETRY_TOLERANCE_PX = 0.5

/** Decimals kept by the rounding rule below. */
export const GEOMETRY_DECIMALS = 2
export const round2 = (v: number): number => Math.round(v * 100) / 100

/** An element counts as rotated when its `angle` is not exactly 0. */
export const isRotated = (el: { readonly angle?: number }): boolean => (el.angle ?? 0) !== 0

type Pt = readonly [number, number]
interface RoundableFixedSegment {
  readonly start: Pt
  readonly end: Pt
  readonly index: number
}
interface Roundable {
  readonly type: string
  readonly x: number
  readonly y: number
  readonly angle?: number
  readonly points?: readonly Pt[]
  readonly pressures?: readonly number[]
  readonly fixedSegments?: readonly RoundableFixedSegment[] | null
}

/**
 * The rounding rule (§3.5, revision 3.5, confirmed by the lead on 2026-09-29): 2 decimals for `points`
 * and `pressures` of `freedraw`, `line` and `arrow`, for an elbow arrow's `fixedSegments`, and for `x`,
 * `y` of an **unrotated** `line` or `arrow`. A rotated line's or arrow's `x`, `y` keep full precision:
 * rounding them makes a rotated free end creep on repeated re-snaps (2.4 px over 1,000 at angle 0.6).
 * On a re-snap the server also rounds the re-snapped bound point before the rebase (engine/binding.ts).
 *
 * Returns a copy with only the rounded fields replaced; other fields (and other types) are unchanged.
 */
export function roundGeometry<T extends Roundable>(el: T): T {
  if (el.type !== 'freedraw' && el.type !== 'line' && el.type !== 'arrow') return el
  const out: Record<string, unknown> = { ...(el as unknown as Record<string, unknown>) }
  if (el.points) out.points = el.points.map(([x, y]) => [round2(x), round2(y)])
  if (el.type === 'freedraw' && el.pressures) out.pressures = el.pressures.map(round2)
  if (el.type === 'arrow' && el.fixedSegments)
    out.fixedSegments = el.fixedSegments.map((s) => ({
      ...s,
      start: [round2(s.start[0]), round2(s.start[1])],
      end: [round2(s.end[0]), round2(s.end[1])],
    }))
  if ((el.type === 'line' || el.type === 'arrow') && !isRotated(el)) {
    out.x = round2(el.x)
    out.y = round2(el.y)
  }
  return out as T
}

// ---- per-element limits --------------------------------------------------------------------------------

/** `freedraw` points (a longer stroke is simplified with RDP at 0.5 px, then split, §3.5). */
export const MAX_FREEDRAW_POINTS = 2_500
export const FREEDRAW_SIMPLIFY_EPSILON_PX = 0.5
/** `line` and `arrow` points. */
export const MAX_LINEAR_POINTS = 1_000
/** An elbow arrow's fixed segments (never more than its points). */
export const MAX_FIXED_SEGMENTS = MAX_LINEAR_POINTS
/** `originalText` (today's cap), in UTF-16 code units, as `String.length` counts them. */
export const MAX_ORIGINAL_TEXT_CHARS = 20_000
/** The wrapped `text` of a label may add line breaks; it is bounded like two copies of the original. */
export const MAX_TEXT_CHARS = 2 * MAX_ORIGINAL_TEXT_CHARS
export const MAX_GROUP_IDS = 32
export const MAX_BOUND_ELEMENTS = 1_000
export const MAX_FRAME_NAME_CHARS = 200
export const MAX_COLOR_CHARS = 64

/** Element JSON bytes (UTF-8 of `JSON.stringify(element)`), per type (§3.5): the worst case per type. */
export const MAX_ELEMENT_BYTES = {
  text: 144 * 1024,
  freedraw: 64 * 1024,
  default: 32 * 1024,
} as const
export const maxElementBytes = (type: string): number =>
  type === 'text'
    ? MAX_ELEMENT_BYTES.text
    : type === 'freedraw'
      ? MAX_ELEMENT_BYTES.freedraw
      : MAX_ELEMENT_BYTES.default

/** `customData.lobby` without the `plusOne:*` keys, as UTF-8 JSON bytes. */
export const MAX_LOBBY_CUSTOM_DATA_BYTES = 8 * 1024
/** `plusOne:*` keys: at most 200 (`PLUS_ONES_MAX`), with their own budget (uids up to 60 characters). */
export const PLUS_ONES_MAX = 200
export const PLUS_ONES_BUDGET_BYTES = 16 * 1024
/** `tag:*` keys per element (`MAX_TAGS_PER_SHAPE`). */
export const MAX_TAGS_PER_ELEMENT = 10
/** `tagDef:*` keys per board (`MAX_TAGS_PER_BOARD`). */
export const MAX_TAG_DEFS = 200
export const MAX_ALT_CHARS = 500
export const MAX_FILE_NAME_CHARS = 200

/** `link`: http(s), mailto or a Lobby-relative path; at most 2 KiB; never `data:`, `javascript:` or signed. */
export const MAX_LINK_BYTES = 2 * 1024

const utf8Length = (s: string): number => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}
/** UTF-8 bytes of a string (no TextEncoder needed). */
export const byteLength = utf8Length
/** UTF-8 bytes of `JSON.stringify(value)`. */
export const jsonByteLength = (value: unknown): number => utf8Length(JSON.stringify(value) ?? '')

/**
 * Signed or expiring URL parameters: S3/R2 SigV4 (`X-Amz-*`), GCS V4 (`X-Goog-*`), CloudFront
 * (`Signature`, `Expires`, `Key-Pair-Id`) and Azure SAS (`sig`).
 */
const SIGNED_URL =
  /(?:[?&;](?:X-(?:Amz|Goog)-(?:Signature|Credential|Security-Token|Algorithm)|Signature|Expires|Key-Pair-Id|sig)=)/i

/** Rounds of percent-decoding a query is checked through; a query still changing after them is refused. */
const SIGNED_DECODE_ROUNDS = 4

/**
 * One round of percent-decoding that never throws: every `%XX` of an ASCII byte becomes its character, and
 * anything else (a malformed escape, a stray `%`, a byte of a multi-byte sequence) stays as written. A
 * malformed escape anywhere used to make `decodeURIComponent` throw, and the check gave up (V2 re-check,
 * fail open: `?X%2DAmz%2DSignature=abc&z=%` was stored).
 */
const decodeAsciiEscapes = (s: string): string =>
  s.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

/**
 * A signed-URL parameter in `query`, as written or percent-encoded (`X%2DAmz%2DSignature=`, `%58-Amz-…`),
 * decoded up to SIGNED_DECODE_ROUNDS times. Fails closed: a query that still decodes to something new after
 * the last round counts as signed (V2, part-3 round and its re-check).
 */
function signedQuery(query: string): boolean {
  let cur = query
  for (let i = 0; i < SIGNED_DECODE_ROUNDS; i++) {
    if (SIGNED_URL.test(cur)) return true
    const next = decodeAsciiEscapes(cur)
    if (next === cur) return false
    cur = next
  }
  return SIGNED_URL.test(cur) || decodeAsciiEscapes(cur) !== cur
}

/** A base no link ever names: a relative link resolved against it must stay on it. */
const RELATIVE_BASE = 'http://lobby-relative.invalid'

/**
 * A Lobby-relative link (`/…`) as a browser or a path normaliser would read it (XSS-F3, CONTRACTS_REV 9):
 * no backslash anywhere (a special-scheme URL parser treats `\` as `/`), and the normalised path is not
 * protocol-relative. `/..//evil.com` and `/a\..\..//evil.com` both normalise to `//evil.com`, which a
 * consumer that normalises first (`safeReturnTo`, a router) would take to another host.
 */
function relativeLinkAllowed(link: string): boolean {
  if (link.startsWith('//') || link.includes('\\')) return false
  let url: URL
  try {
    url = new URL(link, RELATIVE_BASE)
  } catch {
    return false
  }
  if (url.origin !== RELATIVE_BASE || url.pathname.startsWith('//')) return false
  return !signedQuery(link)
}

/** An absolute link must spell its authority: `https:evil.com` and `https:/evil.com` parse as `https://evil.com/`. */
const HTTP_AUTHORITY = /^https?:\/\//i

/**
 * Whether `link` may be stored (§3.5 "Links"): `http://`/`https://` URLs (the authority spelled out),
 * `mailto:`, or a Lobby-relative path (`/…`, never `//…`, never one that normalises to `//…`, no `\`);
 * at most 2 KiB; never a signed or expiring URL. Guests may only store Lobby-relative links (§3.5
 * "Guests"; `guest: true`). One function for the server (merge, the element schema), the web (link
 * cards) and the converter, so every end reads a link the same way.
 */
export function isAllowedLink(link: string, opts: { guest?: boolean } = {}): boolean {
  if (utf8Length(link) > MAX_LINK_BYTES) return false
  for (let i = 0; i < link.length; i++) {
    const c = link.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  if (link.startsWith('/')) return relativeLinkAllowed(link)
  if (opts.guest) return false
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return false
  }
  if (url.protocol === 'mailto:') return true
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!HTTP_AUTHORITY.test(link)) return false
  if (url.username || url.password) return false
  return !signedQuery(url.search)
}

// ---- board and session limits ------------------------------------------------------------------------

/** Items on a board: a bound label does not count (a note and its label are 1 item). */
export const MAX_ITEMS = 20_000
/** Live elements on a board, labels included. */
export const MAX_LIVE_ELEMENTS = 40_000
/** Archive import (`maxElements`). */
export const ARCHIVE_MAX_ELEMENTS = MAX_LIVE_ELEMENTS
/**
 * Items one name-only guest may create on a board (§3.5 "Guests"), counted per guest uid (lead decision D5,
 * CONTRACTS_REV 7), never per tab: every item the board still holds that this guest created counts, live or
 * deleted (a tombstone created or revived does not reset the count; V2's re-check).
 */
export const GUEST_ITEM_CAP = 500
/**
 * Items all name-only guests together may create on one board (CR-W5-FIX-3, EXCALIDRAW-MIGRATION open item
 * 16): the api mints a new guest uid for every cookie-less join of an editor guest link (up to
 * `GUESTS_PER_LINK` of them), so the per-uid cap above alone let one link make about 200 x 500 items. Summed
 * over every guest uid's count exactly as GUEST_ITEM_CAP counts (live and deleted, a detached label against
 * its creator), which the room rebuilds from the board's rows when it opens: no ticket or storage change.
 * Accounts are never refused by it.
 *
 * 6,000 = GUESTS_PER_LINK (200, packages/contracts guests.ts) x 30 items: a full workshop link (every seat
 * a different guest) gets 30 items each, and the guests together still hold at most 30% of MAX_ITEMS. A
 * smaller number (the first sketch said 2,000) stopped a reused 100-guest workshop board at 20 notes each
 * once tombstones were counted (limits.test.ts pins the product).
 */
export const GUEST_BOARD_ITEM_CAP = 6_000
/**
 * Board tag-list keys (`tagDef:*`, doc.ts) one name-only guest may write while the room is open (CR-3D-5): an
 * editor guest may create, rename, recolour and delete tags as an editor does, but each key it writes counts
 * once (a key it already wrote is free). MAX_TAG_DEFS bounds the list for everyone.
 */
export const GUEST_TAG_DEF_CAP = 10
/** Tombstones kept per board, and for how long (§2.6); a client below `horizon` gets a reset. */
export const TOMBSTONE_MAX = 10_000
export const TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60_000

// ---- wire and rates (§2.4.2, §2.4.5, §2.7) ---------------------------------------------------------------

export const MAX_OPS_PER_PUSH = 500
/** A push's JSON bytes; the whole WebSocket frame is capped at MAX_FRAME_BYTES (`maxPayload`). */
export const MAX_PUSH_BYTES = 512 * 1024
export const MAX_FRAME_BYTES = 1024 * 1024
/** Presence `sel`: ids sent up to this many; above it the client sends `{count}`; the server's hard cap. */
export const SEL_IDS_SENT_MAX = 200
export const MAX_SEL_IDS = 1_000
/** Drag previews: at most this many ids per drag. A presence `drag` above it is dropped (not the message). */
export const MAX_DRAG_IDS = 500
/** Hard bound of the `drag.ids` array a presence message may carry at all (above: INVALID message). */
export const MAX_DRAG_IDS_WIRE = 2_000
/** Presence in: at most 20 Hz per session; out: 10 Hz, at most 40 cursors per recipient. */
export const PRESENCE_IN_HZ = 20
export const PRESENCE_OUT_HZ = 10
export const CURSORS_PER_RECIPIENT = 40
/** Text lease TTL from the last renewal (presence `editing` renews at least every 2 s, §2.9.2). */
export const LEASE_TTL_MS = 10_000
export const LEASE_RENEW_MS = 2_000
/** Typing pushes go out at most this often (§2.5.3); one-shot edits coalesce within 50 ms. */
export const TYPING_PUSH_MS = 500
export const COALESCE_MS = 50
/** In-flight pushes per client (§2.5.1). */
export const MAX_IN_FLIGHT_PUSHES = 4
/** A replayed op older than this, for a group someone else wrote after its base, is STALE (§2.4.3 step 8). */
export const STALE_REPLAY_MS = 10 * 60_000
/** The per-tab offline queue (§2.5.6). */
export const OFFLINE_QUEUE_MAX_ELEMENTS = 5_000
export const OFFLINE_QUEUE_MAX_BYTES = 20 * 1024 * 1024

/** Inbound rates per session (§2.4.5); guests get half of each. */
export const RATES = {
  messages: { burst: 400, perSecond: 200 },
  ops: { burst: 2_000, perSecond: 500 },
  bytes: { burst: 4 * 1024 * 1024, perSecond: 1024 * 1024 },
} as const
export const GUEST_RATE_FACTOR = 0.5
/** More than this many abuse-counting rejects in a minute close the session with 4099 INVALID_MESSAGE. */
export const ABUSE_REJECTS_PER_MINUTE = 50

/** The limits a client must respect, sent in `welcome.limits` (protocol.ts). */
export const WIRE_LIMITS = {
  maxOpsPerPush: MAX_OPS_PER_PUSH,
  maxPushBytes: MAX_PUSH_BYTES,
  maxFrameBytes: MAX_FRAME_BYTES,
  maxItems: MAX_ITEMS,
  maxLiveElements: MAX_LIVE_ELEMENTS,
  maxDragIds: MAX_DRAG_IDS,
  maxSelIds: MAX_SEL_IDS,
  leaseTtlMs: LEASE_TTL_MS,
} as const
