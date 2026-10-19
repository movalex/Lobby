// OWNER: WS2 (wave W; the stubs landed by the wave W foundation; WS4 uses them as they are). docs/WAVE-W-CONTRACTS.md §3.
//
//   GET  /api/file-ops/:op          → FileOpState   the requester only (404 for anyone else)   W2-2
//   POST /api/file-ops/:op/cancel   → FileOpState   the requester only; queued only (running: 409)  W2-2
//
// Open while DRAFTROOM_REMOVE_BACKGROUND or DRAFTROOM_DECK_IMPORT is on (the gate); the handler then answers 404 for an
// op whose own kind's switch is off, so a kind that is off is an unknown op. extract-text ops (no requester) are
// never visible here. Pending (../../pending-routes.ts) until WS2 implements them.

import { FORMAT_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../../pending-routes.ts'
import { type FormatSwitchSource, formatsRoute, formatsStub } from '../switch.ts'

/** The switches of the op kinds a person can request (any one on opens the op routes). */
export const REQUESTABLE_OP_SWITCHES = ['removeBackground', 'deckImport'] as const

export async function registerFileOps(
  app: FastifyInstance,
  ctx: FormatSwitchSource,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  for (const key of [FORMAT_ROUTE_KEYS.opState, FORMAT_ROUTE_KEYS.opCancel]) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    formatsRoute(app, ctx, REQUESTABLE_OP_SWITCHES, method, url, formatsStub, pending)
  }
}
