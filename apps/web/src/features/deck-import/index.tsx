// OWNER: WS4 (wave W; registered empty by the wave W foundation, docs/WAVE-W-CONTRACTS.md §6). The 'deck-import' feature
// on the Excalidraw board page: "Insert as slides" on a ready deck (PDF, PPTX, ODP): pages 9..min(N, 100) through
// POST /api/files/:ver/render-pages when needed, then per slide a frame (FORMAT_ELEMENT_KINDS.deckSlide, deckSlideName)
// holding the page image ver_….p<n> (deckPage), in a DECK_LIMITS grid, all in ONE canvas.transact (one undo step).
// Slides are flattened page pictures: nothing claims they are editable. Until WS4 implements it, it contributes nothing;
// its switch is features/formats/flags.ts FORMATS_FLAGS.deckImport (off), and the api must offer it too.
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'deck-import',
}
