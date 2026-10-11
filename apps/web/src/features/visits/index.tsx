// OWNER: WS4 (wave N, since your last visit; registered empty by the wave N foundation). The 'visits' feature on the
// Excalidraw board page: the "Since you were here" chip, the overlay outlines, the change tour and Mark all seen, from
// the private visit time (./client.ts fetchVisit). Until WS4 implements it, it contributes nothing (no chip, no
// overlay, no command), so the board page is unchanged; the routes it calls are pending on the api (404).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'visits',
}
