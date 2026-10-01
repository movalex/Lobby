// Framework-free board logic (docs/FEATURES-CONTRACTS.md "packages/board-ops"). Since wave 4 part 2 the
// readers and writers are over Excalidraw elements (`./elements`); the root keeps the engine-neutral text
// helper the api reads tldraw-era rich text with (v1 checkpoint bodies). The tldraw record logic (the v1
// archive, remapping, frames, CSV, search) left with the tldraw page; the v1 archive is
// `@draftroom/tldraw-import/archive-v1`.
export { plainTextOf } from './rich-text.ts'
