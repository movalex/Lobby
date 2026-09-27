// Inserting a @draftroom/templates template into the open board (PRE-02/03): ordinary editable shapes
// + arrow bindings, placed in empty space near the viewport centre, on top of existing content,
// selected, brought into view, and one undo step.

import type { Editor, TLBindingCreate, TLRecord, TLShape, TLShapeId } from 'tldraw'
import { instantiateTemplate, type TemplateId } from './deps.ts'
import { findEmptySpot, type Point, type Rect } from './placement.ts'

export interface InsertTemplateOptions {
  /** 'ignore' for the dashboard's "new board from template" (the board starts with it: nothing to undo). */
  history?: 'record' | 'ignore'
  /** Page point to place near; default: the viewport centre. */
  near?: Point
  animate?: boolean
}

export type InsertTemplateResult =
  | { ok: true; shapeIds: TLShapeId[]; bounds: Rect }
  | { ok: false; reason: 'readonly' | 'too-many-shapes' | 'failed' }

/** Page bounds of the current page's top-level shapes (frames contain their children). */
function topLevelObstacles(editor: Editor): Rect[] {
  const pageId = editor.getCurrentPageId()
  const out: Rect[] = []
  for (const id of editor.getSortedChildIdsForParent(pageId)) {
    const b = editor.getShapePageBounds(id)
    if (b) out.push({ x: b.x, y: b.y, w: b.w, h: b.h })
  }
  return out
}

export function insertTemplate(
  editor: Editor,
  templateId: TemplateId,
  opts: InsertTemplateOptions = {},
): InsertTemplateResult {
  if (editor.getIsReadonly()) return { ok: false, reason: 'readonly' }
  const pageId = editor.getCurrentPageId()
  try {
    // Measure at the origin, pick a free spot of that size, then build for real (fresh ids each call).
    const probe = instantiateTemplate(templateId, { pageId, origin: { x: 0, y: 0 } })
    const near = opts.near ?? editor.getViewportPageBounds().center
    const spot = findEmptySpot({ w: probe.bounds.w, h: probe.bounds.h }, near, topLevelObstacles(editor), {
      gap: 120,
    })
    const origin = { x: Math.round(spot.x - probe.bounds.x), y: Math.round(spot.y - probe.bounds.y) }
    const siblings = editor.getSortedChildIdsForParent(pageId)
    const lastId = siblings[siblings.length - 1]
    const indexAbove = lastId ? (editor.getShape(lastId)?.index ?? null) : null
    const { records, bounds } = instantiateTemplate(templateId, { pageId, origin, indexAbove })

    const shapes = records.filter((r): r is TLShape => r.typeName === 'shape')
    const bindings = records.filter(
      (r): r is Extract<TLRecord, { typeName: 'binding' }> => r.typeName === 'binding',
    )
    if (!editor.canCreateShapes(shapes.map((s) => s.id))) return { ok: false, reason: 'too-many-shapes' }
    const topIds = shapes.filter((s) => s.parentId === pageId).map((s) => s.id)

    const apply = () => {
      editor.createShapes(shapes)
      editor.createBindings(bindings as unknown as TLBindingCreate[])
      editor.select(...topIds)
    }
    if (opts.history === 'ignore') {
      editor.run(apply, { history: 'ignore' })
    } else {
      editor.markHistoryStoppingPoint(`insert template ${templateId}`)
      editor.run(apply)
    }
    if (!topIds.every((id) => editor.getShape(id))) return { ok: false, reason: 'failed' }
    editor.zoomToBounds(bounds, {
      targetZoom: 1,
      ...(opts.animate === false ? { immediate: true } : { animation: { duration: 320 } }),
    })
    return { ok: true, shapeIds: topIds, bounds }
  } catch (e) {
    console.error('template insert failed', e)
    return { ok: false, reason: 'failed' }
  }
}
