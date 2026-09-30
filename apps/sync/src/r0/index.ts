// O4's R0 stand-in entry point (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "The R0 stand-in"). Created empty by
// the lead at the spike B contracts step C0; O4 owns apps/sync/src/r0/** from C0 on.
//
// `loadEngine('tldraw')` (engine-switch.ts) imports this module, so with DRAFTROOM_ENGINE unset the
// spike branch's sync is the R0 stand-in. Since bridge release R0 is on main (merged into
// engine/excalidraw at wave 3b), the stand-in is R0's reviewed code: the born-after check is registered
// by pre-open.ts, which rooms.ts imports, so it runs in RoomRegistry.open() before any writable handle to a
// board file exists and refuses boards born on the new canvas (born-after.ts). Importing this module adds
// nothing twice (ES modules evaluate once).

export { type BoardFileKind, classifyBoardFile } from './born-after.ts'
export { bornAfterCheck, unregisterBornAfterCheck } from './pre-open.ts'
