// OWNER: WS2 (wave W; registered empty by the wave W foundation, docs/WAVE-W-CONTRACTS.md §4). The 'remove-bg' feature
// on the Excalidraw board page: Remove background (beta) on a ready image: POST /api/files/:ver/remove-background, its
// progress from the requester's file.op events (or GET /api/file-ops/:op), and on done the element's fileId and
// customData.lobby.file swapped to the new version in ONE canvas.transact (one undo step; never a data: or blob: URL).
// Until WS2 implements it, it contributes nothing; its switch is features/formats/flags.ts FORMATS_FLAGS.removeBackground
// (off), and the api must offer it too (DRAFTROOM_REMOVE_BACKGROUND and a capable worker: formatsEnabled).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'remove-bg',
}
