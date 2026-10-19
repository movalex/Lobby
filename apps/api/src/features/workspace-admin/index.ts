// OWNER: WS5 (wave W, the workspace admin page). docs/WAVE-W-CONTRACTS.md §7.
//
//   GET /api/workspaces/:wid/admin/members              → AdminMembersResponse       W5-1
//   GET /api/workspaces/:wid/admin/invitations          → AdminInvitationsResponse   W5-1
//   GET /api/workspaces/:wid/admin/storage/by-board     → AdminStorageResponse       W5-2
//   GET /api/workspaces/:wid/admin/storage/by-uploader  → AdminStorageResponse       W5-2
//   GET /api/workspaces/:wid/admin/audit                → AdminAuditResponse         W5-3
//   GET /api/workspaces/:wid/admin/links                → AdminLinksResponse         W5-4
//   GET /api/workspaces/:wid/admin/retention            → AdminRetentionResponse     W5-5
//
// Owner or admin of the workspace only. Everyone else gets the unknown route's 404 (never a 401 or a 403): someone
// signed out, a member, a workspace guest, someone of another workspace; a name-only guest is answered 404 by the guest
// guard before any query (guests/guard.ts GUEST_HIDDEN_ROUTES). DRAFTROOM_WORKSPACE_ADMIN off: the same 404 for every
// caller, from the route's onRequest gate (../formats/switch.ts formatsRoute), before anything is read.
//
// Read-only: these routes change nothing. Every change the page offers (a role, a removal, revoking an invitation or a
// link, taking a guest off a board, "+1 h" on a link) calls the EXISTING route, where its own rules stay (the creator
// rule, the last-owner rule, the per-board link rules: workspace owners and admins are owners of every board of their
// workspace there). ADMIN_LIMITS.rate per person over all seven, counted only once the caller is known to be an owner
// or admin (so a 429 tells nobody else the page exists).

import {
  ADMIN_LIMITS,
  ADMIN_ROUTE_KEYS,
  AdminAuditQuery,
  type AdminAuditResponse,
  type AdminInvitationsResponse,
  type AdminLinksResponse,
  type AdminMembersResponse,
  type AdminRetentionResponse,
  type AdminStorageResponse,
} from '@draftroom/contracts'
import { canManageWorkspace, type WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from 'fastify'
import { isWorkspaceId } from '../../access.ts'
import type { Params } from '../../context.ts'
import { notFound, parse } from '../../errors.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { formatsRoute } from '../formats/switch.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'
import {
  adminInvitations,
  adminLinks,
  adminMembers,
  auditPage,
  retentionFacts,
  storageByBoard,
  storageByUploader,
} from './queries.ts'

const RATE_MESSAGE = 'Too many requests to the admin page. Wait a few seconds and try again.'

export async function registerWorkspaceAdmin(
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  // Read lazily: a bare test app gives only the switches (test/features/formats/switch.test.ts).
  const rate = keyedLimit(ADMIN_LIMITS.rate, () => ctx.now(), RATE_MESSAGE)

  /** The caller as an owner or admin of `:wid`, or the unknown route's 404 for anyone else. */
  async function adminOf(req: FastifyRequest): Promise<{ wid: string; userId: string }> {
    const user = await ctx.sessions.user(req)
    if (user?.kind !== 'account') throw notFound()
    const { wid = '' } = req.params as Params
    if (!isWorkspaceId(wid)) throw notFound()
    const member = await ctx.db.maybeOne<{ role: WorkspaceRole }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [wid, user.id],
    )
    if (!canManageWorkspace(member?.role ?? null)) throw notFound()
    rate.take(user.id)
    return { wid, userId: user.id }
  }

  const handlers: Record<keyof typeof ADMIN_ROUTE_KEYS, RouteHandlerMethod> = {
    members: async (req): Promise<AdminMembersResponse> => {
      const { wid } = await adminOf(req)
      return { members: await adminMembers(ctx.db, ctx, wid) }
    },
    invitations: async (req): Promise<AdminInvitationsResponse> => {
      const { wid } = await adminOf(req)
      return adminInvitations(ctx.db, wid, ctx.now())
    },
    storageByBoard: async (req): Promise<AdminStorageResponse> => {
      const { wid } = await adminOf(req)
      return storageByBoard(ctx.db, ctx, wid)
    },
    storageByUploader: async (req): Promise<AdminStorageResponse> => {
      const { wid } = await adminOf(req)
      return storageByUploader(ctx.db, ctx, wid)
    },
    audit: async (req): Promise<AdminAuditResponse> => {
      const { wid } = await adminOf(req)
      const query = parse(AdminAuditQuery, req.query ?? {})
      return auditPage(ctx.db, wid, query)
    },
    links: async (req): Promise<AdminLinksResponse> => {
      const { wid } = await adminOf(req)
      return adminLinks(ctx.db, wid, ctx.now())
    },
    retention: async (req): Promise<AdminRetentionResponse> => {
      await adminOf(req)
      return { facts: retentionFacts(ctx) }
    },
  }

  for (const [name, key] of Object.entries(ADMIN_ROUTE_KEYS) as [keyof typeof ADMIN_ROUTE_KEYS, string][]) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    formatsRoute(app, ctx, 'admin', method, url, handlers[name], pending)
  }
}
