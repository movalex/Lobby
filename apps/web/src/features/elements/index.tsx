// OWNER: WS3 (wave Q, the Elements panel; registered by the wave Q foundation, hidden behind ELEMENTS_PANEL). One dock
// panel, Elements (panel id 'elements', order 35, the Shapes panel's place once it retires), with three sources: the
// built-in icons (WS1: Lucide and Tabler outline, generated index and shards under /lobby-assets/icons/), the built-in
// shapes and kits (WS4: @draftroom/templates pieces) and the library (WS2's routes, ./client.ts). Every insert goes
// through ./place.ts placeElements: native elements, one transaction, one undo step. Read-only roles get no panel.
//
// While ELEMENTS_PANEL (./flags.ts) is false the feature contributes nothing: no panel, no command, no drop handler,
// and the board page is exactly as before wave Q. docs/WAVE-Q-CONTRACTS.md §4 is the contract.
import { ELEMENTS_PANEL_ID, ELEMENTS_PANEL_LABEL } from '@draftroom/contracts'
import { isReadonlyRole } from '../../board/access.ts'
import type { CanvasFeature, CanvasPanelSpec } from '../../canvas/api/index.ts'
import { PiecesIcon } from '../pieces/icons.tsx'
import { ElementsPanel } from './ElementsPanel.tsx'
import { ELEMENTS_PANEL } from './flags.ts'

/** The dock panel (WS3 fills its component). */
export const ELEMENTS_PANEL_SPEC: CanvasPanelSpec = {
  id: ELEMENTS_PANEL_ID,
  label: ELEMENTS_PANEL_LABEL,
  icon: PiecesIcon,
  order: 35,
  // inserting is editing: viewers, commenters and archived boards get no panel
  visible: (ctx) => !isReadonlyRole(ctx.role, ctx.board.status),
  component: ElementsPanel,
}

/** The feature with the panel switched on or off (`feature` is ELEMENTS_PANEL's; tests build both). */
export function elementsFeature(enabled: boolean): CanvasFeature {
  return enabled ? { id: 'elements', panels: [ELEMENTS_PANEL_SPEC] } : { id: 'elements' }
}

export const feature: CanvasFeature = elementsFeature(ELEMENTS_PANEL)
