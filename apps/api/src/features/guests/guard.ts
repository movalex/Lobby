// What name-only guests may not do (docs/WAVE3-CONTRACTS.md §2 guests): they reach the boards they
// were granted through guest links, and nothing else.
//
// Most of that already follows from their workspace role (`guest`: no projects, no board creation, no
// workspace member list; @draftroom/permissions) and from board roles (a viewer cannot manage people).
// This root preHandler hook refuses, for a signed-in guest, every route that creates or hands out
// access, whatever board role the guest was later given (a board owner can raise a guest's role):
// creating boards, projects, invitations and links; managing people and links; requesting access.
// Invitations and links are also refused inside their own routes (routes/invitations.ts,
// features/dashboard/review-links.ts), so a renamed route cannot slip past this list.
//
// It also keeps guests confined from the other side: nobody can add a guest to a board they did not
// join through a guest link, or make a guest an owner. (Changing a guest's role on their board, or
// removing them, stays possible.)
//
// Registered on the root instance, so Fastify binds it to every root route at ready time (like the
// dashboard's own root hooks). The answer is the same for every board id, so it reveals nothing.

import { TransferOwnershipInput } from '@draftroom/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isUserId, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'

const CREATE = 'Guests can’t create boards or projects. Sign in with an account to do that.'
const INVITE = 'Guests can’t invite people or create links. Sign in with an account to do that.'
const MANAGE = 'Guests can’t change who has access. Sign in with an account to do that.'
const REQUEST =
  'Guests can’t request access. Ask the person who shared the link with you, or sign in with an account.'
const PEOPLE = 'Guests see the people on their own boards only.'

/** `METHOD route-pattern` → the message a signed-in guest gets (403 GUEST_ACCOUNT_REQUIRED). */
export const GUEST_REFUSED_ROUTES: Readonly<Record<string, string>> = {
  // workspaces, projects and boards
  'POST /api/workspaces/:wid/boards': CREATE,
  'POST /api/workspaces/:wid/projects': CREATE,
  'PATCH /api/projects/:pid': CREATE,
  'POST /api/workspaces/:wid/boards/import': CREATE,
  'POST /api/boards/:bid/duplicate': CREATE,
  'POST /api/snapshots/:sid/restore-as-new': CREATE,
  'GET /api/workspaces/:wid/members': PEOPLE,
  'GET /api/workspaces/:wid/projects': PEOPLE,
  // invitations and links
  'POST /api/workspaces/:wid/invitations': INVITE,
  'POST /api/boards/:bid/invitations': INVITE,
  'POST /api/boards/:bid/invitations/email': INVITE,
  'GET /api/boards/:bid/invitations': INVITE,
  'POST /api/boards/:bid/review-links': INVITE,
  'POST /api/boards/:bid/review-links/:id/revoke': INVITE,
  'POST /api/boards/:bid/review-links/:id/extend': INVITE,
  'DELETE /api/invitations/:id': INVITE,
  // people and access
  'PUT /api/boards/:bid/members/:uid': MANAGE,
  'DELETE /api/boards/:bid/members/:uid': MANAGE,
  'POST /api/boards/:bid/transfer-ownership': MANAGE,
  'GET /api/boards/:bid/sharing/members': MANAGE,
  'GET /api/boards/:bid/access-requests': MANAGE,
  'POST /api/access-requests/:id/approve': MANAGE,
  'POST /api/access-requests/:id/deny': MANAGE,
  'POST /api/boards/:bid/access-requests': REQUEST,
}

export const guestRefused = (message: string) => new ApiError(403, 'GUEST_ACCOUNT_REQUIRED', message)

const onlyThroughLinks = (message: string) => conflict('GUEST_ONLY_THROUGH_LINKS', message)

const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? ''}`

export function registerGuestGuard(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, sessions } = ctx

  app.addHook('preHandler', async (req) => {
    const key = routeKey(req)
    const refused = GUEST_REFUSED_ROUTES[key]
    const target =
      key === 'PUT /api/boards/:bid/members/:uid' || key === 'POST /api/boards/:bid/transfer-ownership'
    if (refused === undefined && !target) return
    // Not signed in: the route answers 401 itself. (sessions.user is cached for the request.)
    const caller = await sessions.user(req)
    if (!caller) return
    if (refused !== undefined && (await userKind(db, caller.id)) === 'guest') throw guestRefused(refused)
    if (target) await checkGuestTarget(ctx, req, caller.id)
  })
}

/**
 * A guest reaches only the boards of their guest links: nobody adds them to another board or makes
 * them an owner. Only people who manage the board learn why (everyone else gets the route's own
 * 404/403 first, so a user id never reveals whether it is a guest).
 */
async function checkGuestTarget(ctx: FeatureContext, req: FastifyRequest, callerId: string): Promise<void> {
  const { bid = '', uid } = req.params as Params
  let targetId: string | undefined
  let role: unknown
  if (uid !== undefined) {
    targetId = uid
    role = (req.body as { role?: unknown } | undefined)?.role
  } else {
    const parsed = TransferOwnershipInput.safeParse(req.body)
    if (!parsed.success) return // the route answers 400
    targetId = parsed.data.userId
    role = 'owner'
  }
  if (!isUserId(targetId)) return
  if ((await userKind(ctx.db, targetId)) !== 'guest') return
  await requireBoardAction(ctx.db, bid, callerId, 'manage_access')
  if (role === 'owner')
    throw onlyThroughLinks('Guests can’t own boards. Ask them to sign in with an account first.')
  const grant = await ctx.db.maybeOne(
    'SELECT 1 AS ok FROM board_members WHERE board_id = $1 AND user_id = $2',
    [bid, targetId],
  )
  if (!grant)
    throw onlyThroughLinks(
      'Guests join boards only through a guest link. Send them one, or ask them to sign in with an account.',
    )
}
