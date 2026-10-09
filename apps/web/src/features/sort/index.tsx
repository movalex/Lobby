// L8-1 and L8-2 (wave L, W8): sort notes into labelled columns, and place them on a 2x2.
//  - "Sort" in the selection bar and "Sort by" in the context menu, for two or more notes or a frame, open the
//    ways to sort: by colour, author, tag or votes (deterministic: the palette's order, whoever made the note,
//    the first tag, the last revealed vote), and, with AI, by a lens the person names or onto a 2x2 scored on two
//    axes. Each is also a command for the palette (./commands.ts).
//  - the columns are laid out like "Group into themes" (the theme cluster layout, ../ai/layout.ts): in the
//    room the notes occupied, clear of what stays, a frame only grows, no note leaves its frame, headings from
//    an earlier run replaced. One undo step; over 10 moves the preview (W2's showAiPreview) asks first.
//  - a note that is locked, under another tab's text lease or being dragged by someone else is skipped and
//    counted; the client writes the notes' x and y and the new headings, never an arrow (the server re-snaps
//    what is bound to a note that moved, in the same commit).
// W3 registers `feature` (features/canvas-registry.ts).
import type { CanvasFeature } from '../../canvas/api/index.ts'
import { COMMANDS, CONTEXT_MENU } from './commands.ts'
import { installSortDevHook } from './dev-hook.ts'
import { ScoresLayer } from './Scores.tsx'
import { SELECTION_BAR } from './SelectionBar.tsx'
import { SortOverlay } from './SortMenu.tsx'
import { clearScores } from './scores.ts'
import { closeSortMenu, setSortCtx } from './state.ts'

export const feature: CanvasFeature = {
  id: 'sort',
  commands: COMMANDS,
  contextMenu: CONTEXT_MENU,
  selectionBar: SELECTION_BAR,
  overlays: [
    // the popover and the scores' legend take clicks through their own elements, the layer never
    { id: 'sort', layer: 'screen', order: 58, pointer: 'none', component: SortOverlay },
    { id: 'sort-scores', layer: 'scene', order: 40, pointer: 'none', component: ScoresLayer },
  ],
  onMount(ctx) {
    setSortCtx(ctx)
    const { canvas } = ctx
    const removeHook = installSortDevHook(ctx)
    return () => {
      removeHook()
      closeSortMenu(canvas, false)
      clearScores(canvas)
    }
  },
}
