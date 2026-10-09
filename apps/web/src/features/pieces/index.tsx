// L8-3 (wave L, W8): Pieces, the shape kits. A dock panel to search and insert flowchart, wireframe, org chart
// and agency pieces (native elements with semantic markers, `@draftroom/templates/pieces`), a command for each
// piece for the palette ('Insert decision'), and the drop of a piece from the panel onto the board.
// Inert until someone inserts a piece. W3 registers `feature` (features/canvas-registry.ts).

import { isReadonlyRole } from '../../board/access.ts'
import type { CanvasFeature } from '../../canvas/api/index.ts'
import { COMMANDS, DROP_HANDLER, PANEL_ID } from './commands.ts'
import { PiecesIcon } from './icons.tsx'
import { PiecesPanel } from './PiecesPanel.tsx'

export const feature: CanvasFeature = {
  id: 'pieces',
  panels: [
    {
      id: PANEL_ID,
      label: 'Pieces',
      icon: PiecesIcon,
      order: 35,
      // inserting is editing: viewers, commenters and archived boards get no panel
      visible: (ctx) => !isReadonlyRole(ctx.role, ctx.board.status),
      component: PiecesPanel,
    },
  ],
  commands: COMMANDS,
  contentHandlers: [DROP_HANDLER],
}
