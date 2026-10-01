// MAK-17 on the new canvas: select every item of one type on the board, or narrow the selection to one
// type (rules in the tldraw build's select-by-type.ts, over ./model.ts's element adapters). Selection is
// per person (view state), so nothing here writes to the board.
import type { CanvasFeatureContext, LobbyCanvas } from '../../../../canvas/api/index.ts'
import {
  categoryLabel,
  countCategories,
  keepOnlyChoices,
  pickCategory,
  type TypeCategory,
} from '../../select-by-type.ts'
import { boardLites, selectionLites } from './model.ts'

/** Categories on the board with their selectable counts (reactive). */
export const boardCategoryCounts = (canvas: LobbyCanvas) => countCategories(boardLites(canvas))

/** "Keep only" choices for the current selection (reactive; empty when nothing would change). */
export function selectionKeepOnlyChoices(canvas: LobbyCanvas) {
  if (canvas.selection.length === 0) return []
  const { selected, withInside } = selectionLites(canvas)
  return keepOnlyChoices(selected, withInside)
}

/** "notes" / "note", "text boxes" / "text box". */
const noun = (category: TypeCategory, n: number) => {
  if (category === 'text') return n === 1 ? 'text box' : 'text boxes'
  const label = categoryLabel(category).toLowerCase()
  return n === 1 ? label.replace(/s$/, '') : label
}

function applySelection(ctx: CanvasFeatureContext, ids: string[], what: string) {
  const { canvas } = ctx
  if (canvas.tool() !== 'select') canvas.setTool('select')
  canvas.select(ids)
  ctx.notify({
    key: 'select-by-type',
    text: ids.length === 1 ? `1 ${what} selected.` : `${ids.length} ${what} selected.`,
    testId: 'select-by-type-notice',
    timeoutMs: 3000,
  })
}

/** Selects every selectable item of `category` on the board. Returns how many. */
export function selectAllOfCategory(ctx: CanvasFeatureContext, category: TypeCategory): number {
  const ids = pickCategory(boardLites(ctx.canvas), category)
  if (!ids.length) return 0
  applySelection(ctx, ids, noun(category, ids.length))
  return ids.length
}

/** Narrows the selection (and what is inside its frames) to `category`. Returns how many. */
export function keepOnlyCategory(ctx: CanvasFeatureContext, category: TypeCategory): number {
  const { withInside } = selectionLites(ctx.canvas)
  const ids = pickCategory(withInside, category)
  if (!ids.length) return 0
  applySelection(ctx, ids, noun(category, ids.length))
  return ids.length
}
