// OWNER: WS5 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'timeline' feature on
// the Excalidraw board page: timeline frames (T5): the ruler, lanes and bars overlay (drawn into exports), bar drags that write the cards' dates.
// Until WS5 implements it, it contributes nothing (no command, overlay, panel or menu entry), so the board page is
// unchanged; its switch is features/planning/flags.ts PLANNING_FLAGS.timeline (off), and every planning write needs a
// rev-14 room (planningOffered).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'timeline',
}
