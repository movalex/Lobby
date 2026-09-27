// RETRO-21b (COL-09): a double-click on empty canvas makes a sticky note there (Miro), not tldraw's text
// box. tldraw's own canvas double-click is switched off (options.createTextOnCanvasDoubleClick: false,
// index.tsx); this runs after tldraw has handled the double-click, and only when it hit nothing (the
// same hit test tldraw's SelectTool Idle uses), so a double-click on a note still places the caret and
// one on a shape still edits its label.

import {
  createShapeId,
  type Editor,
  startEditingShapeWithRichText,
  type TLEventInfo,
  type TLParentId,
  type TLShape,
  type TLShapeId,
  type VecLike,
} from 'tldraw'
import { NOTE_SIZE } from './deps.ts'

/**
 * What tldraw's Idle.onDoubleClick (canvas target) would treat as "a shape was double-clicked", plus
 * anything locked there (a locked shape, or the inside of a locked frame, takes no new note: F8's hint
 * explains why instead).
 */
function hitsSomething(editor: Editor, point: VecLike): boolean {
  const margin = editor.getHitTestMargin()
  if (editor.overlays.getOverlayAtPoint(point, margin)) return true
  const hovered = editor.getHoveredShape()
  if (hovered && hovered.type !== 'group') return true
  if (editor.getSelectedShapeAtPoint(point) ?? editor.getShapeAtPoint(point, { margin, hitInside: false }))
    return true
  const locked = editor.getShapeAtPoint(point, {
    margin,
    hitInside: true,
    hitFrameInside: true,
    hitLocked: true,
    filter: (s) => editor.isShapeOrAncestorLocked(s),
  })
  return locked !== undefined
}

/** The innermost unlocked frame whose area contains the point (the note goes inside it). */
function frameAt(editor: Editor, point: VecLike): TLShape | undefined {
  return editor.getShapeAtPoint(point, {
    hitInside: true,
    hitFrameInside: true,
    filter: (s) => s.type === 'frame' && !editor.isShapeOrAncestorLocked(s),
  })
}

/** Creates a note centred on `point` (page space), in the frame there, and starts editing it. */
export function createNoteAt(editor: Editor, point: VecLike): TLShapeId | null {
  const id = createShapeId()
  const frame = frameAt(editor, point)
  const topLeft = { x: point.x - NOTE_SIZE / 2, y: point.y - NOTE_SIZE / 2 }
  const local = frame ? editor.getPointInShapeSpace(frame, topLeft) : topLeft
  const parentId: TLParentId = frame ? frame.id : editor.getCurrentPageId()
  editor.markHistoryStoppingPoint('create note')
  // Colour, font and size come from the styles for the next shape (the last-used note colour).
  editor.createShapes([{ id, type: 'note', x: local.x, y: local.y, parentId }])
  const shape = editor.getShape(id)
  if (!shape) return null
  startEditingShapeWithRichText(editor, shape)
  return id
}

export function registerDoubleClickNote(editor: Editor): () => void {
  const onEvent = (info: TLEventInfo) => {
    if (info.type !== 'click' || info.name !== 'double_click' || info.phase !== 'down') return
    if (info.target !== 'canvas' || info.shiftKey || info.ctrlKey || editor.inputs.getShiftKey()) return
    // tldraw handled the double-click first: if it hit a shape it is editing it now.
    if (editor.getIsReadonly() || !editor.isIn('select.idle') || editor.getEditingShapeId()) return
    const point = editor.inputs.getCurrentPagePoint()
    if (hitsSomething(editor, point)) return
    createNoteAt(editor, point)
  }
  editor.on('event', onEvent)
  return () => editor.off('event', onEvent)
}
