// Domain access, the root guard (docs/DOMAIN-ACCESS-CONTRACTS.md §4.2): every route that creates
// something (a workspace, project or board in any form) or hands out access (invitations, links,
// extending a link, approving a request, transferring ownership) needs a creator. Registered right
// AFTER the guest guard: root preHandler hooks run in registration order, so name-only guests are
// refused there first (and keep GUEST_ACCOUNT_REQUIRED).
//
// - refuse 'always': the caller's identity is confirmed first (identity.freshen 'confirm', strict: a
//   failed awaited refresh is a 503), then requireCreator. The answer depends only on the caller,
//   never on the id in the URL, so it reveals nothing; creators still get the routes' own 404s.
// - refuse 'in-route': the guard only freshens the caller (leniently). The route decides, after its
//   own permission checks: PUT members (lowering stays open), PATCH a board's visibility (lowering
//   stays open). Target refreshes happen in the route, never here.
//
// The in-route checks stay even with this guard (a renamed route cannot slip past), and a root hook
// does not reach routes in child scopes created before it (the files plugin, thumbnails, the worker;
// none of them creates anything). The creation-matrix test proves both layers on their own.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CreatorPurpose } from '../../auth/identity.ts'
import type { FeatureContext } from '../context.ts'

export interface CreatorRoute {
  purpose: CreatorPurpose
  refuse: 'always' | 'in-route'
}

/** `METHOD route-pattern` (the guest guard's key format; HEAD reads as GET). */
export const CREATOR_ROUTES: Readonly<Record<string, CreatorRoute>> = {
  // creating (every template, sample board and quick "Untitled" goes through the first one)
  'POST /api/workspaces/:wid/boards': { purpose: 'create', refuse: 'always' },
  'POST /api/workspaces/:wid/projects': { purpose: 'create', refuse: 'always' },
  'PATCH /api/projects/:pid': { purpose: 'create', refuse: 'always' }, // D6
  'POST /api/workspaces/:wid/boards/import': { purpose: 'create', refuse: 'always' },
  'POST /api/boards/:bid/duplicate': { purpose: 'create', refuse: 'always' },
  'POST /api/snapshots/:sid/restore-as-new': { purpose: 'create', refuse: 'always' },
  // handing out access (D4)
  'POST /api/workspaces/:wid/invitations': { purpose: 'share', refuse: 'always' },
  'POST /api/boards/:bid/invitations': { purpose: 'share', refuse: 'always' },
  'POST /api/boards/:bid/invitations/email': { purpose: 'share', refuse: 'always' },
  'POST /api/boards/:bid/review-links': { purpose: 'share', refuse: 'always' },
  'POST /api/boards/:bid/review-links/:id/extend': { purpose: 'share', refuse: 'always' },
  'POST /api/access-requests/:id/approve': { purpose: 'share', refuse: 'always' },
  'POST /api/boards/:bid/transfer-ownership': { purpose: 'share', refuse: 'always' },
  // decided in the route (lowering stays open to every manager)
  'PUT /api/boards/:bid/members/:uid': { purpose: 'share', refuse: 'in-route' },
  'PATCH /api/boards/:bid': { purpose: 'share', refuse: 'in-route' },
  // authz-006: raising a workspace member's role (lowering, and DELETE, stay open to every manager)
  'PATCH /api/workspaces/:wid/members/:uid': { purpose: 'share', refuse: 'in-route' },
  // wave M (M8-3, W8; landed by the foundation, pending until implemented: ../pending-routes.ts): workspace
  // templates. Saving and removing one is for a creator who is a workspace owner or admin (the admin part in the
  // route); starting a board from one creates a board.
  'POST /api/workspaces/:wid/templates': { purpose: 'create', refuse: 'always' },
  'DELETE /api/workspaces/:wid/templates/:bid': { purpose: 'create', refuse: 'always' },
  'POST /api/workspaces/:wid/templates/:bid/use': { purpose: 'create', refuse: 'always' },
}

const routeKey = (req: FastifyRequest) =>
  `${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions.url ?? ''}`

export function registerDomainAccessGuard(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, sessions, identity } = ctx

  app.addHook('preHandler', async (req) => {
    const key = routeKey(req)
    const rule = CREATOR_ROUTES[key]
    if (!rule) return
    // PATCH /api/boards/:bid concerns domain access only when it changes the visibility.
    if (
      key === 'PATCH /api/boards/:bid' &&
      !(typeof req.body === 'object' && req.body !== null && Object.hasOwn(req.body, 'visibility'))
    )
      return
    // Not signed in: the route answers 401 itself.
    const caller = await sessions.user(req)
    if (!caller) return
    const fresh = await identity.freshen(req, caller, 'confirm', { strict: rule.refuse === 'always' })
    if (rule.refuse === 'always')
      await identity.requireCreator(db, fresh.id, rule.purpose, {
        route: req.routeOptions.url ?? '',
        by: 'guard',
      })
  })
}
