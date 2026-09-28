// MAK-18 wiring: "Arrange as grid" on the editor (layout rules in arrange-grid.ts). One undo step per
// arrangement (and per column change from the stepper); ordinary shape updates, so collaborators see
// the result through the board's sync like any move.
//
// What moves: the selected shapes, minus locked ones (or ones inside a locked frame/group), minus
// connectors attached to something (they follow the shapes they connect), minus shapes whose frame or
// group is itself selected (they move with it). The grid lives in the parent every moved shape shares;
// when they sit in different frames, in their closest common frame/group (the page if none) — the
// shapes are re-parented there first, so none ends up clipped inside a frame it no longer overlaps. A
// shape inside some other group moves as that whole group (groups are never broken up).

import { Box, type Editor, isShapeId, type TLParentId, type TLShape, type TLShapeId } from 'tldraw'
import { arrangeAsGrid, type GridItem } from './arrange-grid.ts'
import { type GridSession, getFeatureCtx, gridSession } from './bridge.ts'

const sortedIds = (ids: readonly string[]) => [...ids].sort()

/** A connector attached at either end: it follows the shapes it connects. */
function followsBindings(editor: Editor, shape: TLShape): boolean {
  return shape.type === 'arrow' && editor.getBindingsFromShape(shape, 'arrow').length > 0
}

export interface ArrangeableSelection {
  shapes: TLShape[]
  /** Selected shapes that stay where they are because they (or a frame/group around them) are locked. */
  locked: number
}

/**
 * The selected shapes "Arrange as grid" moves (reactive: fine inside useValue). With `stopAt`, stops
 * looking once that many movable shapes are found (the selection bar only needs to know "two or more").
 */
export function arrangeableSelection(
  editor: Editor,
  stopAt = Number.POSITIVE_INFINITY,
): ArrangeableSelection {
  const ids = editor.getSelectedShapeIds()
  const selected = new Set<string>(ids)
  const shapes: TLShape[] = []
  let locked = 0
  for (const id of ids) {
    if (shapes.length >= stopAt) break
    const shape = editor.getShape(id)
    if (!shape) continue
    if (editor.getShapeAncestors(shape).some((a) => selected.has(a.id))) continue
    if (editor.isShapeOrAncestorLocked(shape)) {
      locked++
      continue
    }
    if (followsBindings(editor, shape)) continue
    shapes.push(shape)
  }
  return { shapes, locked }
}

/** At least two selected shapes can be arranged (cheap on a large selection). */
export function hasArrangeable(editor: Editor): boolean {
  return arrangeableSelection(editor, 2).shapes.length >= 2
}

export function canArrangeAsGrid(editor: Editor): boolean {
  return !editor.getIsReadonly() && hasArrangeable(editor)
}

/** The parent the grid lives in: the shared parent, else the closest common ancestor, else the page. */
function gridParent(editor: Editor, shapes: readonly TLShape[]): TLParentId {
  const first = shapes[0]?.parentId ?? editor.getCurrentPageId()
  if (shapes.every((s) => s.parentId === first)) return first
  return editor.findCommonAncestor([...shapes]) ?? editor.getCurrentPageId()
}

/**
 * A shape inside a group that is not the grid's parent moves as that group (the outermost such group
 * below the grid's parent), so arranging never pulls a shape out of its group (tldraw would dissolve a
 * group left with one child). Frames are different: shapes do leave frames for a shared grid.
 */
function asGridUnits(editor: Editor, shapes: readonly TLShape[], parentId: TLParentId): TLShape[] {
  const units = new Map<string, TLShape>()
  for (const shape of shapes) {
    let unit = shape
    let up = editor.getShapeParent(shape)
    while (up && up.id !== parentId) {
      if (editor.isShapeOfType(up, 'group')) unit = up
      up = editor.getShapeParent(up)
    }
    units.set(unit.id, unit)
  }
  return [...units.values()]
}

/** Axis-aligned bounds of a shape in its parent's space (rotation included). */
function boundsInParent(editor: Editor, shape: TLShape): Box {
  const geometry = editor.getShapeGeometry(shape).bounds
  return Box.FromPoints(editor.getShapeLocalTransform(shape).applyToPoints(geometry.corners))
}

