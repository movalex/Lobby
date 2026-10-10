// One read for the board-open burst (wave M, S4 / PWR-8 / CAP-PG-OPEN, M5-1). OWNER: W5 (frozen by the wave
// M foundation; packages/contracts is W5's after it).
//
//   GET /api/boards/:bid/open-state → 200 OpenState (Cache-Control: no-store)
//
// The panel reads a board page fires when it opens (export policy, the outside summary, sharing, the
// workshop, the live presentation, the private brainstorm, the comment threads and the AI status), answered
// together after one session lookup and one access check. Each part is exactly the body of that part's own
// route for the same caller (its schema below is that route's), or null when this caller may not read it:
// a refused part is never an error, and never a hint of why.
//
// Downgrade: an api without the route answers 404 (the web then makes the separate reads, as today); a web
// without it never calls it. Until W5 implements it the route is not registered (404 NOT_FOUND).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { AiStatus } from './ai.ts'
import { ListThreadsResponse } from './comments.ts'
import { ShareState } from './dashboard.ts'
import { ExportPolicyState } from './export-control.ts'
import { BoardOutsidePeople } from './outside.ts'
import { PresentLiveState } from './present-live.ts'
import { PrivateBrainstormState, WorkshopState } from './workshops.ts'

export const OPEN_STATE_ROUTE = '/api/boards/:bid/open-state'
export const openStatePath = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}/open-state`

/** How long the web keeps an answer for the board's features to take (apps/web/src/lib/open-state.ts). */
export const OPEN_STATE_TTL_MS = 10_000

/**
 * The parts, each the body of its own route:
 *   exportPolicy       GET /api/boards/:bid/export-policy        (W5)
 *   outside            GET /api/boards/:bid/sharing/outside      (W5)
 *   sharing            GET /api/boards/:bid/sharing              (W5)
 *   workshop           GET /api/boards/:bid/workshop             (W2's first fetch)
 *   presentation       GET /api/boards/:bid/presentation         (W2's first fetch)
 *   privateBrainstorm  GET /api/boards/:bid/private-brainstorm   (W2's first fetch)
 *   threads            GET /api/boards/:bid/threads?status=all   (W5, the comments feature)
 *   ai                 GET /api/boards/:bid/ai                   (W4's first fetch; loadAiStatus, W8)
 */
// Getters (zod's lazy fields): dashboard.ts imports ./index.ts, which re-exports this module, so ShareState
// may not exist yet while this module is evaluated (the same pattern as dashboard.ts's own getters).
export const OpenState = z.object({
  get exportPolicy() {
    return ExportPolicyState.nullable()
  },
  get outside() {
    return BoardOutsidePeople.nullable()
  },
  get sharing() {
    return ShareState.nullable()
  },
  get workshop() {
    return WorkshopState.nullable()
  },
  get presentation() {
    return PresentLiveState.nullable()
  },
  get privateBrainstorm() {
    return PrivateBrainstormState.nullable()
  },
  get threads() {
    return ListThreadsResponse.nullable()
  },
  get ai() {
    return AiStatus.nullable()
  },
})
export type OpenState = z.infer<typeof OpenState>

export type OpenStatePart = keyof OpenState
export const OPEN_STATE_PARTS = [
  'exportPolicy',
  'outside',
  'sharing',
  'workshop',
  'presentation',
  'privateBrainstorm',
  'threads',
  'ai',
] as const satisfies readonly OpenStatePart[]
