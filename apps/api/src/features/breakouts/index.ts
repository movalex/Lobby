// OWNER: WS4 (wave V, breakouts; stubs landed by the wave V foundation). The routes (@draftroom/contracts
// breakouts.ts; migration 0038_live_sessions; docs/WAVE-V-CONTRACTS.md §4):
//
//   GET  /api/boards/:bid/breakouts         the running (or recent) session, members, the caller's group   view         V3-1
//   POST /api/boards/:bid/breakouts         start (groups from frames; auto, manual or choose)            facilitate   V3-1
//   POST /api/breakouts/:brk/assign         move people                                                    manage       V3-2
//   POST /api/breakouts/:brk/shuffle        deal everyone out again                                        manage       V3-2
//   POST /api/breakouts/:brk/join           choose one's group (choose mode)                               participate  V3-2
//   POST /api/breakouts/:brk/extend         add time                                                       manage       V3-1
//   POST /api/breakouts/:brk/broadcast      a line to everyone or to one group (never stored)              manage       V3-3
//   POST /api/breakouts/:brk/summon         bring one group to the caller                                  manage       V3-3
//   POST /api/breakouts/:brk/end            end                                                            manage       V3-1
//
// What WS4 builds here: the routes, the store (the session row FOR UPDATE; rev + 1 per change), auto assignment over
// hub.streams() (facilitators left out; a late joiner to the smallest group under the session lock), the 409s with a
// live presentation or a spotlight, and the events: WORKSHOP_EVENTS.breakout to everyone, .breakoutBroadcast and
// .breakoutSummon of one group with hub.publish(bid, ev, {to: uid => members.has(uid)}) ONLY (the leak test), and the
// open-state part ('breakouts': moved from OPEN_STATE_PENDING_PARTS to OPEN_STATE_PARTS through the lead). Every new
// query names `status IN ('active', 'archived')`. The guard rows are in place (guests/guard.ts: the seven
// facilitate/manage routes); no creator row. Pending (../pending-routes.ts): none is registered until WS4 implements it;
// once registered, DRAFTROOM_BREAKOUTS gates it (../live/switch.ts liveRoute).

import { BREAKOUT_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { type LiveSwitchSource, liveRoute, liveStub } from '../live/switch.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'

export async function registerBreakouts(
  app: FastifyInstance,
  ctx: LiveSwitchSource,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  for (const key of BREAKOUT_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    liveRoute(app, ctx, 'breakouts', method, url, liveStub, pending)
  }
}
