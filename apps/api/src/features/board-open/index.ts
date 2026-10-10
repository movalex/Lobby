// OWNER: W5 (wave M, M5-1; a stub landed by the wave M foundation). One read for the board-open burst:
//
//   GET /api/boards/:bid/open-state → 200 OpenState (@draftroom/contracts board-open.ts), Cache-Control: no-store
//
// One session lookup and one loadBoardAccess, then each part built by the same load* function its own route uses,
// sequentially on one pooled client in one READ ONLY transaction; a part this caller may not read is null (the
// AI part through features/ai loadAiStatus, W8's). Pending (../pending-routes.ts): not registered until W5
// implements it, so the path answers 404 NOT_FOUND like any unknown route and the web makes its separate reads.

import { OPEN_STATE_ROUTE } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { routeUnlessPending } from '../pending-routes.ts'

export async function registerBoardOpen(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  // the stub handler (reached only if the route stops being pending before it is implemented): an unknown route's answer
  routeUnlessPending(app, 'GET', OPEN_STATE_ROUTE, async () => {
    throw notFound()
  })
}
