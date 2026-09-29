// O4's R0 stand-in entry point (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "The R0 stand-in"). Created empty by
// the lead at the spike B contracts step C0; O4 owns apps/sync/src/r0/** from C0 on.
//
// `loadEngine('tldraw')` (engine-switch.ts) imports this module, so with DRAFTROOM_ENGINE unset the
// spike branch's sync is the R0 stand-in: the born-after check below runs in RoomRegistry.open() before
// any writable handle to a board file exists, and refuses boards born on the new canvas (born-after.ts).
// Importing it twice registers it once (ES modules evaluate once).

import { registerPreOpenCheck } from '../engine-switch.ts'
import { bornAfterCheck } from './born-after.ts'

export { type BoardFileKind, bornAfterCheck, classifyBoardFile, verdictFor } from './born-after.ts'

/** Removes the stand-in's check again (tests). */
export const unregisterBornAfterCheck = registerPreOpenCheck(bornAfterCheck)
