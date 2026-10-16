// OWNER: WS4 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1). The 'cards' feature on
// the Excalidraw board page: work cards (T3): Make a card / Unmake card, the status, assignee and due chips (an overlay, drawn into exports), the card popover (registered through features/planning registerCardPopover) and the assignee picker.
// Until WS4 implements it, it contributes nothing (no command, overlay, panel or menu entry), so the board page is
// unchanged; its switch is features/planning/flags.ts PLANNING_FLAGS.cards (off), and every planning write needs a
// rev-14 room (planningOffered).
import type { CanvasFeature } from '../../canvas/api/index.ts'

export const feature: CanvasFeature = {
  id: 'cards',
}
