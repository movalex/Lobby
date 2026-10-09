// The Excalidraw engine's internal routes that the room itself does not serve (docs/EXCALIDRAW-MIGRATION.md
// §2.4.6; spike B built only the snapshot and the workshop-state push, room/http.ts): the api's
// template/duplicate/restore/import seeds, the private brainstorm's place-notes, search text, the asset
// collector's refs, and "Recently deleted". Owner: wave 2F. Built on the room service's public surface
// (room-internal/board.ts), never inside the room's files; `loadEngine('excalidraw')` imports this module,
// which registers the routes through the room extension mount point (engine-switch.ts, CR 2F-1).
//
//   POST /internal/boards/:bid/seed               seed.ts
//   POST /internal/boards/:bid/place-notes        place-notes.ts
//   GET  /internal/boards/:bid/text               text.ts
//   GET  /internal/boards/:bid/asset-refs         asset-refs.ts
//   GET  /internal/boards/:bid/deleted            deleted.ts
//   POST /internal/boards/:bid/deleted/restore    deleted.ts
//   POST /internal/boards/:bid/restore-elements   restore-elements.ts (wave L, L7-2: a checkpoint's elements
//                                                 back into the live board; canvas-schema RESTORE_ELEMENTS_REV)
//
// Every one sits behind the router's internal-secret check, like every internal route.

import { type InternalRoute, type RoomExtensionContext, registerRoomExtension } from '../engine-switch.ts'
import { assetRefsRoutes } from './asset-refs.ts'
import { deletedRoutes } from './deleted.ts'
import { placeNotesRoutes } from './place-notes.ts'
import { restoreElementsRoutes } from './restore-elements.ts'
import { seedRoutes } from './seed.ts'
import { textRoutes } from './text.ts'

export function roomInternalRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [
    ...seedRoutes(ctx),
    ...placeNotesRoutes(ctx),
    ...textRoutes(ctx),
    ...assetRefsRoutes(ctx),
    ...deletedRoutes(ctx),
    ...restoreElementsRoutes(ctx),
  ]
}

registerRoomExtension(roomInternalRoutes)
