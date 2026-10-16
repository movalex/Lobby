// The api <-> sync internal contracts of the Excalidraw engine (docs/EXCALIDRAW-MIGRATION.md §1 A1, A2,
// §2.4.6, §2.10.2), frozen at the spike B contracts step C0 (docs/research/excalidraw/spike-b/
// CONTRACTS.md). Used by O1 (the sync clients `apps/sync/src/file-refs.ts` and `workshop-state.ts`, and
// the room's snapshot route), O5 (the api routes) and O3 (the fake api). Browser-safe (zod only).
//
// Bridge release R0 (§5.10) ships this file unchanged from the spike: its api serves A1 and the A2 GET
// (apps/api/src/routes/engine-internal.ts); the tldraw sync uses none of it. The Excalidraw build uses all
// of it.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// Every route requires the internal secret in the `x-draftroom-internal` header (INTERNAL_SECRET_HEADER
// of @draftroom/auth-tickets, as touch.ts and access.ts send it). Errors are `{ error: { code, message } }`
// with the codes below; the sync router's shared secret check answers 401 `UNAUTHORIZED` before any
// route (unchanged). Sync treats any status but 200/204, and a timeout, as unavailable: FAIL CLOSED
// (ops that need an unresolved file get `UNAVAILABLE`, §2.10.2).
//
//   A1  GET  <api>/internal/boards/:bid/file-refs?ids=ver_a,ver_b,…   → 200 FileRefsResponse
//   A2  GET  <api>/internal/boards/:bid/workshop-state                → 200 WorkshopStateBody   (sync pulls on room open)
//   A2  POST <sync>/internal/boards/:bid/workshop-state  WorkshopStateBody → 204                  (api pushes on change)
//       GET  <sync>/internal/boards/:bid/snapshot                     → 200 LobbyElementsSnapshot (excalidraw engine)

import { BOARD_ROLES } from '@draftroom/permissions'
import { z } from 'zod'

/** The header the internal secret travels in (the same value as @draftroom/auth-tickets INTERNAL_SECRET_HEADER). */
export const SYNC_INTERNAL_SECRET_HEADER = 'x-draftroom-internal'
/** Sync's timeout for each api call (§2.10.2): after it, fail closed. */
export const SYNC_INTERNAL_TIMEOUT_MS = 3_000

// ---- errors ----------------------------------------------------------------------------------------

export const SYNC_INTERNAL_ERROR_CODES = [
  'bad-secret',
  'bad-request',
  'board-not-found',
  'unavailable',
] as const
export type SyncInternalErrorCode = (typeof SYNC_INTERNAL_ERROR_CODES)[number]
/** Status of each code: 401 bad-secret, 400 bad-request, 404 board-not-found, 503 unavailable. */
export const SYNC_INTERNAL_ERROR_STATUS: Readonly<Record<SyncInternalErrorCode, number>> = {
  'bad-secret': 401,
  'bad-request': 400,
  'board-not-found': 404,
  unavailable: 503,
}
export const SyncInternalErrorBody = z.strictObject({
  error: z.strictObject({ code: z.enum(SYNC_INTERNAL_ERROR_CODES), message: z.string().max(500) }),
})
export type SyncInternalErrorBody = z.infer<typeof SyncInternalErrorBody>

// ---- A1 file-refs (§2.10.2) -----------------------------------------------------------------------------

/** At most this many ids per call. */
export const FILE_REFS_MAX_IDS = 100
/**
 * A BARE version id (`ver_…`), the version part of the §3.1 `fileId` pattern. Sync strips a placed PDF
 * page's `.p<n>` suffix before asking (and dedups), and checks `n` against the answer's `pageCount`.
 */
