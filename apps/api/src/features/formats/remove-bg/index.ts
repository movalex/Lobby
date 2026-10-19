// OWNER: WS2 (wave W, background removal; the stub landed by the wave W foundation). docs/WAVE-W-CONTRACTS.md §4.
//
//   POST /api/files/:ver/remove-background {boardId}   → 202 FileOpState   edit + an account   W2-1
//
// What WS2 builds here, in this order of checks: the switch (formatsRoute's gate) AND a worker with
// WORKER_CAPABILITIES['remove-bg'] seen within WORKER_OP_LIMITS.capabilityFreshMs (else 404, like the switch);
// requireBoardAction(edit) with an account (the guest guard already refused name-only guests: FORMAT_GUESTS_MESSAGE);
// the version is served on that board (files-auth.ts), kind image, a REMOVE_BG_LIMITS.inputMimeTypes type, `ready`, and
// within the size and pixel limits; quota room (checkRoom); the per-user and per-workspace windows (429 FILE_OP_LIMIT);
// then the worker_ops row (kind remove-bg, params {}, params_key '-'; 409 FILE_OP_ACTIVE on worker_ops_active_idx).
// Its completer (`removeBgKind` in ./kind.ts, registered in ../../../worker/ops-kinds.ts) writes the NEW asset and
// version (derived_from_version_id = the source, name noBackgroundName, uploaded_by = the requester) and its
// preview_jobs row in the op's complete transaction, re-checking the quota, then publishes FILE_OP_EVENT to the
// requester only. Pending (../../pending-routes.ts) until WS2 implements it.

import { FORMAT_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../../pending-routes.ts'
import { type FormatSwitchSource, formatsRoute, formatsStub } from '../switch.ts'

export async function registerRemoveBackground(
  app: FastifyInstance,
  ctx: FormatSwitchSource,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  const [method, url] = FORMAT_ROUTE_KEYS.removeBackground.split(' ') as [PendingMethod, string]
  formatsRoute(app, ctx, 'removeBackground', method, url, formatsStub, pending)
}
