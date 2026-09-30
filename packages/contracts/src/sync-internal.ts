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
/** Every asked id appears in exactly one list: `ok` (in this board's workspace), `foreign` (another workspace), `missing`. */
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
