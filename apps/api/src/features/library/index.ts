// OWNER: WS2 (wave Q, the element library; stubs landed by the wave Q foundation). The library routes
// (@draftroom/contracts library.ts; migration 0033_library; docs/WAVE-Q-CONTRACTS.md §2):
//
//   GET    /api/workspaces/:wid/library                          list (summaries, paged)
//   GET    /api/workspaces/:wid/library/items/:id                one item with its elements
//   POST   /api/workspaces/:wid/library/items                    save a selection
//   PATCH  /api/workspaces/:wid/library/items/:id                rename, retag, move, replace (revision-checked)
//   DELETE /api/workspaces/:wid/library/items/:id                soft delete
//   POST   /api/workspaces/:wid/library/items/:id/restore        undo a delete (30 days)
//   GET    /api/workspaces/:wid/library/items/:id/files/:ver/thumb   a preview image of a version the item shows
//   POST   /api/workspaces/:wid/library/import                   a normalised .excalidrawlib
//   GET    /api/workspaces/:wid/library/folders                  folders of a scope
//   POST   /api/workspaces/:wid/library/folders                  new folder
//   PATCH  /api/workspaces/:wid/library/folders/:fid             rename, reorder
//   DELETE /api/workspaces/:wid/library/folders/:fid             delete (its items stay, folderless)
//   GET    /api/workspaces/:wid/library/marks                    the caller's favourites and recents
//   PUT    /api/workspaces/:wid/library/marks                    star / unstar / stamp a use
//   POST   /api/boards/:bid/library/items/:id/place              an item's elements for this board, files linked first
//
// The guard rows are in place: every route refuses a name-only guest (guests/guard.ts, LIBRARY_GUEST_ROUTE_KEYS), and
// the eight writes freshen the caller for the in-route creator check of the workspace scope (domain-access/guard.ts,
// LIBRARY_CREATOR_IN_ROUTE_KEYS). Every check the contract lists is the route's own as well (fail closed), with
// authorship from the session only. Pending (../pending-routes.ts): none is registered until WS2 implements it, so
// each answers 404 NOT_FOUND like any unknown route, and the web's library client answers empty
// (apps/web/src/features/elements/client.ts).

import { LIBRARY_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { type PendingMethod, routeUnlessPending } from '../pending-routes.ts'

export async function registerLibrary(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  for (const key of LIBRARY_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    routeUnlessPending(app, method, url, stub)
  }
}
