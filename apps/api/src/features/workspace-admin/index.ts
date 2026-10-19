// OWNER: WS5 (wave W, the workspace admin page; stubs landed by the wave W foundation). docs/WAVE-W-CONTRACTS.md §7.
//
//   GET /api/workspaces/:wid/admin/members              → AdminMembersResponse       W5-1
//   GET /api/workspaces/:wid/admin/invitations          → AdminInvitationsResponse   W5-1
//   GET /api/workspaces/:wid/admin/storage/by-board     → AdminStorageResponse       W5-2
//   GET /api/workspaces/:wid/admin/storage/by-uploader  → AdminStorageResponse       W5-2
//   GET /api/workspaces/:wid/admin/audit                → AdminAuditResponse         W5-3
//   GET /api/workspaces/:wid/admin/links                → AdminLinksResponse         W5-4
//   GET /api/workspaces/:wid/admin/retention            → AdminRetentionResponse     W5-5
//
// Owner or admin of the workspace only (requireWorkspaceRole then canManageWorkspace); everyone else, a member, a
// workspace guest, someone of another workspace, gets the unknown route's 404 (never a 403), and a name-only guest is
// answered 404 by the guest guard before any query (guests/guard.ts GUEST_HIDDEN_ROUTES). Read-only: every change the
// page offers calls an EXISTING route. ADMIN_LIMITS.rate per user. Pending (../pending-routes.ts) until WS5 implements
// them; once registered, DRAFTROOM_WORKSPACE_ADMIN gates them (../formats/switch.ts formatsRoute: 404 while off).

import { ADMIN_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { type FormatSwitchSource, formatsRoute, formatsStub } from '../formats/switch.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'

export async function registerWorkspaceAdmin(
  app: FastifyInstance,
  ctx: FormatSwitchSource,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  for (const key of Object.values(ADMIN_ROUTE_KEYS)) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    formatsRoute(app, ctx, 'admin', method, url, formatsStub, pending)
  }
}
