// Wave M foundation (and wave N's, Q's, R's, S's and V's, the same way): the routes a wave adds, landed as contracts, guard rows and stub handlers BEFORE their owners
// implement them. OWNER: W5 (the guard lists and matrices are W5's after the foundation).
//
// A pending route is NOT registered: its path answers exactly as any unknown route does today (the root 404
// NOT_FOUND, whoever asks, with or without a session or the internal secret), so the branch deploys with no
// behaviour change and an old web or sync sees the 404 its downgrade path expects. The guard rows for it
// (domain-access/guard.ts CREATOR_ROUTES, guests/guard.ts GUEST_REFUSED_ROUTES) are already in place; the
// matrices (test/features/guests/refusals.test.ts, test/features/domain-access/creation-matrix.test.ts) check a
// pending row as "not registered, answers like an unknown route", and as a guarded route once it is not pending.
//
// To implement one: write the handler where the stub is (each stub names its file), and delete the route's entry
// below in the same change. The matrices then hold it to its guard rows.

import type { FastifyInstance, RouteHandlerMethod } from 'fastify'

export type PendingOwner = 'W5' | 'W7' | 'W8' | 'WS1' | 'WS2' | 'WS3' | 'WS4' | 'WS5' | 'WS7'

export interface PendingRoute {
  /** the workstream that implements it */
  owner: PendingOwner
  /** the plan item */
  item: string
}

/** `METHOD route-pattern` (the guard lists' key format) → who implements it. */
export const PENDING_ROUTES: Readonly<Record<string, PendingRoute>> = {
  // wave M: none left: W5 (open-state M5-1, usage M5-5, /healthz/deep M5-6), W7 (POST /internal/access-many M7-1)
  // and W8 (Ask across boards M8-2, the workspace templates M8-3) are implemented. To ship a route hidden, add its
  // key back.
  // wave N: none left. WS4's visit routes (N4-1, features/visits), WS5's three capture routes (N5-1,
  // features/ai/capture.ts) and WS7's board-cards (N7-2) and backlinks (N7-4) are implemented; to ship one hidden,
  // add its key back.
  // wave Q: none left. WS2 implemented the element library's 16 routes (@draftroom/contracts LIBRARY_ROUTE_KEYS,
  // features/library: Q2-1 list and read, Q2-2 save/change/delete/restore, Q2-3 place and thumbs, Q2-4 import, Q2-5
  // folders, Q2-6 marks); to ship one hidden, add its key back.
  // wave R (the foundation; docs/WAVE-R-CONTRACTS.md §1): every route of the wave, @draftroom/contracts
  // IMPORT_ROUTE_KEYS, MIRO_IMPORT_ROUTE_KEYS, CHAT_HOOK_ROUTE_KEYS and BACKUP_ROUTE_KEYS: none left. WS1 implemented
  // its eight (the job routes R1-4, features/imports/routes.ts; the Miro routes R1-1, R1-2, features/imports/miro), WS2
  // its seven chat hook routes (R2-1 hooks, R2-2 test, R2-3 preferences; features/chat-hooks) and WS4 the three backup
  // routes (R4-1 download, R4-2 restore; features/backup); to ship one hidden, add its key back.
  // wave S (the foundation; docs/WAVE-S-CONTRACTS.md §1): every route of the wave, @draftroom/contracts
  // REVIEW_ROUTE_KEYS (WS1: S1-1 items, S1-2 status and history, S1-3 rounds; features/review) and
  // ASSET_VERSION_ROUTE_KEYS (WS2: S2-1 the version list; files/versions.ts): none left. WS3 and WS4 add no route. WS1
  // implemented its eight review routes (S1-1 items, S1-2 status and history, S1-3 rounds; features/review) and WS2 the
  // version list: to ship one hidden, add its key back.
  // wave V (the foundation; docs/WAVE-V-CONTRACTS.md §1): every route of the wave, @draftroom/contracts
  // ACTIVITY_ROUTE_KEYS (WS1: V1-1 start, state and answer; V1-2 close, reveal, extend, cancel, results, named answers;
  // V1-3 hide, placed, the past list; features/live-activities), JOIN_CODE_ROUTE_KEYS (WS3: V2-1 a link's code, V2-2
  // resolve; features/join-codes) and BREAKOUT_ROUTE_KEYS (WS4: V3-1 start, state, extend, end; V3-2 assign, shuffle,
  // join; V3-3 broadcast, summon; features/breakouts). Once implemented, each is gated by its kill switch as well.
  // WS1's twelve activity routes are implemented (features/live-activities); to ship one hidden, add its key back.
  // WS3 implemented its two (V2-1 a link's code, V2-2 resolve; features/join-codes): to ship one hidden, add its key back.
  // WS4 implemented its nine (V3-1 start, state, extend, end; V3-2 assign, shuffle, join; V3-3 broadcast, summon;
  // features/breakouts): none left in wave V. To ship one hidden, add its key back.
  // wave W (the foundation; docs/WAVE-W-CONTRACTS.md §1): every browser route of the wave, @draftroom/contracts
  // FORMAT_ROUTE_KEYS (WS2: W2-1 remove a background, W2-2 an op's state and cancel; WS4: W4-1 render a deck's pages;
  // features/formats) and ADMIN_ROUTE_KEYS (WS5: W5-1 members and invitations, W5-2 storage, W5-3 audit, W5-4 links,
  // W5-5 retention; features/workspace-admin). Once implemented, each is gated by its kill switch as well. The worker
  // routes (/api/worker/ops/*, worker/ops-routes.ts) are not on this list: they are the worker protocol, live from the
  // foundation, and hand out nothing until a browser route queues an op.
  // WS2 implemented its three (W2-1 remove a background, W2-2 an op's state and cancel; features/formats/remove-bg and
  // ops): to ship one hidden, add its key back.
  // WS4 implemented W4-1 (render a deck's pages, features/formats/deck): to ship it hidden, add its key back.
  'GET /api/workspaces/:wid/admin/members': { owner: 'WS5', item: 'W5-1' },
  'GET /api/workspaces/:wid/admin/invitations': { owner: 'WS5', item: 'W5-1' },
  'GET /api/workspaces/:wid/admin/storage/by-board': { owner: 'WS5', item: 'W5-2' },
  'GET /api/workspaces/:wid/admin/storage/by-uploader': { owner: 'WS5', item: 'W5-2' },
  'GET /api/workspaces/:wid/admin/audit': { owner: 'WS5', item: 'W5-3' },
  'GET /api/workspaces/:wid/admin/links': { owner: 'WS5', item: 'W5-4' },
  'GET /api/workspaces/:wid/admin/retention': { owner: 'WS5', item: 'W5-5' },
}

export const isPendingRoute = (
  key: string,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
) => Object.hasOwn(pending, key)

export type PendingMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Registers `handler` for `method url`, unless that route is pending (then nothing is registered and the path
 * stays an unknown route). Returns whether it registered. `pending` is for tests of this helper.
 */
export function routeUnlessPending(
  app: FastifyInstance,
  method: PendingMethod,
  url: string,
  handler: RouteHandlerMethod,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): boolean {
  if (isPendingRoute(`${method} ${url}`, pending)) return false
  app.route({ method, url, handler })
  return true
}
