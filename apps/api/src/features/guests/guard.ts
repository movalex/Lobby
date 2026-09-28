// What name-only guests may not do (docs/WAVE3-CONTRACTS.md §2 guests): they reach the boards they
// were granted through guest links, and nothing else.
//
// Most of that already follows from their workspace role (`guest`: no projects, no board creation, no
// workspace member list; @draftroom/permissions) and from board roles (a viewer cannot manage people).
// This root preHandler hook refuses, for a signed-in guest, every route that creates or hands out
// access, whatever board role the guest was later given (a board owner can raise a guest's role):
// creating boards, projects, invitations and links; managing people and links; requesting access;
// moving a board between projects or changing its workspace access (PATCH /api/boards/:bid with
// `projectId` or `visibility`: a guest editor may still rename it). HEAD requests count as the GET
// they mirror.
// Invitations and links are also refused inside their own routes (routes/invitations.ts,
// features/dashboard/review-links.ts), so a renamed route cannot slip past this list.
//
// It also keeps guests confined from the other side: nobody can add a guest to a board they did not
// join through a guest link, or make a guest an owner. (Changing a guest's role on their board, or
// removing them, stays possible.)
//
// Registered on the root instance, so Fastify binds it to every root route at ready time (like the
// dashboard's own root hooks). The answer is the same for every board id, so it reveals nothing.

import { PutMemberInput, TransferOwnershipInput } from '@draftroom/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isUserId, requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, notFound } from '../../errors.ts'
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

/** Moving a board between projects: guests cannot see the workspace's projects, nor reorganise them. */
const MOVE = 'Guests can’t move boards between projects. Sign in with an account to do that.'

// Fastify answers HEAD on every GET route with the GET handler (exposeHeadRoutes): same refusal.
const routeKey = (req: FastifyRequest) =>
  `${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions.url ?? ''}`

/**
 * PATCH /api/boards/:bid is refused only for what it changes: moving the board between projects, and
 * its workspace access (that hands out access, like a link). Renaming stays an editor's.
 */
function boardPatchRefusal(key: string, body: unknown): string | undefined {
  if (key !== 'PATCH /api/boards/:bid' || typeof body !== 'object' || body === null) return undefined
  if (Object.hasOwn(body, 'visibility')) return MANAGE
  if (Object.hasOwn(body, 'projectId')) return MOVE
  return undefined
}

export function registerGuestGuard(app: FastifyInstance, ctx: FeatureContext): void {
  const { db, sessions } = ctx

  app.addHook('preHandler', async (req) => {
    const key = routeKey(req)
    const refused = GUEST_REFUSED_ROUTES[key] ?? boardPatchRefusal(key, req.body)
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
    const parsed = PutMemberInput.safeParse(req.body)
    if (!parsed.success) return // the route answers 400
    targetId = uid
    role = parsed.data.role
  } else {
    const parsed = TransferOwnershipInput.safeParse(req.body)
    if (!parsed.success) return // the route answers 400
    targetId = parsed.data.userId
    role = 'owner'
  }
  if (!isUserId(targetId)) return
  if ((await userKind(ctx.db, targetId)) !== 'guest') return
  const access = await requireBoardAction(ctx.db, bid, callerId, 'manage_access')
  // A guest outside the board's workspace: 404, the routes' answer for any outsider (a guest of
  // another workspace is none of this manager's business). Answered here rather than left to the
  // route, so a guest who joins this workspace meanwhile is still never added this way.
  const inWorkspace = await ctx.db.maybeOne(
    'SELECT 1 AS ok FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [access.board.workspace_id, targetId],
  )
  if (!inWorkspace) throw notFound()
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
