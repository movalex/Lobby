// OWNER: WS4 (wave N, since your last visit; a stub landed by the wave N foundation). Private visit markers
// (@draftroom/contracts visits.ts; migration 0031_board_visits):
//
//   POST /api/boards/:bid/visit       → 200 VisitAnswer   (view access; the session's own row only; no guests)
//   POST /api/boards/:bid/visit/seen  → 204               (sendBeacon on pagehide and "Mark all seen")
//
// Nobody else ever sees who visited when: no route reads another person's row, and no log, export or usage counter
// carries a visit time. The guest rows are in place (guests/guard.ts GUEST_REFUSED_ROUTES). Pending
// (../pending-routes.ts): neither is registered until WS4 implements them, so they answer 404 NOT_FOUND like any
// unknown route, and the web's fetchVisit() answers null (the chip stays hidden).

import { VISIT_ROUTE, VISIT_SEEN_ROUTE } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { routeUnlessPending } from '../pending-routes.ts'

export async function registerVisits(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  routeUnlessPending(app, 'POST', VISIT_ROUTE, stub)
  routeUnlessPending(app, 'POST', VISIT_SEEN_ROUTE, stub)
}
