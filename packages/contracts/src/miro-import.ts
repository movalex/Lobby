// Import from Miro (wave R, WS1; docs/WAVE-R-CONTRACTS.md §3; the reviewed egress exception in AGENTS.md "Server
// egress exception: Miro import"). OWNER: WS1 after the wave R foundation. Frozen by the foundation.
//
//   POST /api/workspaces/:wid/imports/miro/boards   { token, query?, offset? }      → 200 ListMiroBoardsResponse
//        checks the token (GET https://api.miro.com/v1/oauth-token) and lists the boards it can see; nothing is kept
//   POST /api/workspaces/:wid/imports/miro          { token, boards, projectId?, referencePdf? } → 202 StartImportResponse
//   POST /api/imports/:id/resume                     { token }   (imports.ts; a Miro job asks for its token again)
//
// Who: a creator who may create boards in the workspace (and in the project, when one is named): the creator guard
// ('always') and the route's own checks, again at each board's activation. A name-only guest is refused first.
//
// The token (a Miro OAuth access token the person pasted for this job, scope boards:read):
//  - is read from the body BY HAND (splitMiroToken: no schema issue, no error message can ever echo it), checked with
//    MIRO_TOKEN_PATTERN, and held in the api's memory only, wrapped so it prints as `[redacted]` everywhere
//    (apps/api/src/egress/secret.ts RedactedSecret), for the job's lifetime; dropped when the job ends or pauses;
//  - is sent only in the Authorization header, only to MIRO_API_HOST, only on MIRO_API_PATH_PATTERNS (apps/api/src/
//    egress: exact host allowlist, https:443, address vetted and pinned, redirects refused, deadline and byte caps);
//  - is never written to Postgres, disk, logs, audit rows, error messages or responses.
// File bytes: a resource answer (`?redirect=false` → `{ type, url }`, valid about 60 s) may point only at a host in
// MIRO_DOWNLOAD_HOSTS, fetched with no Authorization and no cookies, GET only, and only while its `Expires` is in the
// future; any other host refuses that file (`file-host-refused`). No URL found inside Miro content (embeds, links) is
// ever fetched: those become link cards.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { parseUrl } from './whatwg-url.ts'

const ProjectIdLike = z.string().regex(/^prj_[0-9A-Za-z]{10,40}$/)
/** canvas-schema limits.ts VERSION_ID_PATTERN (contracts may not import canvas-schema). */
const VersionIdLike = z.string().regex(/^ver_[0-9A-Za-z]{10,40}$/)

// ---- hosts and paths (the egress allowlist reads these) ------------------------------------------------------------

/** The one host the Bearer token is ever sent to. */
export const MIRO_API_HOST = 'api.miro.com'
export const MIRO_API_ORIGIN = `https://${MIRO_API_HOST}`

/**
 * The hosts a resource answer's signed URL may point at (exact match, no suffix rule). EMPTY until the owner-run probe
 * (scripts/miro-probe.mjs, plan item R0.4) records the real one (Miro's docs do not name it; a 2023 community report
 * says `r.miro.com`, UNVERIFIED): with the list empty every file is refused (`file-host-refused`), failing closed.
 * Changing it is a reviewed contract change (AGENTS.md "Server egress exception: Miro import").
 */
export const MIRO_DOWNLOAD_HOSTS: readonly string[] = []

/** The read paths the api may ask for (path only, without the query). Anything else is refused before any request. */
export const MIRO_API_PATH_PATTERNS: readonly RegExp[] = [
  /^\/v1\/oauth-token$/,
  /^\/v2\/boards$/,
  /^\/v2\/boards\/[A-Za-z0-9_=-]{6,64}$/,
  /^\/v2\/boards\/[A-Za-z0-9_=-]{6,64}\/(items|connectors|groups|tags|members)$/,
  /^\/v2\/boards\/[A-Za-z0-9_=-]{6,64}\/resources\/(images|documents)\/[A-Za-z0-9_=-]{1,64}$/,
]

/** An item's `imageUrl` / `documentUrl` path the api rewrites to `?format=original&redirect=false` (and nothing else). */
export const MIRO_RESOURCE_PATH_PATTERN =
  /^\/v2\/boards\/[A-Za-z0-9_=-]{6,64}\/resources\/(images|documents)\/[A-Za-z0-9_=-]{1,64}$/

