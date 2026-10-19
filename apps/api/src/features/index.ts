// The one place feature modules are registered (integration owner). Each feature owns its folder.
import type { FastifyInstance } from 'fastify'
import { registerAssetVersions } from '../files/versions.ts'
import { registerAi } from './ai/index.ts'
import { registerBackup } from './backup/index.ts'
import { registerBoardLinks } from './board-links/index.ts'
import { registerBoardOpen } from './board-open/index.ts'
import { registerBreakouts } from './breakouts/index.ts'
import { registerChatHooks } from './chat-hooks/index.ts'
import { registerComments } from './comments/index.ts'
import type { FeatureContext } from './context.ts'
import { registerDashboard } from './dashboard/index.ts'
import { registerDomainAccess } from './domain-access/index.ts'
import { registerExportControl } from './export-control/index.ts'
import { registerGuests } from './guests/index.ts'
import { registerHistory } from './history/index.ts'
import { registerImports } from './imports/index.ts'
import { registerMiroImport } from './imports/miro/index.ts'
import { registerJoinCodes } from './join-codes/index.ts'
import { registerLibrary } from './library/index.ts'
import { registerLinkPreview } from './link-preview/index.ts'
import { registerLiveActivities } from './live-activities/index.ts'
import { registerReview } from './review/index.ts'
import { registerSearch } from './search/index.ts'
import { registerThumbnails } from './thumbnails/index.ts'
import { registerUsage } from './usage/index.ts'
import { registerVisits } from './visits/index.ts'
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
  // Wave N (the foundation; WS4 owns this list after it): since your last visit (WS4) and links between boards (WS7);
  // Capture the room (WS5) is inside 'ai'. Their routes are pending until implemented (./pending-routes.ts).
  await registerVisits(app, ctx)
  await registerBoardLinks(app, ctx)
  // Wave Q (the foundation; WS2 owns this line after it): the element library. Its routes are pending until
  // implemented (./pending-routes.ts).
  await registerLibrary(app, ctx)
  // Wave R (the foundation; the lead owns this list after it): import jobs (the shared runner), import from Miro
  // (WS1), board backups (WS4) and chat notifications (WS2). Their routes are pending until implemented
  // (./pending-routes.ts).
  await registerImports(app, ctx)
  await registerMiroImport(app, ctx)
  await registerBackup(app, ctx)
  await registerChatHooks(app, ctx)
  // Wave S (the foundation; the lead owns this list after it): client review (WS1; WS4's review page reads it) and the
  // version list (WS2). Their routes are pending until implemented (./pending-routes.ts).
  await registerReview(app, ctx)
  await registerAssetVersions(app, ctx)
  // Wave V (the foundation; the lead owns this list after it): live activities (WS1), join codes (WS3), breakouts (WS4).
  // Their routes are pending until implemented (./pending-routes.ts), then gated by their kill switches
  // (./live/switch.ts: DRAFTROOM_LIVE_ACTIVITIES, DRAFTROOM_JOIN_CODES, DRAFTROOM_BREAKOUTS).
  await registerLiveActivities(app, ctx)
  await registerJoinCodes(app, ctx)
  await registerBreakouts(app, ctx)
}
