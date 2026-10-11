// OWNER: WS7 (wave N, links between boards, PWR-10). Board card faces and backlinks (@draftroom/contracts
// board-links.ts; migration 0032_board_links):
//
//   GET /api/boards/:bid/board-cards?ids=<boardId[:elementId]>,…  → 200 BoardCardsAnswer  (view :bid; ≤ 50 ids)
//   GET /api/boards/:bid/backlinks                                → 200 BacklinksAnswer   (view :bid; no guests)
//
// Card faces (N7-2). A board card stores nothing about its target but the path (the web's link-cards.tsx): its face
// is asked here, per viewer, at view time. The caller must view :bid (404 otherwise). Each target is then decided
// by @draftroom/permissions for THIS caller, now: `ok` (title, the frame's name when the target element is a frame
// the search index knows, and the same-origin thumbnail route, which checks access again itself) only when they can
// view it and it is not in the trash. Everything else (no such board, no access, trashed) is the one `unavailable`
// face, byte for byte, so the answer never tells those apart. A name-only guest gets only `unavailable` faces (they
// see nothing beyond the boards of their links), without any lookup of the targets. The access check comes first:
// no query reads anything else about a target (its frame names) before it passed. No outbound fetch, a per-user
// rate limit, and nothing logged about a target.
//
// Backlinks (N7-4). The boards of :bid's workspace whose elements link to :bid (board_links, filled by the search
// indexer from the sync's text route), filtered at query time by search's scope rules (scope.ts: viewable, not
// trashed, the caller's workspace membership) and decided board by board by @draftroom/permissions, never :bid
// itself, at most BACKLINKS_MAX, most recently changed first. Name-only guests are refused (guests/guard.ts
// BACKLINKS_GUESTS, and here again after the board check).
//
// Hold: put either route key back into ../pending-routes.ts PENDING_ROUTES and it answers 404 like any unknown
// route; the web then draws neutral faces (cards still navigate) and hides "Linked from".

import {
  BACKLINKS_MAX,
  BACKLINKS_ROUTE,
  type BacklinksAnswer,
  BOARD_CARD_TARGET_PATTERN,
  BOARD_CARDS_ROUTE,
  type BoardCardFace,
} from '@draftroom/contracts'
import { can, resolveBoardRole } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { notFound } from '../../errors.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { BACKLINKS_GUESTS, guestRefused } from '../guests/guard.ts'
import { routeUnlessPending } from '../pending-routes.ts'
import { backlinkCandidates } from './store.ts'

/** Per signed-in user, per minute (a board page asks once per open, ≤ 50 cards a call, plus a few refreshes). */
export const BOARD_LINKS_LIMITS = { cardsPerUserPerMinute: 120, backlinksPerUserPerMinute: 60 }

/** The one face every target the caller cannot have (missing, forbidden, trashed, or asked by a guest). */
const _UNAVAILABLE: BoardCardFace = { state: 'unavailable' }
/** The contract's longest title and frame name on a face. */
const FACE_TEXT_MAX = 200

const _target = (raw: string) => {
  const m = BOARD_CARD_TARGET_PATTERN.exec(raw)
  return { raw, boardId: m?.[1] ?? '', elementId: m?.[2] ?? null }
}

export async function registerBoardLinks(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  const _cardsLimit = keyedLimit(
    { max: BOARD_LINKS_LIMITS.cardsPerUserPerMinute, timeWindow: 60_000 },
    ctx.now,
    'Too many board cards at once. Wait a moment and try again.',
  )
  const backlinksLimit = keyedLimit(
    { max: BOARD_LINKS_LIMITS.backlinksPerUserPerMinute, timeWindow: 60_000 },
    ctx.now,
    'Too many requests at once. Wait a moment and try again.',
  )

  // N7-2 lands next: board-cards is still the foundation stub
  routeUnlessPending(app, 'GET', BOARD_CARDS_ROUTE, async () => {
    throw notFound()
  })

  routeUnlessPending(app, 'GET', BACKLINKS_ROUTE, async (req): Promise<BacklinksAnswer> => {
    const user = await ctx.requireUser(req)
    backlinksLimit.take(user.id)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    // the guard refused a name-only guest already (GUEST_REFUSED_ROUTES); again here, after the board check
    if ((await userKind(db, user.id)) === 'guest') throw guestRefused(BACKLINKS_GUESTS)
    const workspaceRole = access.workspaceRole
    if (!workspaceRole) return { backlinks: [] }
    const rows = await backlinkCandidates(db, {
      toBoard: bid,
      workspaceId: access.board.workspace_id,
      userId: user.id,
      allBoards: workspaceRole === 'owner' || workspaceRole === 'admin',
      member: workspaceRole === 'member',
    })
    const backlinks: BacklinksAnswer['backlinks'] = []
    for (const r of rows) {
      const role = resolveBoardRole({ workspaceRole, boardGrant: r.board_grant, visibility: r.visibility })
      if (!can(role, 'view', r.status)) continue
      backlinks.push({ boardId: r.id, title: r.title.slice(0, FACE_TEXT_MAX), elementId: r.element_id })
      if (backlinks.length >= BACKLINKS_MAX) break
    }
    return { backlinks }
  })
}
