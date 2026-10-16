// OWNER: WS1 (wave S, review status; stubs landed by the wave S foundation). The review routes (@draftroom/contracts
// review.ts; migration 0037_client_review; docs/WAVE-S-CONTRACTS.md §2):
//
//   GET    /api/boards/:bid/review                           items, rounds, the open round, what the caller may do  S1-1
//   POST   /api/boards/:bid/review/items                     mark an element for review                            S1-1
//   PATCH  /api/boards/:bid/review/items/:rvi                label, position                                       S1-1
//   DELETE /api/boards/:bid/review/items/:rvi                remove from review (soft)                             S1-1
//   POST   /api/boards/:bid/review/items/:rvi/status         set a status (with an optional note thread)           S1-2
//   GET    /api/boards/:bid/review/items/:rvi/events         the history, 50 a page                                S1-2
//   POST   /api/boards/:bid/review/rounds                    start a round (resets, a named checkpoint)            S1-3
//   POST   /api/boards/:bid/review/rounds/:rvr/close         close it                                              S1-3
//
// What WS1 builds here: the routes, the store (the item row FOR UPDATE, the event, the note thread through the comments
// store, the notifications and enqueueChatDeliveries in the same transaction; board events REVIEW_ITEM_EVENT and
// REVIEW_ROUND_EVENT after COMMIT), and ./hooks.ts resetForNewVersion (WS2's upload calls it). The rules are
// REVIEW_RULES with @draftroom/permissions canSetReviewStatus / canManageReview; the actor is the session's user and
// its kind is read from users.kind in the write's transaction. Every new query names `status IN ('active', 'archived')`
// (the importing-board tripwire). The guard rows are in place: a name-only guest is refused the five manage routes
// (guests/guard.ts, REVIEW_GUESTS_MESSAGE) and may still set a status on a commenter link; no route has a creator row.
// Pending (../pending-routes.ts): none is registered until WS1 implements it.

import { REVIEW_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { type PendingMethod, routeUnlessPending } from '../pending-routes.ts'

export async function registerReview(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  for (const key of REVIEW_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    routeUnlessPending(app, method, url, stub)
  }
}
