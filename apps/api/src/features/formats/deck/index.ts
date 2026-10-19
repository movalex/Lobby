// OWNER: WS4 (wave W, deck import; the stub landed by the wave W foundation). docs/WAVE-W-CONTRACTS.md §6.
//
//   POST /api/files/:ver/render-pages {boardId}   → 202 FileOpState   edit + an account   W4-1
//
// What WS4 builds here: the switch (formatsRoute's gate) AND a worker with WORKER_CAPABILITIES['render-pages'] seen
// recently (else 404); requireBoardAction(edit) with an account (the guest guard refused name-only guests); the version
// is served on that board, kind pdf (PDF, PPTX, ODP), `ready`, with probe.pageCount > DECK_LIMITS.eagerPages (else 409
// NOTHING_TO_RENDER); one op per deckRenderRuns(pageCount) run (params {from, to}, params_key `${from}-${to}`), all in
// one transaction; 202 with the FIRST op's state (the web follows each by its file.op events). Its completer
// (`renderPagesKind` in ./kind.ts, registered in ../../../worker/ops-kinds.ts) turns the op's page outputs into
// asset_derivatives rows of the SOURCE version (role page, after the existing positions), under the version's row lock
// and skipping pages that already have a row (no unique index guards it: §12 departure 5), so a re-run is idempotent.
// Pending (../../pending-routes.ts) until WS4 implements it.

import { FORMAT_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../../pending-routes.ts'
import { type FormatSwitchSource, formatsRoute, formatsStub } from '../switch.ts'

export async function registerDeckImport(
  app: FastifyInstance,
  ctx: FormatSwitchSource,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  const [method, url] = FORMAT_ROUTE_KEYS.renderPages.split(' ') as [PendingMethod, string]
  formatsRoute(app, ctx, 'deckImport', method, url, formatsStub, pending)
}
