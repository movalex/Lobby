// The one place feature modules are registered (integration owner). Each feature owns its folder.
import type { FastifyInstance } from 'fastify'
import { registerAi } from './ai/index.ts'
import { registerBoardOpen } from './board-open/index.ts'
import { registerComments } from './comments/index.ts'
import type { FeatureContext } from './context.ts'
import { registerDashboard } from './dashboard/index.ts'
import { registerDomainAccess } from './domain-access/index.ts'
import { registerExportControl } from './export-control/index.ts'
import { registerGuests } from './guests/index.ts'
import { registerHistory } from './history/index.ts'
import { registerLinkPreview } from './link-preview/index.ts'
import { registerSearch } from './search/index.ts'
import { registerThumbnails } from './thumbnails/index.ts'
import { registerUsage } from './usage/index.ts'
import { registerWorkshops } from './workshops/index.ts'
import { registerWsTemplates } from './ws-templates/index.ts'

export async function registerFeatures(
  app: FastifyInstance,
  ctx: FeatureContext,
  opts: { domainAccessGuard: boolean } = { domainAccessGuard: true },
): Promise<void> {
  await registerComments(app, ctx)
  await registerHistory(app, ctx)
  await registerWorkshops(app, ctx)
  await registerDashboard(app, ctx)
  await registerGuests(app, ctx)
  // Right after the guest guard: root preHandler hooks run in registration order (guests are refused
  // there first, with GUEST_ACCOUNT_REQUIRED).
  await registerDomainAccess(app, ctx, { guard: opts.domainAccessGuard })
  await registerThumbnails(app, ctx)
  await registerExportControl(app, ctx)
  await registerSearch(app, ctx)
  await registerAi(app, ctx)
  // D2 link cards (3g, the Excalidraw board's media feature): the page title and icon of a pasted URL
  await registerLinkPreview(app, ctx)
  // Wave M (the foundation; W5 owns this list after it): the board-open read (W5), usage counters (W5) and
  // workspace templates (W8). Their routes are pending until implemented (./pending-routes.ts: not registered).
  await registerBoardOpen(app, ctx)
  await registerUsage(app, ctx)
  await registerWsTemplates(app, ctx)
}