export const FILE_REF_VERSION_ID_PATTERN = /^ver_[0-9A-Za-z]{10,40}$/
export const FileRefVersionId = z.string().regex(FILE_REF_VERSION_ID_PATTERN)
/** The `ids` query parameter: 1–100 comma-separated version ids. */
export const FileRefsQuery = z.strictObject({
  ids: z
    .string()
    .min(1)
    .transform((s) => s.split(','))
    .pipe(z.array(FileRefVersionId).min(1).max(FILE_REFS_MAX_IDS)),
})
/** The ids of a `file-refs` call, or null when malformed (→ 400 bad-request). */
export function parseFileRefsIds(raw: string | null | undefined): string[] | null {
  const parsed = FileRefsQuery.safeParse({ ids: raw ?? '' })
  return parsed.success ? parsed.data.ids : null
}
export const fileRefsPath = (boardId: string, ids: readonly string[]) =>
  `/internal/boards/${encodeURIComponent(boardId)}/file-refs?ids=${ids.map(encodeURIComponent).join(',')}`

/** One version of the board's workspace: the same check the `/files/…` routes use. */
export const FileRef = z.strictObject({
  versionId: FileRefVersionId,
  assetId: z.string().regex(/^ast_[0-9A-Za-z]{10,40}$/),
  kind: z.enum(['image', 'pdf', 'video', 'other']),
  name: z.string().max(200),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  /** pages of a PDF (null for other kinds, or before processing counted them) */
  pageCount: z.number().int().nonnegative().nullable(),
})
export type FileRef = z.infer<typeof FileRef>
/**
 * Every asked id appears in exactly one list: `ok` (a version the board shows), `missing` (no such
 * version, or one the board cannot show: another workspace, or an unlinked board of the same one). The
 * api once told the second case apart as `foreign`; since the wave-4b security fixes (audit L4) it
 * answers both as `missing` and leaves `foreign` empty, kept here for the shape. Readers treat the two
 * lists alike (sync: `INVALID`).
 */
export const FileRefsResponse = z.strictObject({
  ok: z.array(FileRef),
  foreign: z.array(FileRefVersionId),
  missing: z.array(FileRefVersionId),
})
export type FileRefsResponse = z.infer<typeof FileRefsResponse>
/** Sync's per-room cache of answers (§2.10.2). */
export const FILE_REFS_CACHE = { entries: 10_000, positiveMs: 10 * 60_000, negativeMs: 30_000 } as const

// ---- A2 workshop-state -----------------------------------------------------------------------------------

/** Whether a dot vote is open on the board, and whether it is anonymous (the server then refuses +1s and drops `sel`). */
export const WorkshopStateBody = z.strictObject({ voteOpen: z.boolean(), anonymous: z.boolean() })
export type WorkshopStateBody = z.infer<typeof WorkshopStateBody>
export const workshopStatePath = (boardId: string) =>
  `/internal/boards/${encodeURIComponent(boardId)}/workshop-state`

// ---- the sync snapshot in the excalidraw engine (§2.4.6) ---------------------------------------------------

/**
 * `GET <sync>/internal/boards/:bid/snapshot` when sync runs the Excalidraw engine: the LIVE elements
 * (tombstones only in the test snapshot) and the board document, at `clock`. Its readers (checkpoints,
 * AI sources, vote eligibility) validate elements with `@draftroom/canvas-schema/elements`; this
 * envelope is what the api and sync agree on.
 */
export const LobbyElementsSnapshot = z.strictObject({
  format: z.literal('lobby-elements'),
  schema: z.number().int().positive(),
  clock: z.number().int().nonnegative(),
  elements: z.array(z.record(z.string(), z.unknown())),
  doc: z.record(z.string(), z.unknown()),
})
export type LobbyElementsSnapshot = z.infer<typeof LobbyElementsSnapshot>

