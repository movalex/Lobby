// Feature module: dashboard-share (docs/FEATURES-M2-CONTRACTS.md). Starred boards, access requests,
// review links + invitation listing, the sharing state and transfer of ownership.
import type { FastifyInstance } from 'fastify'
import type { FeatureContext } from '../context.ts'
import { registerAccessRequestRoutes } from './access-requests.ts'
import { registerReviewLinkRoutes } from './review-links.ts'
import { registerSharingRoutes } from './sharing.ts'
import { registerStarRoutes } from './stars.ts'

export async function registerDashboard(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  registerStarRoutes(app, ctx)
  registerAccessRequestRoutes(app, ctx)
  registerReviewLinkRoutes(app, ctx)
  registerSharingRoutes(app, ctx)
}
