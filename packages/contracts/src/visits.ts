// "Since your last visit" (wave N, LM-9; OWNER: WS4, landed by the wave N foundation). Private, per-person visit
// markers (migration 0031_board_visits). The owner's condition: nobody else ever sees who visited when, and there
// are no read receipts. So:
//  - only the person's own row is ever read (no route, list, export, usage counter or log line carries a visit time);
//  - a name-only guest is refused (403 GUEST_ACCOUNT_REQUIRED) and keeps the device-local "Catch me up" window;
//  - rows older than DRAFTROOM_VISITS_RETENTION_DAYS are deleted by the sweeper; a board or account deletion cascades.
//
//   POST /api/boards/:bid/visit       (no body) → 200 VisitAnswer   view access; one UPSERT, the previous time back
//   POST /api/boards/:bid/visit/seen  (no body) → 204               sendBeacon on pagehide, and "Mark all seen"
//
// At most one write per VISIT_WRITE_MIN_INTERVAL_MS per (person, board): a faster call answers 200 with the stored
// times (visit) or 204 (seen) and writes nothing. Until WS4 implements them both routes are pending (the api answers
// 404 NOT_FOUND like any unknown route), and the web's fetchVisit() answers null (features/visits/client.ts), so the
// chip stays hidden.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'

export const VISIT_ROUTE = '/api/boards/:bid/visit'
export const VISIT_SEEN_ROUTE = '/api/boards/:bid/visit/seen'
export const visitPath = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}/visit`
export const visitSeenPath = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}/visit/seen`

/** One write per (person, board) per this long; a faster call writes nothing. */
export const VISIT_WRITE_MIN_INTERVAL_MS = 10_000
/** DRAFTROOM_VISITS_RETENTION_DAYS when unset: rows older than this are deleted. */
export const VISITS_RETENTION_DAYS_DEFAULT = 180
/** The most outlines the highlights draw at once (the rest are counted in the chip). */
export const VISIT_HIGHLIGHT_MAX_OUTLINES = 200
/** The outlines fade after this long, or on "Mark all seen". */
export const VISIT_HIGHLIGHT_FADE_MS = 15_000

const EpochMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/**
 * POST /api/boards/:bid/visit: the caller's own previous visit time (ms since the epoch; null on a first visit) and
 * the time just stored. Never anyone else's.
 */
export const VisitAnswer = z.strictObject({
  previousSeenAt: EpochMs.nullable(),
  seenAt: EpochMs,
})
export type VisitAnswer = z.infer<typeof VisitAnswer>