// ---- selective restore (wave L, L7-2; owner W7) -------------------------------------------------------------
//
//   POST <sync>/internal/boards/:bid/restore-elements  RestoreElementsBody → 200 RestoreElementsAnswer
//
// api → sync only (behind the internal secret, like every internal route). The sync writes the checkpoint's
// copies of `ids` into the live board through its server write, in the room's queue, in one SAVEPOINT, acked
// after COMMIT: a live element gets the checkpoint's field groups, a deleted one comes back with its kept id
// (`created: null`); a text under another session's lease is skipped (LEASED), and an element locked now is
// skipped (INVALID: a restore never overrides a lock, as no push does); arrow geometry is whole units;
// bindings to targets that are neither live nor restored are dropped as a server fix; bound ends and labels are
// re-snapped in the same commit. Only lb_* tables are written (never the tldraw tables nor dr_deleted_*). A
// sync built before canvas-schema RESTORE_ELEMENTS_REV has no such route (404): the api answers 503
// RESTORE_UNAVAILABLE (history.ts). Over the board's element cap: 409 ELEMENT_LIMIT, nothing written.

/** At most this many elements per call (the ids closed over bound texts and containers, history.ts caps ids at 200). */
export const RESTORE_ELEMENTS_MAX_ELEMENTS = 1_000
/** The request body cap the sync applies to this route. */
export const RESTORE_ELEMENTS_BODY_LIMIT_BYTES = 4 * 1024 * 1024

export const restoreElementsInternalPath = (boardId: string) =>
  `/internal/boards/${encodeURIComponent(boardId)}/restore-elements`

export const RestoreElementsBody = z
  .strictObject({
    /** who restores (the api's authenticated user): the write's author, as on any server write */
    actor: z.strictObject({ uid: z.string().min(1).max(60), name: z.string().max(200) }),
    /** the element ids asked for (what `restored` and `skipped` answer for, with what came with them) */
    ids: z
      .array(z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/))
      .min(1)
      .max(200),
    /**
     * the checkpoint's elements as stored (each one checked by the sync with canvas-schema's element check); empty
     * only with `removeAbsent` (an "Undo restore" whose ids the checkpoint holds none of)
     */
    elements: z.array(z.looseObject({ id: z.string(), type: z.string() })).max(RESTORE_ELEMENTS_MAX_ELEMENTS),
    /** W7 ("Undo restore", history.ts RestoreElementsInput): an asked id the checkpoint lacks is removed, not MISSING */
    removeAbsent: z.literal(true).optional(),
    /** wave L round 1 (required with removeAbsent; history.ts RestoreElementsInput): the undone restore's clock */
    restoreClock: z.number().int().nonnegative().optional(),
  })
  .refine((b) => b.elements.length > 0 || b.removeAbsent === true, {
    message: 'elements: at least one, unless removeAbsent',
    path: ['elements'],
  })
  .refine((b) => b.removeAbsent !== true || b.restoreClock !== undefined, {
    message: 'restoreClock: required with removeAbsent',
    path: ['restoreClock'],
  })
export type RestoreElementsBody = z.infer<typeof RestoreElementsBody>

export const RestoreElementsAnswer = z.strictObject({
  restored: z.array(z.string()),
  skipped: z.array(
    z.strictObject({ id: z.string(), code: z.enum(['LEASED', 'MISSING', 'INVALID', 'CHANGED'] as const) }),
  ),
  /** the board clock the write committed at */
  clock: z.number().int().nonnegative(),
  /** wave L round 2 (history.ts RestoreElementsResult): false when nothing was written (`clock` is the board's as it was) */
  wrote: z.boolean().optional(),
})
export type RestoreElementsAnswer = z.infer<typeof RestoreElementsAnswer>

// ---- the batched access recheck (wave M, CAP-SYNC-RECHECK, M7-1; owner W7, frozen by the wave M foundation) --
//
//   POST <api>/internal/access-many  AccessManyRequest → 200 AccessManyResponse
//
// sync → api only (behind the internal secret, like every internal route). One call per recheck round (chunks of
// ACCESS_MANY_MAX_PAIRS) instead of one GET /internal/access per board-user pair. Each pair's `role` is exactly
// what GET /internal/access answers for it (connectionRole of loadBoardAccess); `signedInSince` is answered once
// per person (RT-01, as GET /internal/access's field). Unknown boards and people answer role null.
// Downgrade: an api without the route answers 404; the sync then makes the per-pair calls for that round and
// probes again later. Until W7 implements it the route is not registered (404 NOT_FOUND).

