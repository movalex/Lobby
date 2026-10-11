// OWNER: WS7 (wave N, links between boards; registered empty by the wave N foundation). The 'board-links' feature on
// the Excalidraw board page: board cards from a pasted or picked board link, their faces (./client.ts boardCards),
// and "Linked from" (./client.ts backlinks) in the navigation panel and the palette. Until WS7 implements it, it
// contributes nothing (no paste handler, no command, no panel section), so the board page is unchanged; the routes
// it calls are pending on the api (404).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'board-links',
}
