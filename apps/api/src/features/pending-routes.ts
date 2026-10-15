// Wave M foundation (and wave N's and wave Q's, the same way): the routes a wave adds, landed as contracts, guard rows and stub handlers BEFORE their owners
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

export type PendingOwner = 'W5' | 'W7' | 'W8' | 'WS2' | 'WS4' | 'WS5' | 'WS7'

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
  // wave Q: none left. WS2 implemented the element library's 15 routes (@draftroom/contracts LIBRARY_ROUTE_KEYS,
  // features/library: Q2-1 list and read, Q2-2 save/change/delete/restore, Q2-3 place and thumbs, Q2-4 import, Q2-5
  // folders, Q2-6 marks); to ship one hidden, add its key back.
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