export const ACCESS_MANY_PATH = '/internal/access-many'
/** Pairs per call (the sync chunks a bigger round). */
export const ACCESS_MANY_MAX_PAIRS = 500

const AccessManyBoardId = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const AccessManyUserId = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)
const AccessManyRole = z.enum(BOARD_ROLES)

export const AccessManyPair = z.strictObject({ boardId: AccessManyBoardId, userId: AccessManyUserId })
export type AccessManyPair = z.infer<typeof AccessManyPair>

export const AccessManyRequest = z.strictObject({
  pairs: z.array(AccessManyPair).min(1).max(ACCESS_MANY_MAX_PAIRS),
})
export type AccessManyRequest = z.infer<typeof AccessManyRequest>

export const AccessManyResult = z.strictObject({
  boardId: AccessManyBoardId,
  userId: AccessManyUserId,
  /** The person's role on the board now, or null for no access (unknown, trashed, revoked). */
  role: AccessManyRole.nullable(),
})
export type AccessManyResult = z.infer<typeof AccessManyResult>

export const AccessManyResponse = z.strictObject({
  /** One entry per asked pair, in the request's order (a repeated pair is answered each time). */
  results: z.array(AccessManyResult).max(ACCESS_MANY_MAX_PAIRS),
  /** userId → when the person's oldest live session started (epoch ms), or null when they have none. */
  signedInSince: z.record(AccessManyUserId, z.number().int().nonnegative().nullable()),
})
export type AccessManyResponse = z.infer<typeof AccessManyResponse>

// ---- wave N: strip-keys maintenance (OWNER: WS2; landed by the wave N foundation) -----------------------------------
//
//   POST <sync>/internal/maintenance/strip-keys  StripKeysRequest → 200 StripKeysAnswer
//
// Internal secret only (the existing internal router). The rollback step for reactions (plan N2-5): the sync opens
// each board room in turn and removes every `customData.lobby` key with `prefix` through its server write, in a
// normal commit (broadcast, so every open tab converges), and logs counts only. A board with no such key is not
// rewritten; a second run is a no-op. Only the sync process writes the board files. Until WS2 implements it the route
// does not exist (404), like any unknown internal path.

export const STRIP_KEYS_ROUTE = '/internal/maintenance/strip-keys'
/**
 * The key prefixes the route may strip: the key classes of canvas-schema protocol.ts LOBBY_KEY_ADDITIONS (wave N's
 * `react:`; wave T's planning classes `card:`, `sb:`, `kanban` and `timeline`, planning-keys.ts PLANNING_KEY_CLASSES,
 * kept equal by canvas-schema planning.test.ts). Wave T's rollback below 14 strips each of the four.
 */
export const STRIP_KEYS_PREFIXES = ['react:', 'card:', 'sb:', 'kanban', 'timeline'] as const
export const StripKeysRequest = z.strictObject({ prefix: z.enum(STRIP_KEYS_PREFIXES) })
export type StripKeysRequest = z.infer<typeof StripKeysRequest>
const Count = z.number().int().nonnegative()
export const StripKeysAnswer = z.strictObject({
  /** board files looked at, and those rewritten (they held at least one such key) */
  boards: Count,
  rewritten: Count,
  /** elements changed, and keys removed */
  elements: Count,
  keys: Count,
  /** boards that could not be opened or committed (named in the log by id only) */
  failed: Count,
})
export type StripKeysAnswer = z.infer<typeof StripKeysAnswer>

