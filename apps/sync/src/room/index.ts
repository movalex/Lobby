// O1's ElementRoom entry point (docs/EXCALIDRAW-MIGRATION.md §2.4, §8.6.3). STUB written by the lead at
// the spike B contracts step C0; O1 owns this file (and all of apps/sync/src/room/** except schema.ts and
// migrate/**) from C0 on.
//
// The contract this module keeps: importing it registers the service factory with
// `registerElementRoom` (engine-switch.ts); `loadEngine('excalidraw')` imports it before the server is
// built, and the C0 arrow acceptance tests (apps/sync/test/room/arrows/) import it to get the real room.

import { type ElementRoomDeps, type ElementRoomService, registerElementRoom } from '../engine-switch.ts'

export function createElementRoomService(deps: ElementRoomDeps): ElementRoomService {
  void deps
  throw new Error('not implemented (O1): apps/sync/src/room/index.ts createElementRoomService')
}

registerElementRoom(createElementRoomService)
