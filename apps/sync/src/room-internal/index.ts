// Wave 2F's internal routes of the Excalidraw engine that the room itself does not serve (seed,
// place-notes, text, asset-refs, deleted; docs/EXCALIDRAW-MIGRATION.md §2.4.6). `loadEngine('excalidraw')`
// imports this module; it registers its routes with `registerRoomExtension` (engine-switch.ts, CR 2F-1).
// Owner: wave 2F. (The CR commit adds this file empty; wave 2F's next commit registers the routes.)
export {}