// ---- wave N: links in the read-only text route (OWNER: WS7; landed by the wave N foundation) -------------------------
//
//   GET <sync>/internal/boards/:bid/text?links=1[&since=…][&maxBytes=…]
//
// With BOARD_TEXT_LINKS_PARAM = 1 the text answer (apps/sync/src/http/board-text.ts; unchanged answers stay
// `{unchanged: true}`) adds `links`: every live element whose `link` is a Lobby-relative board path
// (board-links.ts BOARD_LINK_PATH_PATTERN), at most BOARD_TEXT_LINKS_MAX per board, inside the same bounded
// extraction. Without the parameter the answer is byte-identical to the wave M one, and an older sync ignores the
// parameter (the api then keeps its indexed rows). The route stays read-only: the sync is still the only board writer.

export const BOARD_TEXT_LINKS_PARAM = 'links'
export const BOARD_TEXT_LINKS_MAX = 200
export const BoardTextLink = z.strictObject({
  /** the linking element */
  el: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
  /** the target board */
  to: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  /** the target element (`?el=`), when the link names one */
  toEl: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,120}$/)
    .optional(),
})
export type BoardTextLink = z.infer<typeof BoardTextLink>
export const BoardTextLinks = z.array(BoardTextLink).max(BOARD_TEXT_LINKS_MAX)
export type BoardTextLinks = z.infer<typeof BoardTextLinks>

// ---- wave T: assignee-refs (OWNER: WS1 for the sync's client; the api route is the wave T foundation's) -------------
//
//   POST <api>/internal/boards/:bid/assignee-refs  AssigneeRefsRequest → 200 AssigneeRefsAnswer
//
// sync → api only, behind the internal secret (like every internal route; exempt from the web-origin check as a
// server-to-server POST, apps/api routes/tickets.ts INTERNAL_SYNC_POSTS). `card:who` (canvas-schema planning-keys.ts) is
// identity-bearing: the room may store a uid there only when it names an ACCOUNT (users.kind = 'account', never a
// name-only guest) with a role on the board now (connectionRole over loadBoardAccess: owner, editor, commenter or
// viewer of an active or archived board). The answer lists exactly those of the asked uids (each once, in the
// request's order); every other uid (unknown, a guest, no access, malformed) is left out, the same for all, so the
// route is no existence oracle. A trashed or unknown board is 404 `board-not-found` (the sync then refuses the write
// UNAVAILABLE: fail closed), a database failure 503 `unavailable`, a bad body 400 `bad-request`.
// The room asks once per push batch for the uids it does not hold in its per-room cache (ASSIGNEE_REFS_CACHE_MS),
// before merge, as it asks file-refs; removing an assignee needs no lookup. A separate route, not a field of
// access-many: that answer is a strictObject an older sync would refuse with a new field.
// Deploy: api before sync (an api without the route answers 404, and every assignment is then UNAVAILABLE).

export const ASSIGNEE_REFS_ROUTE = '/internal/boards/:bid/assignee-refs'
export const assigneeRefsPath = (boardId: string) =>
  `/internal/boards/${encodeURIComponent(boardId)}/assignee-refs`
/** At most this many uids per call (the room splits a bigger batch). */
export const ASSIGNEE_REFS_MAX_UIDS = 50
/** How long the room keeps an answer per uid (a removed member may be assigned once within it: design risk 3). */
export const ASSIGNEE_REFS_CACHE_MS = 60_000
/** A uid as `card:who` holds it (canvas-schema limits MAX_UID_CHARS, 60): the api decides what it names. */
const AssigneeUid = z.string().min(1).max(60)
export const AssigneeRefsRequest = z.strictObject({
  uids: z.array(AssigneeUid).min(1).max(ASSIGNEE_REFS_MAX_UIDS),
})
export type AssigneeRefsRequest = z.infer<typeof AssigneeRefsRequest>
export const AssigneeRefsAnswer = z.strictObject({
  /** the asked uids that are accounts with a role on the board, each once, in the request's order */
  accounts: z.array(AssigneeUid).max(ASSIGNEE_REFS_MAX_UIDS),
})
export type AssigneeRefsAnswer = z.infer<typeof AssigneeRefsAnswer>
