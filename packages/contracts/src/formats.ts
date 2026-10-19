// Wave W, "Formats" (docs/WAVE-W-CONTRACTS.md): what doc cards, background removal, search inside files and deck import
// share, and the worker ops protocol behind the last three. OWNER: the wave W lead (packages/contracts is lead-only;
// every workstream reads it). The workspace admin page is ./workspace-admin.ts.
//
//   - doc cards (WS1, web only): a rectangle with a bound label whose words are Markdown-lite, `kind: 'doc-card'`;
//   - background removal (WS2): POST /api/files/:ver/remove-background, worker op `remove-bg`, a NEW asset and version;
//   - search inside files (WS3): worker op `extract-text`, file pages in search and Ask (SearchHit.file, ./search.ts);
//   - deck import (WS4): POST /api/files/:ver/render-pages, worker op `render-pages`, slides as frames + page images.
//
// Each has a kill switch on the api (apps/api/src/config.ts parseFormatSwitches): `on`; `off`, empty or unset = off
// (fail closed); anything else refuses to start. With a switch off every route of its feature answers 404 NOT_FOUND
// exactly like an unknown route (apps/api/src/features/formats/switch.ts). The api tells the web in GET
// /api/auth/config (`AuthConfig.formats`, optional: an api before wave W sends none, read as all off). A worker-backed
// feature is told on only while its switch is on AND a worker that has its capability claimed within
// WORKER_OP_LIMITS.capabilityFreshMs (§3 of the contracts doc), so the web never offers what would queue forever.
//
// Nothing of wave W changes the sync protocol (CONTRACTS_REV stays 14), an element field, a customData key or
// LOBBY_CLIENT_REV (3): no existing response enum gains a value. New placements are ordinary elements carrying the
// existing create-only `customData.lobby.kind` with new values (FORMAT_ELEMENT_KINDS), proven against every frozen
// reader by packages/canvas-schema/src/wave-w-kinds.test.ts.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