// ---- boards, tokens -----------------------------------------------------------------------------------------------

export const MIRO_BOARD_ID_PATTERN = /^[A-Za-z0-9_=-]{6,64}$/
export const MiroBoardId = z.string().regex(MIRO_BOARD_ID_PATTERN)

/**
 * A pasted access token's shape (checked by hand, never echoed): printable token characters only, 16 to 4,096 long.
 * Miro's tokens are opaque; this only refuses what cannot be one (spaces, quotes, newlines, a pasted URL).
 */
export const MIRO_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{16,4096}$/

/**
 * Takes `token` out of a parsed JSON body without any schema: the token (when it is a string of MIRO_TOKEN_PATTERN's
 * shape) and the rest of the body for the route's schema. The token never reaches a schema, an issue or a message.
 */
export function splitMiroToken(body: unknown): { token: string | null; rest: Record<string, unknown> } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { token: null, rest: {} }
  const { token, ...rest } = body as Record<string, unknown>
  const ok = typeof token === 'string' && MIRO_TOKEN_PATTERN.test(token)
  return { token: ok ? token : null, rest }
}

/**
 * The board id in a pasted Miro board link (`https://miro.com/app/board/<id>=/…`), or null. Only miro.com and its
 * subdomains' board links; the id must have MIRO_BOARD_ID_PATTERN's shape (the server checks it again).
 */
