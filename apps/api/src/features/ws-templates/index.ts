// OWNER: W8 (wave M, M8-3; a stub landed by the wave M foundation). Workspace templates:
//
//   GET    /api/workspaces/:wid/templates            → ListWorkspaceTemplatesResponse (members, no guests)
//   POST   /api/workspaces/:wid/templates            AddWorkspaceTemplateInput → 201 (a creator who is an admin)
//   DELETE /api/workspaces/:wid/templates/:bid       → 204 (the same)
//   POST   /api/workspaces/:wid/templates/:bid/use   UseWorkspaceTemplateInput → 201 HistoryBoardCreated
//                                                    (a member who is a creator; createBoardFrom, the template's
//                                                    grants never copied; under the workspace row lock)
//
// Rows in workspace_templates (migration 0030_workspace_templates). The guard rows are in place
// (domain-access/guard.ts CREATOR_ROUTES, guests/guard.ts GUEST_REFUSED_ROUTES). Pending (../pending-routes.ts):
// none is registered until W8 implements them, so they answer 404 NOT_FOUND like any unknown route.

import { WS_TEMPLATE_ROUTE, WS_TEMPLATE_USE_ROUTE, WS_TEMPLATES_ROUTE } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { routeUnlessPending } from '../pending-routes.ts'

export async function registerWsTemplates(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  routeUnlessPending(app, 'GET', WS_TEMPLATES_ROUTE, stub)
  routeUnlessPending(app, 'POST', WS_TEMPLATES_ROUTE, stub)
  routeUnlessPending(app, 'DELETE', WS_TEMPLATE_ROUTE, stub)
  routeUnlessPending(app, 'POST', WS_TEMPLATE_USE_ROUTE, stub)
}
