// OWNER: W5 (wave M, M5-5; a stub landed by the wave M foundation). Privacy-safe usage counters:
//
//   POST /api/usage            UsageBatch → 204 (a session or a guest's; capped per event, a guest at 10; one
//                              batch a minute per session or guest token, else 429; an unknown event 400)
//   GET  /internal/usage?days= → 200 InternalUsageResponse (internal secret: app.ts registerInternalSecretGuard)
//
// Rows go to usage_daily(day, event, role_class, count) (migration 0029_usage_daily). No user id, board id or
// content is stored or logged. Pending (../pending-routes.ts): neither route is registered until W5 implements
// them, so both answer 404 NOT_FOUND like any unknown route (and the web's countUsage only counts in memory).

import { INTERNAL_USAGE_ROUTE, USAGE_ROUTE } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { routeUnlessPending } from '../pending-routes.ts'

export async function registerUsage(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  routeUnlessPending(app, 'POST', USAGE_ROUTE, stub)
  routeUnlessPending(app, 'GET', INTERNAL_USAGE_ROUTE, stub)
}
