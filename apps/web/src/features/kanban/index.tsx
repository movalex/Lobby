// OWNER: WS4 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'kanban' feature on
// the Excalidraw board page: Kanban frames (T3): the column bands overlay, drop into a column (geometry and status in one step), the mismatch hint and Tidy.
// Until WS4 implements it, it contributes nothing (no command, overlay, panel or menu entry), so the board page is
// unchanged; its switch is features/planning/flags.ts PLANNING_FLAGS.kanban (off), and every planning write needs a
// rev-14 room (planningOffered).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'kanban',
}
