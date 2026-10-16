// OWNER: WS2 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'storyboard' feature on
// the Excalidraw board page: storyboards (T1): create (Elements → Storyboard, the template, Make storyboard from frames), the storyboard strip, panel chips and insert handles, reorder, Arrange, Script to boards and Break down with AI, Put panels in review.
// Until WS2 implements it, it contributes nothing (no command, overlay, panel or menu entry), so the board page is
// unchanged; its switch is features/planning/flags.ts PLANNING_FLAGS.storyboard (off), and every planning write needs a
// rev-14 room (planningOffered).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'storyboard',
}