const prefixed = (p: string) => z.string().regex(new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`))
const VersionIdLike = prefixed('ver')
/** a board id (contracts BOARD_ID_PATTERN; not imported: index.ts re-exports this module) */
const BoardIdLike = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const OpIdLike = prefixed('wop')
const IsoDate = z.string()

// ---- the switches --------------------------------------------------------------------------------------------------

/** The api's wave W kill switches, by feature. */
export const FORMAT_SWITCHES = ['docCards', 'removeBackground', 'fileSearch', 'deckImport', 'admin'] as const
export type FormatSwitch = (typeof FORMAT_SWITCHES)[number]

/** The environment variable of each switch (render.yaml sets them on the api only). */
export const FORMAT_SWITCH_ENV: Readonly<Record<FormatSwitch, string>> = {
  docCards: 'DRAFTROOM_DOC_CARDS',
  removeBackground: 'DRAFTROOM_REMOVE_BACKGROUND',
  fileSearch: 'DRAFTROOM_FILE_SEARCH',
  deckImport: 'DRAFTROOM_DECK_IMPORT',
  admin: 'DRAFTROOM_WORKSPACE_ADMIN',
}

/** The switches as the api read them at boot (ApiConfig.formats). */
export const FormatSwitches = z.object({
  docCards: z.boolean(),
  removeBackground: z.boolean(),
  fileSearch: z.boolean(),
  deckImport: z.boolean(),
  admin: z.boolean(),
})
export type FormatSwitches = z.infer<typeof FormatSwitches>

/** Every switch off: what the web assumes when the api sends no `formats` (an api before wave W). */
export const FORMAT_SWITCHES_OFF: FormatSwitches = Object.freeze({
  docCards: false,
  removeBackground: false,
  fileSearch: false,
  deckImport: false,
  admin: false,
})

/**
 * `AuthConfig.formats`: what the web may offer now. Not strict (a later field is additive). For the three worker-backed
 * features it is the switch AND a capable worker seen recently (`formatsOffer`), so it can change without a restart.
 */
export const FormatsOffer = FormatSwitches
export type FormatsOffer = FormatSwitches

// ---- the worker ops and their capabilities -------------------------------------------------------------------------

/** One worker op family (migration 0039 `worker_ops.kind`). */
export const WORKER_OP_KINDS = ['remove-bg', 'extract-text', 'render-pages'] as const
export const WorkerOpKind = z.enum(WORKER_OP_KINDS)
export type WorkerOpKind = z.infer<typeof WorkerOpKind>

/** Which switch runs each op kind. */
export const WORKER_OP_SWITCH: Readonly<Record<WorkerOpKind, FormatSwitch>> = {
  'remove-bg': 'removeBackground',
  'extract-text': 'fileSearch',
  'render-pages': 'deckImport',
}

/** The worker-backed switches, and the op kind each needs a capable worker for. */
export const FORMAT_SWITCH_OP: Readonly<Partial<Record<FormatSwitch, WorkerOpKind>>> = {
  removeBackground: 'remove-bg',
  fileSearch: 'extract-text',
  deckImport: 'render-pages',
}

export const WORKER_OP_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const
export const WorkerOpStatus = z.enum(WORKER_OP_STATUSES)
export type WorkerOpStatus = z.infer<typeof WorkerOpStatus>
export const ACTIVE_WORKER_OP_STATUSES: readonly WorkerOpStatus[] = ['queued', 'running']

/**
 * A capability a worker reports on `POST /api/worker/ops/claim`: `<op kind>[:<variant>]@<version>`. The api hands a
 * worker only ops whose kind's CURRENT capability (below) it reports, exactly: a worker with an older runner (or a
 * different model) is never given work it would do differently. Bumping a version here means "the old runner's output
 * is not acceptable any more".
 */
export const WORKER_CAPABILITIES: Readonly<Record<WorkerOpKind, string>> = {
  'remove-bg': 'remove-bg:u2netp@1',
  'extract-text': 'extract-text@1',
  'render-pages': 'render-pages@1',
}
export const WORKER_CAPABILITY_RE = /^[a-z][a-z0-9-]{0,31}(:[a-z0-9][a-z0-9._-]{0,31})?@[1-9][0-9]{0,3}$/
export const WorkerCapability = z.string().regex(WORKER_CAPABILITY_RE, 'invalid capability')

/** The op kind a capability string names (its part before `:` or `@`), or null for anything else. */
export function opKindOfCapability(capability: string): WorkerOpKind | null {
  if (!WORKER_CAPABILITY_RE.test(capability)) return null
  const head = capability.split(/[:@]/, 1)[0] ?? ''
  return (WORKER_OP_KINDS as readonly string[]).includes(head) ? (head as WorkerOpKind) : null
}

/** The op kinds a worker may be given: those whose current capability it reports exactly. */
export const claimableKinds = (capabilities: readonly string[]): WorkerOpKind[] =>
  WORKER_OP_KINDS.filter((k) => capabilities.includes(WORKER_CAPABILITIES[k]))

/** The protocol's limits and timings (apps/api/src/worker/ops-*.ts; apps/worker/src/ops/*). */
export const WORKER_OP_LIMITS = {
  /** a claim's lease, renewed by each heartbeat (workers beat every ≤ 30 s), as the preview jobs' LEASE_MS */
  leaseMs: 120_000,
  /** claims per op before it fails INTERNAL (a file that keeps killing its worker) */
  maxAttempts: 3,
  /** `worker_ops.params` and `.result` (JSON text) */
  paramsBytes: 1024,
  resultBytes: 4096,
  /** output reservations per op attempt (render-pages renders ≤ 30 pages per op) */
  maxOutputsPerOp: 32,
  maxOutputBytes: 32 * 1024 * 1024,
  /** a queued op nobody capable claimed for this long fails WORKER_UNAVAILABLE */
  staleQueuedMs: 15 * 60_000,
  /** a capability counts as present while a worker reported it within this window */
  capabilityFreshMs: 10 * 60_000,
  /** capabilities per claim */
  maxCapabilities: 16,
  /** pages per `/text` call (an op sends several; each page is an upsert) */
  textPagesPerCall: 50,
} as const

/** Stable failure codes of an op (`worker_ops.error_code`); the web shows `WORKER_OP_MESSAGES`, never worker text. */
export const WORKER_OP_ERROR_CODES = [
  'WORKER_UNAVAILABLE',
  'SOURCE_MISSING',
  'SOURCE_UNSUPPORTED',
  'IMAGE_TOO_LARGE',
  'REMOVE_BG_FAILED',
  'TEXT_EXTRACT_FAILED',
  'RENDER_PAGES_FAILED',
  'TOO_MANY_PAGES',
  'QUOTA_EXCEEDED',
  'TIMEOUT',
  'CANCELLED',
  'INTERNAL',
] as const
export const WorkerOpErrorCode = z.enum(WORKER_OP_ERROR_CODES)
export type WorkerOpErrorCode = z.infer<typeof WorkerOpErrorCode>

export const WORKER_OP_MESSAGES: Readonly<Record<WorkerOpErrorCode, string>> = {
  WORKER_UNAVAILABLE: 'This is not available right now. Try again later.',
  SOURCE_MISSING: 'The file is missing. Upload it again and retry.',
  SOURCE_UNSUPPORTED: 'This file type is not supported for this.',
  IMAGE_TOO_LARGE: 'This image is too large. Use one under 40 megapixels and 25 MB.',
  REMOVE_BG_FAILED: 'The background could not be removed from this image.',
  TEXT_EXTRACT_FAILED: 'The text of this file could not be read.',
  RENDER_PAGES_FAILED: 'The slides of this file could not be made.',
  TOO_MANY_PAGES: 'This file has too many pages.',
  QUOTA_EXCEEDED: 'This workspace is out of storage. Free some space and try again.',
  TIMEOUT: 'This took too long and was stopped.',
  CANCELLED: 'Cancelled.',
  INTERNAL: 'Something went wrong. Try again.',
}

/** A worker-reported code as the code users see: anything unknown becomes INTERNAL. */
export const opFailureCode = (code: string | null | undefined): WorkerOpErrorCode =>
  code && (WORKER_OP_ERROR_CODES as readonly string[]).includes(code)
    ? (code as WorkerOpErrorCode)
    : 'INTERNAL'

// ---- the per-kind params and results (stored in worker_ops.params / .result; strict, small) ------------------------

export const RemoveBgParams = z.object({}).strict()
export const ExtractTextParams = z.object({ maxPages: z.number().int().min(1).max(300) }).strict()
export const RenderPagesParams = z
  .object({ from: z.number().int().min(1).max(9999), to: z.number().int().min(1).max(9999) })
  .strict()
  .refine((p) => p.from <= p.to && p.to - p.from < 30, {
    message: 'a render-pages op covers at most 30 pages',
  })

export const WORKER_OP_PARAMS = {
  'remove-bg': RemoveBgParams,
  'extract-text': ExtractTextParams,
  'render-pages': RenderPagesParams,
} as const

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)

/** remove-bg's result: the new version it made (the api writes it; the worker reports the PNG's facts). */
export const RemoveBgResult = z
  .object({
    sha256: Sha256,
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    bytes: z.number().int().min(1),
  })
  .strict()
export const ExtractTextResult = z
  .object({
    pages: z.number().int().min(0).max(300),
    bytes: z.number().int().min(0),
    truncated: z.boolean(),
    extractor: z.string().regex(/^[a-z0-9.-]{1,40}$/),
  })
  .strict()
export const RenderPagesResult = z
  .object({
    pageCount: z.number().int().min(1).max(9999),
    rendered: z.array(z.number().int().min(1)).max(30),
  })
  .strict()

export const WORKER_OP_RESULTS = {
  'remove-bg': RemoveBgResult,
  'extract-text': ExtractTextResult,
  'render-pages': RenderPagesResult,
} as const

// ---- the worker wire (/api/worker/ops/*; Bearer DRAFTROOM_WORKER_TOKEN, no cookies) ----------------------------------

/** The worker routes of the ops protocol (beside the preview routes, which do not change). */
export const WORKER_OP_ROUTES = {
  claim: '/api/worker/ops/claim',
  heartbeat: '/api/worker/ops/:op/heartbeat',
  output: '/api/worker/ops/:op/output',
  text: '/api/worker/ops/:op/text',
  complete: '/api/worker/ops/:op/complete',
  fail: '/api/worker/ops/:op/fail',
} as const

const WorkerIdLike = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/, 'invalid workerId')
const OpAttempt = z.number().int().min(1).max(1_000)

export const WorkerOpClaimInput = z.object({
  workerId: WorkerIdLike,
  capabilities: z.array(WorkerCapability).max(WORKER_OP_LIMITS.maxCapabilities),
})
export type WorkerOpClaimInput = z.infer<typeof WorkerOpClaimInput>

/** 200 on a claim (204 with no body when there is nothing for this worker). */
export const WorkerOpClaimed = z.object({
  op: z.object({
    id: OpIdLike,
    kind: WorkerOpKind,
    capability: WorkerCapability,
    boardId: BoardIdLike,
    sourceVersionId: VersionIdLike,
    params: z.record(z.string(), z.unknown()),
    attempt: OpAttempt,
    leaseMs: z.number().int().min(1),
    source: z.object({
      kind: z.enum(['image', 'pdf', 'video', 'other']),
      name: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().min(0),
      pageCount: z.number().int().min(0).nullable(),
    }),
  }),
  /** a presigned (or fs-mode) GET of the source original, valid for 900 s */
  source: z.object({ url: z.string() }),
})
export type WorkerOpClaimed = z.infer<typeof WorkerOpClaimed>

export const WorkerOpLeaseInput = z.object({ workerId: WorkerIdLike, attempt: OpAttempt })
export type WorkerOpLeaseInput = z.infer<typeof WorkerOpLeaseInput>

/** Reserve one output blob: a NEW original (remove-bg's PNG) or a derivative page of the source (render-pages). */
export const WorkerOpOutputInput = z
  .object({
    workerId: WorkerIdLike,
    attempt: OpAttempt,
    role: z.enum(['original', 'page']),
    page: z.number().int().min(1).max(9999).nullable().optional(),
    mimeType: z.enum(['image/png', 'image/webp']),
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    bytes: z.number().int().min(1).max(WORKER_OP_LIMITS.maxOutputBytes),
  })
  .refine((v) => (v.role === 'page') === (typeof v.page === 'number'), {
    message: 'page is required for role page, and only for it',
    path: ['page'],
  })
export type WorkerOpOutputInput = z.infer<typeof WorkerOpOutputInput>

export const WorkerOpOutputReserved = z.object({
  outputId: prefixed('wpo'),
  upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()) }),
})
export type WorkerOpOutputReserved = z.infer<typeof WorkerOpOutputReserved>

/** extract-text's pages, in batches (each page an upsert; the total is checked against FILE_TEXT_LIMITS at complete). */
export const WorkerOpTextInput = z.object({
  workerId: WorkerIdLike,
  attempt: OpAttempt,
  pages: z
    .array(z.object({ page: z.number().int().min(1).max(300), body: z.string().max(8_000) }))
    .min(1)
    .max(WORKER_OP_LIMITS.textPagesPerCall),
})
export type WorkerOpTextInput = z.infer<typeof WorkerOpTextInput>

export const WorkerOpCompleteInput = z.object({
  workerId: WorkerIdLike,
  attempt: OpAttempt,
  /** reserved output ids to publish, in order */
  outputs: z.array(prefixed('wpo')).max(WORKER_OP_LIMITS.maxOutputsPerOp).default([]),
  /** the kind's result (WORKER_OP_RESULTS), checked by the kind's completer */
  result: z.record(z.string(), z.unknown()),
})
export type WorkerOpCompleteInput = z.infer<typeof WorkerOpCompleteInput>

export const WorkerOpFailInput = z.object({
  workerId: WorkerIdLike,
  attempt: OpAttempt,
  /** the worker's code (opFailureCode maps it); its own detail is never shown or logged */
  code: z.string().max(64),
  /** a transient failure: back to queued after a backoff while attempts remain */
  retry: z.boolean().optional(),
  /** a shutting-down worker hands the op back at once, the attempt not counted */
  release: z.boolean().optional(),
})
export type WorkerOpFailInput = z.infer<typeof WorkerOpFailInput>

export const WorkerOpDone = z.object({ opId: OpIdLike, status: WorkerOpStatus, repeated: z.boolean() })
export type WorkerOpDone = z.infer<typeof WorkerOpDone>

// ---- the browser wire -----------------------------------------------------------------------------------------------

/** The browser routes of wave W formats (each pending until its owner lands it; gated by its switch). */
export const FORMAT_ROUTE_KEYS = {
  removeBackground: 'POST /api/files/:ver/remove-background',
  renderPages: 'POST /api/files/:ver/render-pages',
  opState: 'GET /api/file-ops/:op',
  opCancel: 'POST /api/file-ops/:op/cancel',
} as const
export type FormatRouteName = keyof typeof FORMAT_ROUTE_KEYS

/** Who may call each (§7 of the contracts doc; checked server-side by each route). */
export const FORMAT_RULES: Readonly<Record<FormatRouteName, 'edit-account' | 'requester'>> = {
  removeBackground: 'edit-account',
  renderPages: 'edit-account',
  opState: 'requester',
  opCancel: 'requester',
}

/** The routes a name-only guest is refused before any board check (apps/api features/guests/guard.ts). */
export const FORMAT_GUEST_REFUSED_ROUTE_KEYS = [
  FORMAT_ROUTE_KEYS.removeBackground,
  FORMAT_ROUTE_KEYS.renderPages,
] as const

/** The 403 GUEST_ACCOUNT_REQUIRED message of those routes. */
export const FORMAT_GUESTS_MESSAGE =
  'Guests can place files, but removing backgrounds and making slides is done by editors with an account. Sign in with an account to do it.'

export const removeBackgroundPath = (versionId: string) => `/api/files/${versionId}/remove-background`
export const renderPagesPath = (versionId: string) => `/api/files/${versionId}/render-pages`
export const fileOpPath = (opId: string) => `/api/file-ops/${opId}`
export const fileOpCancelPath = (opId: string) => `/api/file-ops/${opId}/cancel`

/** Body of both POSTs: the board the file is on (the version must be served there: files-auth.ts). */
export const FileOpInput = z.object({ boardId: BoardIdLike }).strict()
export type FileOpInput = z.infer<typeof FileOpInput>

/** An op as its requester sees it (202 on a request; GET; the `file.op` event). */
export const FileOpState = z.object({
  id: OpIdLike,
  kind: WorkerOpKind,
  status: WorkerOpStatus,
  boardId: BoardIdLike,
  sourceVersionId: VersionIdLike,
  /** remove-bg: the new version once done */
  resultVersionId: VersionIdLike.nullable(),
  /** render-pages: the pages made available (the source's `page` derivatives now cover 1..this) */
  pagesReady: z.number().int().min(0).nullable(),
  errorCode: WorkerOpErrorCode.nullable(),
  message: z.string().nullable(),
  createdAt: IsoDate,
  finishedAt: IsoDate.nullable(),
})
export type FileOpState = z.infer<typeof FileOpState>

/** The board event sent to the requester's streams only after COMMIT (events/hub.ts `to`). */
export const FILE_OP_EVENT = 'file.op'
export const FileOpEvent = z.object({ op: FileOpState })
export type FileOpEvent = z.infer<typeof FileOpEvent>

/** Refusals the web tells apart. */
export const FORMAT_ERROR_CODES = {
  /** 409: an op of this kind is already queued or running for this file (the body names it) */
  opActive: 'FILE_OP_ACTIVE',
  /** 429: one active op per user, or the hourly / daily windows of REMOVE_BG_LIMITS */
  opLimit: 'FILE_OP_LIMIT',
  /** 400: the version is not of a kind, type or size this op takes */
  unsupported: 'FILE_OP_UNSUPPORTED',
  /** 409: the file is not ready (still processing, or failed) */
  notReady: 'FILE_NOT_READY',
  /** 507: the workspace's quota has no room for the result */
  quota: 'QUOTA_EXCEEDED',
  /** 409: render-pages on a deck of at most DECK_LIMITS.eagerPages pages (they exist already) */
  nothingToRender: 'NOTHING_TO_RENDER',
} as const

// ---- limits ---------------------------------------------------------------------------------------------------------

/** Background removal (WS2): request checks, the child's budget, and the per-person and per-workspace windows. */
export const REMOVE_BG_LIMITS = {
  inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] as readonly string[],
  maxInputBytes: 25 * 1024 * 1024,
  maxInputPixels: 40_000_000,
  maxInputEdge: 12_000,
  maxOutputEdge: 4_096,
  maxOutputBytes: 25 * 1024 * 1024,
  /** the model's square input (u2netp) */
  modelSize: 320,
  childHeapMb: 256,
  childTimeoutMs: 45_000,
  intraOpThreads: 2,
  perUserActive: 1,
  perUserPerHour: 30,
  perWorkspacePerDay: 300,
  perWorkspaceActive: 3,
} as const

/** The new version's display name: "<name without its extension> (no background).png", within 200 characters. */
export function noBackgroundName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || 'Image'
  const suffix = ' (no background).png'
  return `${[...base].slice(0, 200 - suffix.length).join('')}${suffix}`
}

/** Search inside files (WS3): extraction, storage and query caps. */
export const FILE_TEXT_LIMITS = {
  maxPages: 300,
  maxPageChars: 8_000,
  maxVersionBytes: 512 * 1024,
  /** body bytes of file text kept per workspace; past it new extractions store nothing ("index full") */
  maxWorkspaceBytes: 200 * 1024 * 1024,
  childHeapMb: 384,
  childTimeoutMs: 60_000,
  officeTimeoutMs: 120_000,
  backfillPerSweep: 20,
  backfillEveryMs: 10 * 60_000,
  /** file hits per board among SEARCH_HITS_PER_BOARD */
  maxFileHitsPerBoard: 2,
  /** Ask across boards: the characters of file text among the 12k source cap */
  askShareChars: 4_000,
  /** `file_text_state.extractor` of this build */
  extractor: 'pdfjs-6.3.289',
} as const

/** Deck import (WS4): slides past the eager pages are rendered by render-pages ops. */
export const DECK_LIMITS = {
  maxSlides: 100,
  /** the pages every preview job renders already (dev-assets LIMITS.eagerPdfPages) */
  eagerPages: 8,
  pagesPerOp: 30,
  /** the page role's width (the existing derivative; the loader is unchanged) */
  pageEdge: 1024,
  slideWidth: 1600,
  gridColumns: 5,
  gridGap: 80,
} as const

/** The render-pages ops a deck of `pageCount` pages needs (pages 9..min(N, 100) in runs of ≤ 30). */
export function deckRenderRuns(pageCount: number): { from: number; to: number }[] {
  const last = Math.min(pageCount, DECK_LIMITS.maxSlides)
  const runs: { from: number; to: number }[] = []
  for (let from = DECK_LIMITS.eagerPages + 1; from <= last; from += DECK_LIMITS.pagesPerOp)
    runs.push({ from, to: Math.min(last, from + DECK_LIMITS.pagesPerOp - 1) })
  return runs
}

/** Doc cards (WS1): the card's size, the text cap and the parser's budget. */
export const DOC_CARD_LIMITS = {
  width: 640,
  height: 400,
  /** the label's `originalText` (canvas-schema MAX_ORIGINAL_TEXT_CHARS); WS1 may lower it to 12k after the NAS gate */
  maxChars: 20_000,
  /** what search indexes per entry (apps/sync board-text ENTRY_MAX_CHARS; raising it is a sync change) */
  searchIndexedChars: 4_000,
  maxBlocks: 2_000,
  maxInlineNodes: 20_000,
} as const

// ---- elements -------------------------------------------------------------------------------------------------------

/**
 * The `customData.lobby.kind` of wave W placements: a doc card (a rectangle with a bound label, WS1), a deck slide's
 * frame and its page image (WS4). Create-only, a short lowercase word: every reader since rev 11 accepts it.
 */
export const FORMAT_ELEMENT_KINDS = {
  docCard: 'doc-card',
  deckSlide: 'deck-slide',
  deckPage: 'deck-page',
} as const
export type FormatElementKind = (typeof FORMAT_ELEMENT_KINDS)[keyof typeof FORMAT_ELEMENT_KINDS]

/** A deck slide frame's name: "<n> · <first line of its text, ≤ 60>", or "Slide <n>". */
export function deckSlideName(n: number, firstLine: string | null | undefined): string {
  const line = (firstLine ?? '').replace(/\s+/g, ' ').trim()
  return line ? `${n} · ${[...line].slice(0, 60).join('')}` : `Slide ${n}`
}

// ---- search inside files (SearchHit.file, ./search.ts) -------------------------------------------------------------

/** A file hit's objectId: `file:<ver>.p<page>` (SearchHit.objectId is a free string; an older web opens the board). */
export const fileHitObjectId = (versionId: string, page: number) => `file:${versionId}.p${page}`
const FILE_HIT_RE = /^file:(ver_[0-9A-Za-z]{10,40})\.p([1-9][0-9]{0,3})$/
export function parseFileHitObjectId(objectId: string): { versionId: string; page: number } | null {
  const m = FILE_HIT_RE.exec(objectId)
  return m ? { versionId: m[1] as string, page: Number(m[2]) } : null
}

/** The board URL query of a file hit's deep link: `/b/<id>?file=<ver>&page=<n>`. */
export const FILE_HIT_QUERY = { file: 'file', page: 'page' } as const
