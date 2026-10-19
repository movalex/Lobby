// OWNER: WS1 (wave W; registered empty by the wave W foundation, docs/WAVE-W-CONTRACTS.md §2). The 'doc-cards' feature
// on the Excalidraw board page: doc cards: a rectangle with a bound label of Markdown-lite words (contracts
// FORMAT_ELEMENT_KINDS.docCard), the formatted face (DocFace, React nodes only, never HTML), the side panel (DocEditor)
// that writes only under the text lease (the lease-client adapter in canvas/lease/), the insert and "Text → Doc card".
// Until WS1 implements it, it
// contributes nothing, so the board page is unchanged; its switch is features/formats/flags.ts FORMATS_FLAGS.docCards
// (off), and the api's DRAFTROOM_DOC_CARDS must be on too (formatsEnabled).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'doc-cards',
}
