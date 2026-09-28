// MAK-17 wiring: select all shapes of one type on the current page, or narrow the selection to one type
// (rules in select-by-type.ts). Selection is per person (instance state + presence), so nothing here
// writes to the board document.

import type { Editor, TLShape, TLShapeId } from 'tldraw'
import { getFeatureCtx } from './bridge.ts'
import {
  categoryLabel,
  countCategories,
  keepOnlyChoices,
  pickCategory,
  type ShapeLite,
  type TypeCategory,
} from './select-by-type.ts'

function lite(editor: Editor, shape: TLShape): ShapeLite {
  return {
    id: shape.id,
    type: shape.type,
    ancestors: editor.getShapeAncestors(shape).map((a) => a.id),
    locked: editor.isShapeOrAncestorLocked(shape),
    hidden: editor.isShapeHidden(shape),
  }
}

const pageShapes = (editor: Editor) => editor.getCurrentPageShapes().map((s) => lite(editor, s))

function selectedAndInside(editor: Editor): { selected: ShapeLite[]; all: ShapeLite[] } {
  const ids = editor.getSelectedShapeIds()
  const selected = ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => !!s)
  const all = [...editor.getShapeAndDescendantIds([...ids])]
    .map((id) => editor.getShape(id))
    .filter((s): s is TLShape => !!s)
  return { selected: selected.map((s) => lite(editor, s)), all: all.map((s) => lite(editor, s)) }
}

/** Categories present on the current page with their selectable counts (reactive). */
export function pageCategoryCounts(editor: Editor) {
  return countCategories(pageShapes(editor))
}

/** "Keep only" choices for the current selection (reactive; empty when nothing would change). */
export function selectionKeepOnlyChoices(editor: Editor) {
  if (editor.getSelectedShapeIds().length === 0) return []
  const { selected, all } = selectedAndInside(editor)
  return keepOnlyChoices(selected, all)
}

function applySelection(editor: Editor, ids: string[], what: string) {
  if (editor.getCurrentToolId() !== 'select') editor.setCurrentTool('select')
  editor.setSelectedShapes(ids as TLShapeId[])
  getFeatureCtx(editor)?.notify({
    key: 'select-by-type',
    text: ids.length === 1 ? `1 ${what} selected.` : `${ids.length} ${what} selected.`,
    testId: 'select-by-type-notice',
    timeoutMs: 3000,
  })
}

/** "notes" / "note", "text boxes" / "text box". */
const noun = (category: TypeCategory, n: number) => {
  if (category === 'text') return n === 1 ? 'text box' : 'text boxes'
  const label = categoryLabel(category).toLowerCase()
  return n === 1 ? label.replace(/s$/, '') : label
}

/** Selects every selectable shape of `category` on the current page. Returns how many. */
export function selectAllOfCategory(editor: Editor, category: TypeCategory): number {
  const ids = pickCategory(pageShapes(editor), category)
  if (!ids.length) return 0
  applySelection(editor, ids, noun(category, ids.length))
  return ids.length
}

/** Narrows the selection (and what is inside its frames and groups) to `category`. Returns how many. */
export function keepOnlyCategory(editor: Editor, category: TypeCategory): number {
  const { all } = selectedAndInside(editor)
  const ids = pickCategory(all, category)
  if (!ids.length) return 0
  applySelection(editor, ids, noun(category, ids.length))
  return ids.length
}
