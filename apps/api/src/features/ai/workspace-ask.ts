// OWNER: W8 (wave M, M8-2; a stub landed by the wave M foundation). Ask across boards:
//
//   POST /api/workspaces/:wid/ai/ask  WorkspaceAskRequest → 200 WorkspaceAskResponse (@draftroom/contracts ai.ts)
//
// requireWorkspaceRole member or higher; guests refused before any read (guests/guard.ts GUEST_REFUSED_ROUTES);
// the AI limits and the ledger (action 'workspace-ask', board 'ws:<wid>'); canvas search entries within
// searchScope; boards failing aiGateFor (./index.ts) dropped without a word. Pending (../pending-routes.ts): not
// registered until W8 implements it, so it answers 404 NOT_FOUND like any unknown route.

import { WORKSPACE_ASK_ROUTE } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { routeUnlessPending } from '../pending-routes.ts'

export function registerWorkspaceAsk(app: FastifyInstance, _ctx: FeatureContext): void {
  routeUnlessPending(app, 'POST', WORKSPACE_ASK_ROUTE, async () => {
    throw notFound()
  })
}
