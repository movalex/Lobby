// OWNER: WS1 (wave V, live activities: polls, scales, word clouds; stubs landed by the wave V foundation). The routes
// (@draftroom/contracts live-activities.ts; migration 0038_live_sessions; docs/WAVE-V-CONTRACTS.md §2):
//
//   GET  /api/boards/:bid/activity          the current (or last) activity, the caller's own answer      view         V1-1
//   GET  /api/boards/:bid/activities        past activities, aggregates only (the session summary)       view         V1-3
//   POST /api/boards/:bid/activities        start one                                                     facilitate   V1-1
//   POST /api/activities/:aid/answer        answer, or change one's answer                                participate  V1-1
//   POST /api/activities/:aid/close         close                                                         manage       V1-2
//   POST /api/activities/:aid/reveal        reveal (freezes the results; an anonymous one's answers go)   manage       V1-2
//   POST /api/activities/:aid/extend        add time                                                      manage       V1-2
//   POST /api/activities/:aid/cancel        cancel (no results; an anonymous one's answers go)            manage       V1-2
//   POST /api/activities/:aid/hide          hide or show a word of a cloud                                manage       V1-3
//   POST /api/activities/:aid/placed        the facilitator's client placed the results                   manage       V1-3
//   GET  /api/activities/:aid/results       results: revealed (view), or open/closed (manage)            view         V1-2
//   GET  /api/activities/:aid/answers       a NAMED activity's answers after the reveal                  manage       V1-2
//
// What WS1 builds here: the routes, the store (the activity row FOR UPDATE, one upsert per answer, a tally mark taken
// under the lock), the tally window (its own copy in ./tally.ts; workshops/vote-tally.ts stays as it is), the
// starter-left rule, the events after COMMIT (WORKSHOP_EVENTS.activity, .activityResults), the open-state part
// ('activity': moved from OPEN_STATE_PENDING_PARTS to OPEN_STATE_PARTS through the lead), and the 200-participant NAS
// load test. Every new query names `status IN ('active', 'archived')` (the importing-board tripwire). The guard rows are
// in place (guests/guard.ts: the eight facilitate/manage routes, LIVE_FACILITATE_GUESTS_MESSAGE); no creator row.
// Pending (../pending-routes.ts): none is registered until WS1 implements it; once registered, the switch
// (DRAFTROOM_LIVE_ACTIVITIES) gates it (../live/switch.ts liveRoute: 404 as an unknown route while off).

import { ACTIVITY_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { type LiveSwitchSource, liveRoute, liveStub } from '../live/switch.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'

export async function registerLiveActivities(
  app: FastifyInstance,
  ctx: LiveSwitchSource,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  for (const key of ACTIVITY_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    liveRoute(app, ctx, 'activities', method, url, liveStub, pending)
  }
}
