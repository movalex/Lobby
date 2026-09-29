// O4's R0 stand-in entry point (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "The R0 stand-in"). Written EMPTY by
// the lead at the spike B contracts step C0; O4 owns apps/sync/src/r0/** from C0 on.
//
// `loadEngine('tldraw')` (engine-switch.ts) imports this module, so with DRAFTROOM_ENGINE unset the
// spike branch's sync is the R0 stand-in: O4 registers its born-after check here with
// `registerPreOpenCheck` (engine-switch.ts), which RoomRegistry.open() runs before any writable handle to
// a board file exists. Until then nothing is registered and the tldraw sync behaves exactly as today.

export {}
