// OWNER: WS7 (wave N, links between boards; a stub landed by the wave N foundation). Board card faces and backlinks
// (@draftroom/contracts board-links.ts; migration 0032_board_links):
//
//   GET /api/boards/:bid/board-cards?ids=<boardId[:elementId]>,…  → 200 BoardCardsAnswer  (view :bid; 404 semantics)
//   GET /api/boards/:bid/backlinks                                → 200 BacklinksAnswer   (view :bid; no guests)
//
// Every face and backlink is permission-checked at query time; a target the caller cannot view, a missing one and
// a trashed one answer the same `unavailable` face. Name-only guests get only unavailable faces (no guest row for
// board-cards); backlinks refuse guests (guests/guard.ts GUEST_REFUSED_ROUTES). Pending (../pending-routes.ts):
// neither is registered until WS7 implements them, so they answer 404 NOT_FOUND like any unknown route, and the
// web's boardCards() and backlinks() answer unavailable (cards still navigate, with neutral faces).

import { BACKLINKS_ROUTE, BOARD_CARDS_ROUTE } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { routeUnlessPending } from '../pending-routes.ts'

export async function registerBoardLinks(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  routeUnlessPending(app, 'GET', BOARD_CARDS_ROUTE, stub)
  routeUnlessPending(app, 'GET', BACKLINKS_ROUTE, stub)
}
