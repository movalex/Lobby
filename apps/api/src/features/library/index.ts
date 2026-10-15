// OWNER: WS2 (wave Q, the element library). The library routes (@draftroom/contracts library.ts; migration
// 0033_library; docs/WAVE-Q-CONTRACTS.md §2):
//
//   GET    /api/workspaces/:wid/library                          list (summaries, paged)                  items.ts
//   GET    /api/workspaces/:wid/library/items/:id                one item with its elements                items.ts
//   POST   /api/workspaces/:wid/library/items                    save a selection                          items.ts
//   PATCH  /api/workspaces/:wid/library/items/:id                rename, retag, move, replace (revision)   items.ts
//   DELETE /api/workspaces/:wid/library/items/:id                soft delete                               items.ts
//   POST   /api/workspaces/:wid/library/items/:id/restore        undo a delete (30 days)                   items.ts
//   GET    /api/workspaces/:wid/library/items/:id/files/:ver/thumb   a preview of a version it shows       items.ts
//   POST   /api/workspaces/:wid/library/import                   a normalised .excalidrawlib               import.ts
//   GET    /api/workspaces/:wid/library/folders                  folders of a scope                        folders.ts
//   POST   /api/workspaces/:wid/library/folders                  new folder                                folders.ts
//   PATCH  /api/workspaces/:wid/library/folders/:fid             rename, reorder                           folders.ts
//   DELETE /api/workspaces/:wid/library/folders/:fid             delete (its items stay, folderless)       folders.ts
//   GET    /api/workspaces/:wid/library/marks                    the caller's favourites and recents       marks.ts
//   PUT    /api/workspaces/:wid/library/marks                    star / unstar / stamp a use               marks.ts
//   POST   /api/boards/:bid/library/items/:id/place              an item's elements, files linked first    place.ts
//   POST   /api/boards/:bid/library/items/:id/place/confirm      its push succeeded: the links stay          place.ts
//
// Guards first: every route refuses a name-only guest (guests/guard.ts, LIBRARY_GUEST_ROUTE_KEYS), and the eight
// writes freshen the caller for the in-route creator check of the workspace scope (domain-access/guard.ts,
// LIBRARY_CREATOR_IN_ROUTE_KEYS). Then every rule again in the route, failing closed (model.ts), with authorship from
// the session only. Rate limits per person (LIBRARY_RATE_LIMITS): saves (POST items, PATCH with elements) 60 a
// minute, imports 5, places 120 (and 120 confirms). The hourly purge removes items deleted more than 30 days ago
// (purge.ts); the file collector counts library_item_files as references until then (files/gc.ts). The same hourly
// pass sweeps the links of places never confirmed (purge.ts sweepPlacePending).
//
// Lock order (access.ts): every library write takes the workspace row FOR NO KEY UPDATE first (with the caller's
// membership read again under it), then the item or folder row; a place takes the workspace row FOR SHARE (its
// membership read again under it), then the item row FOR SHARE, then writes board_asset_links. No content, no names and no element data are logged; audit rows carry ids, scopes and
// counts. A route listed in ../pending-routes.ts again is not registered (it ships hidden: the unknown route's 404).

import { LIBRARY_RATE_LIMITS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { keyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { registerLibraryFolders } from './folders.ts'
import { registerLibraryImport } from './import.ts'
import { registerLibraryItems } from './items.ts'
import { registerLibraryMarks } from './marks.ts'
import { registerLibraryPlace } from './place.ts'
import { startLibraryPurge } from './purge.ts'

export async function registerLibrary(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const limit = (l: { max: number; windowMs: number }) =>
    keyedLimit({ max: l.max, timeWindow: l.windowMs }, ctx.now)
  const limits = {
    save: limit(LIBRARY_RATE_LIMITS.save),
    import: limit(LIBRARY_RATE_LIMITS.import),
    place: limit(LIBRARY_RATE_LIMITS.place),
    // one confirm follows each place
    confirm: limit(LIBRARY_RATE_LIMITS.place),
  }
  registerLibraryItems(app, ctx, limits)
  registerLibraryImport(app, ctx, limits)
  registerLibraryFolders(app, ctx)
  registerLibraryMarks(app, ctx)
  registerLibraryPlace(app, ctx, limits)
  startLibraryPurge(app, ctx)
}