/** The stepper's session when it still describes the current selection and nothing has moved since. */
export function currentGridSession(editor: Editor): GridSession | null {
  const s = gridSession(editor).get()
  if (!s) return null
  const ids = editor.getSelectedShapeIds()
  if (ids.length !== s.selection.length) return null
  const selection = sortedIds(ids)
  if (selection.length !== s.selection.length || selection.some((id, i) => id !== s.selection[i])) return null
  for (const [id, p] of Object.entries(s.placed)) {
    const shape = editor.getShape(id as TLShapeId)
    if (!shape || shape.x !== p.x || shape.y !== p.y) return null
  }
  return s
}

export interface ArrangeOutcome {
  moved: number
  columns: number
  rows: number
  frameGrew: boolean
  locked: number
}

/**
 * Arranges the selection as a grid. `columns` = an explicit count (the stepper): it keeps the fill order
 * of the grid being adjusted. Returns null when there is nothing to arrange (fewer than two movable
 * shapes, or a read-only board).
 */
export function arrangeSelectionAsGrid(
  editor: Editor,
  opts: { columns?: number } = {},
): ArrangeOutcome | null {
  if (editor.getIsReadonly()) return null
  const { shapes, locked } = arrangeableSelection(editor)
  if (shapes.length < 2) return null
  const session = opts.columns !== undefined ? currentGridSession(editor) : null
  const selection = sortedIds(editor.getSelectedShapeIds())

  const parentId = gridParent(editor, shapes)
  const units = asGridUnits(editor, shapes, parentId)
  if (units.length < 2) return null

  let outcome: ArrangeOutcome | null = null
  editor.markHistoryStoppingPoint('dr-arrange-grid')
  editor.run(() => {
    const outside = units.filter((s) => s.parentId !== parentId).map((s) => s.id)
    if (outside.length) editor.reparentShapes(outside, parentId)
    const fresh = units.map((s) => editor.getShape(s.id)).filter((s): s is TLShape => !!s)
    const items: GridItem[] = fresh.map((s) => {
      const b = boundsInParent(editor, s)
      return { id: s.id, x: b.x, y: b.y, w: b.w, h: b.h }
    })
    const parent = isShapeId(parentId) ? editor.getShape(parentId) : undefined
    const frameShape = parent && editor.isShapeOfType(parent, 'frame') ? parent : undefined
    const frame = frameShape ? { w: frameShape.props.w, h: frameShape.props.h } : undefined
    const plan = arrangeAsGrid({ items, columns: opts.columns, order: session?.order, frame })
    if (!plan) return
    const byId = new Map(items.map((i) => [i.id, i]))
    const updates = fresh.map((s) => {
      const from = byId.get(s.id) as GridItem
      const to = plan.positions[s.id] ?? { x: from.x, y: from.y }
      return { id: s.id, type: s.type, x: s.x + (to.x - from.x), y: s.y + (to.y - from.y) }
    })
    if (plan.frameSize && frameShape) {
      editor.updateShape({ id: frameShape.id, type: 'frame', props: { ...plan.frameSize } })
    }
    editor.updateShapes(updates)
    const placed: GridSession['placed'] = {}
    for (const u of updates) placed[u.id] = { x: u.x, y: u.y }
    gridSession(editor).set({ selection, order: plan.order, columns: plan.columns, placed })
    outcome = {
      moved: updates.length,
      columns: plan.columns,
      rows: plan.rows,
      frameGrew: !!plan.frameSize,
      locked,
    }
  })
  return outcome as ArrangeOutcome | null
}

/** The keyboard shortcut / menu / selection-bar entry point: arranges, then says what needs saying. */
export function runArrangeAsGrid(editor: Editor, opts: { columns?: number } = {}): ArrangeOutcome | null {
  const outcome = arrangeSelectionAsGrid(editor, opts)
  const ctx = getFeatureCtx(editor)
  if (!ctx) return outcome
  if (!outcome) {
    if (!editor.getIsReadonly() && editor.getSelectedShapeIds().length > 0) {
      ctx.notify({
        key: 'arrange-grid',
        text: 'Select at least two unlocked objects to arrange them as a grid.',
        testId: 'arrange-grid-notice',
        timeoutMs: 4000,
      })
    }
    return null
  }
  const notes: string[] = []
  if (outcome.frameGrew) notes.push('The frame grew to fit the grid.')
  if (outcome.locked) {
    notes.push(
      outcome.locked === 1
        ? 'One locked object stayed where it was.'
        : `${outcome.locked} locked objects stayed where they were.`,
    )
  }
  if (notes.length) {
    ctx.notify({ key: 'arrange-grid', text: notes.join(' '), testId: 'arrange-grid-notice', timeoutMs: 5000 })
  } else ctx.dismiss('arrange-grid')
  return outcome
}
