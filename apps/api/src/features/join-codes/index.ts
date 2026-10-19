// OWNER: WS3 (wave V, join codes; stubs landed by the wave V foundation). The routes (@draftroom/contracts
// join-codes.ts; migration 0038_live_sessions invitations.join_code_*; docs/WAVE-V-CONTRACTS.md §3):
//
//   POST /api/boards/:bid/review-links/:id/code   a workshop link's code (made on first ask; idempotent)   creator  V2-1
//   GET  /api/join/:code                          the link's token for /invite/:token (no session)        anyone   V2-2
//
// What WS3 builds here: the code (JOIN_CODE_HMAC_LABEL under a key from the ticket secret, `${id}:${n}`, the first 40
// bits; join_code_n bumped on a unique-index collision), its sha256 in invitations.join_code_hash, the same 404 for an
// unknown, malformed, expired and revoked code, the lookup limits (JOIN_CODE_LOOKUPS_PER_ADDRESS, _GLOBAL; 429), the
// joinCode lines of features/dashboard/review-links.ts (ReviewLinkCreated / PendingInvitation .joinCode, for people who
// may manage access) and the join-cap fix in features/guests/join.ts (contracts guests.ts GUEST_JOINS_*WORKSHOP*).
// The guard rows are in place: a guest is refused the create route (guests/guard.ts INVITE) and it needs a creator
// (domain-access/guard.ts: share, always); the resolve route has no row (anyone with the code). Pending
// (../pending-routes.ts) until WS3 implements them; once registered, DRAFTROOM_JOIN_CODES gates both (../live/switch.ts
// liveRoute: 404 as an unknown route while off).

import { JOIN_CODE_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { type LiveSwitchSource, liveRoute, liveStub } from '../live/switch.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'

export async function registerJoinCodes(
  app: FastifyInstance,
  ctx: LiveSwitchSource,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  for (const key of JOIN_CODE_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    liveRoute(app, ctx, 'joinCodes', method, url, liveStub, pending)
  }
}