export function parseMiroBoardLink(raw: string): string | null {
  const url = parseUrl(raw.trim())
  if (!url || url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (host !== 'miro.com' && !host.endsWith('.miro.com')) return null
  const m = /^\/app\/board\/([^/]+)\/?/.exec(url.pathname)
  let id: string | null = null
  try {
    id = m?.[1] ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
  return id && MIRO_BOARD_ID_PATTERN.test(id) ? id : null
}

/** The item types Miro's REST API v2 returns (`unknown` is seen in practice). WS1 maps every one (a test checks). */
export const MIRO_ITEM_TYPES = [
  'text',
  'shape',
  'sticky_note',
  'image',
  'document',
  'card',
  'app_card',
  'preview',
  'frame',
  'embed',
  'doc_format',
  'data_table_format',
  'unknown',
] as const
export type MiroItemType = (typeof MIRO_ITEM_TYPES)[number]

// ---- limits -------------------------------------------------------------------------------------------------------

const GiB = 1024 * 1024 * 1024
export const MIRO_IMPORT_LIMITS = {
  itemsPerBoard: 10_000,
  connectorsPerBoard: 5_000,
  filesPerBoard: 1_000,
  fileBytesPerBoard: 2 * GiB,
  boardsPerJob: 50,
  /** the board list's page (Miro's own maximum) */
  boardsPageSize: 50,
  /** Miro's items and connectors pages */
  itemsPageSize: 50,
  /** characters of a search query in the board list */
  queryChars: 120,
  /** a title the person typed for the new board */
  titleChars: 120,
  /** one JSON answer from api.miro.com (a page of 50 items is far below it) */
  answerBytes: 4 * 1024 * 1024,
  /** one request's total time */
  requestTimeoutMs: 20_000,
  /** a file's download: the time for its whole body */
  fileTimeoutMs: 120_000,
} as const

/** Pacing toward Miro, per job (Miro: 100,000 credits a minute per user and app; Level 1 = 50, Level 2 = 100). */
export const MIRO_RATE = {
  maxRequestsPerSecond: 8,
  /** slow down when X-RateLimit-Remaining falls below this share of X-RateLimit-Limit */
  slowBelowRemaining: 0.1,
  /** a 429 is waited out until X-RateLimit-Reset, at most this long, at most `retries` times */
  maxWaitMs: 60_000,
  retries: 5,
} as const

/** The refusals and failures the dialog tells apart (with the job codes of imports.ts IMPORT_CODES). */
export const MIRO_CODES = {
  /** 400/401 from Miro: a missing, wrong or expired token (also our own shape check) */
  tokenInvalid: 'MIRO_TOKEN_INVALID',
  /** 403 from Miro: the token lacks boards:read */
  scopeMissing: 'MIRO_SCOPE_MISSING',
  /** 404 from Miro: the token's team cannot see this board */
  boardNotVisible: 'MIRO_BOARD_NOT_VISIBLE',
  /** 429 after MIRO_RATE.retries waits */
  rateLimited: 'MIRO_RATE_LIMITED',
  /** 5xx, a timeout, a refused or broken answer */
  unavailable: 'MIRO_UNAVAILABLE',
} as const

export const MIRO_CODE_MESSAGES: Readonly<Record<(typeof MIRO_CODES)[keyof typeof MIRO_CODES], string>> = {
  MIRO_TOKEN_INVALID: 'Miro did not accept that token. Copy it again from Miro (Your apps → your app).',
  MIRO_SCOPE_MISSING:
    'That token cannot read boards. In Miro, give the app the boards:read permission and reinstall it.',
  MIRO_BOARD_NOT_VISIBLE:
    'The token’s Miro team cannot see this board. Install the app in the team that holds the board.',
  MIRO_RATE_LIMITED: 'Miro asked Lobby to slow down. The import stopped; try again in a few minutes.',
  MIRO_UNAVAILABLE: 'Miro did not answer. Try again in a few minutes.',
}

// ---- requests and answers (the token is never in a schema: splitMiroToken) ------------------------------------------

/** POST …/imports/miro/boards, the body without `token`. */
export const ListMiroBoardsInput = z.strictObject({
  query: z.string().trim().max(MIRO_IMPORT_LIMITS.queryChars).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
})
export type ListMiroBoardsInput = z.infer<typeof ListMiroBoardsInput>

export const MiroBoardSummary = z.object({
  id: MiroBoardId,
  /** cleaned for display (control and bidi characters removed), at most 200 characters */
  name: z.string().max(200),
  modifiedAt: z.string().nullable(),
  /** Miro's own link to the board (shown as text, never fetched by Lobby) */
  viewLink: z.string().max(2048).nullable(),
})
export type MiroBoardSummary = z.infer<typeof MiroBoardSummary>

export const ListMiroBoardsResponse = z.object({
  /** the token's team (display name only) */
  team: z.object({ name: z.string().max(200) }),
  boards: z.array(MiroBoardSummary).max(MIRO_IMPORT_LIMITS.boardsPageSize),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
})
export type ListMiroBoardsResponse = z.infer<typeof ListMiroBoardsResponse>

/** POST …/imports/miro, the body without `token`. */
export const StartMiroImportInput = z.strictObject({
  boards: z
    .array(
      z.strictObject({
        miroBoardId: MiroBoardId,
        title: z.string().trim().min(1).max(MIRO_IMPORT_LIMITS.titleChars).optional(),
      }),
    )
    .min(1)
    .max(MIRO_IMPORT_LIMITS.boardsPerJob)
    .refine((b) => new Set(b.map((x) => x.miroBoardId)).size === b.length, 'each board once'),
  projectId: ProjectIdLike.nullable().optional(),
  /** an uploaded PDF (Miro's own export) placed beside the content as a locked reference */
  referencePdf: VersionIdLike.optional(),
})
export type StartMiroImportInput = z.infer<typeof StartMiroImportInput>

// ---- routes --------------------------------------------------------------------------------------------------------

export const MIRO_IMPORT_ROUTES = {
  boards: '/api/workspaces/:wid/imports/miro/boards',
  start: '/api/workspaces/:wid/imports/miro',
} as const
export const MIRO_IMPORT_ROUTE_KEYS = [
  `POST ${MIRO_IMPORT_ROUTES.boards}`,
  `POST ${MIRO_IMPORT_ROUTES.start}`,
] as const
export type MiroImportRouteKey = (typeof MIRO_IMPORT_ROUTE_KEYS)[number]
/** Both are a creator's ('always', purpose create): listing a team's boards is the first step of creating boards. */
export const MIRO_IMPORT_CREATOR_ROUTE_KEYS: readonly MiroImportRouteKey[] = MIRO_IMPORT_ROUTE_KEYS

const enc = encodeURIComponent
export const miroBoardsPath = (wid: string) => `/api/workspaces/${enc(wid)}/imports/miro/boards`
export const miroImportPath = (wid: string) => `/api/workspaces/${enc(wid)}/imports/miro`
