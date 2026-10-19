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
// without it never calls it.
//
// Every part is decided on its own: a caller who may not view the board (or a malformed or unknown board id) gets
// 200 with every part null, the same answer whatever the id, so the route reveals nothing its parts' routes would
// not (their 404s). A server error fails the whole answer (the web then makes the separate reads).
//
// Events (M5-1): the body also carries `eventsSeq`, where the board's events stood just before the parts were
// read (apps/api/src/events/hub.ts boardPosition). The board's event stream says where they stand in every hello
// (`data.eventsSeq`), and each delivered event's `seq` is the board's position after it. Positions only move
// forward: while the answer's is at or after every position the stream has shown (same process), it holds everything
// the page has heard of, and a feature's first fetch may take its part; otherwise the feature reads its own route. A
// part is for its feature's first fetch only (apps/web/src/lib/open-state.ts).
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { AiStatus } from './ai.ts'
import { BreakoutState } from './breakouts.ts'
import { ListThreadsResponse } from './comments.ts'
import { ShareState } from './dashboard.ts'
import { ExportPolicyState } from './export-control.ts'
import { ActivityState } from './live-activities.ts'
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
  /**
   * Wave V (docs/WAVE-V-CONTRACTS.md §5): GET /api/boards/:bid/activity (WS1) and GET /api/boards/:bid/breakouts (WS4).
   * Optional. The foundation declared them pending (OPEN_STATE_PENDING_PARTS); since the integration both are in
   * OPEN_STATE_PARTS, answered by the loader of their own route. An api before wave V,
   * or with the feature's switch off (the loader then refuses with a 404: null), sends none, and the web makes the
   * separate read only while the switch is on (AuthConfig.live).
   */
  get activity() {
    return ActivityState.nullable().optional()
  },
  get breakouts() {
    return BreakoutState.nullable().optional()
  },
})
export type OpenState = z.infer<typeof OpenState>

export type OpenStatePart = keyof OpenState
/** `<process>.<seq>`: OpenStateBody.eventsSeq and the board stream hello's `data.eventsSeq`. */
export const OPEN_STATE_EVENTS_SEQ_PATTERN = /^[0-9a-f]{8}\.\d{1,15}$/
/**
 * The route's 200 body: the parts (OpenState) and `eventsSeq`. Lazy: OpenState's fields are getters (see above), so
 * it is built at the first parse, when every module exists.
 */
export const OpenStateBody = z.lazy(() =>
  OpenState.extend({ eventsSeq: z.string().regex(OPEN_STATE_EVENTS_SEQ_PATTERN).optional() }),
)
export type OpenStateBody = OpenState & { eventsSeq?: string }
export const OPEN_STATE_PARTS = [
  'exportPolicy',
  'outside',
  'sharing',
  'workshop',
  'presentation',
  'privateBrainstorm',
  'threads',
  'ai',
  // wave V (the integration): WS1 answers 'activity' and WS4 'breakouts' (each null while its switch is off)
  'activity',
  'breakouts',
] as const satisfies readonly OpenStatePart[]
/**
 * Parts declared in OpenState but not answered yet (see OpenState.activity): their owners move them above. Empty since
 * the wave V integration moved 'activity' and 'breakouts'; a later wave may declare a part pending here again.
 */
export const OPEN_STATE_PENDING_PARTS = [] as const satisfies readonly OpenStatePart[]
