// L8-3 (wave L, W8): Pieces, the shape kits. A dock panel to search and insert flowchart, wireframe, org chart
// and agency pieces (native elements with semantic markers, `@draftroom/templates/pieces`), a command for each
// piece for the palette ('Insert decision'), and the drop of a piece from the panel onto the board.
// Inert until someone inserts a piece. W3 registers `feature` (features/canvas-registry.ts).
//
// Wave Q (WS3): when the Elements panel is on (../elements/flags.ts elementsPanelOn), its Shapes tab is where the
// pieces are, so this dock entry retires: the panel is not registered, `pieces.open` opens the Elements panel on its
// Shapes tab, and every `pieces.insert.*` command and the `lobby-piece:` drop stay as they are.

import { isReadonlyRole } from '../../board/access.ts'
import type { CanvasFeature, CanvasPanelSpec } from '../../canvas/api/index.ts'
import { elementsPanelOn } from '../elements/flags.ts'
import { COMMANDS, DROP_HANDLER, PANEL_ID } from './commands.ts'
import { PiecesIcon } from './icons.tsx'
import { PiecesPanel } from './PiecesPanel.tsx'

export const SHAPES_PANEL: CanvasPanelSpec = {
  id: PANEL_ID,
  label: 'Shapes',
  icon: PiecesIcon,
  order: 35,
  // inserting is editing: viewers, commenters and archived boards get no panel
  visible: (ctx) => !isReadonlyRole(ctx.role, ctx.board.status),
  component: PiecesPanel,
}

/** The feature with its dock entry, or without it once the Elements panel has taken its place. */
export function piecesFeature(elementsOn: boolean): CanvasFeature {
  return {
    id: 'pieces',
    panels: elementsOn ? [] : [SHAPES_PANEL],
    commands: COMMANDS,
    contentHandlers: [DROP_HANDLER],
  }
}

export const feature: CanvasFeature = piecesFeature(elementsPanelOn())
