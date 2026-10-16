// OWNER: WS3 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'storyboard-play' feature on
// the Excalidraw board page: the animatic player (T2) and Present storyboard (the presenter's slides source).
// Until WS3 implements it, it contributes nothing (no command, overlay, panel or menu entry), so the board page is
// unchanged; its switch is features/planning/flags.ts PLANNING_FLAGS.animatic (off), and every planning write needs a
// rev-14 room (planningOffered).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'storyboard-play',
}
