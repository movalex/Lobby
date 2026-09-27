// COL-05 wiring: a 'text' external-content handler. Single cells (a word, a sentence, a URL that
// reached the text path) go straight to tldraw's default text handler; multi-line / TSV / CSV text opens
// the "Paste as sticky notes or as text?" prompt (BulkPastePrompt in the overlay), at the pointer.
//
// RETRO-01: the paste point is the pointer when it is over the canvas (Ctrl/Cmd+V where you are
// looking, as in Miro), the point a context menu was opened at, or the viewport centre (a paste from
// the main menu, or from the keyboard with the pointer off the canvas). The grid goes to the nearest
// empty spot there, into the frame under that point when it fits (bulk-paste.ts placeBulkGrid).

import {
  DefaultColorStyle,
  DefaultFontStyle,
  defaultHandleExternalTextContent,
  type Editor,
  type TLEventInfo,
  type TLShape,
  type TLShapeId,
} from 'tldraw'
import { getFeatureCtx, pendingPaste } from './bridge.ts'
import {
  analyzeBulkPaste,
  buildBulkNotes,
  pickPlainText,
  placeBulkGrid,
  truncationMessage,
} from './bulk-paste.ts'
import { DEFAULT_MAX_NOTES } from './deps.ts'
import { containingFrame, type Point, type Rect, rectContains } from './placement.ts'

let pasteSeq = 0

/** Where a paste without an explicit point lands: the pointer over the canvas, else the viewport centre. */
export function pastePoint(editor: Editor): Point {
  const p =
    editor.getInstanceState().isHoveringCanvas === true
      ? editor.inputs.getCurrentPagePoint()
      : editor.getViewportPageBounds().center
  return { x: p.x, y: p.y }
}

export function registerBulkPaste(editor: Editor): () => void {
  editor.registerExternalContentHandler('text', async (content) => {
    const text = pickPlainText(content)
    const analysis = editor.getIsReadonly() ? null : analyzeBulkPaste(text)
    if (!analysis) {
      await defaultHandleExternalTextContent(editor, content)
      return
    }
    const center = content.point ? { x: content.point.x, y: content.point.y } : pastePoint(editor)
    pendingPaste(editor).set({
      id: ++pasteSeq,
      text,
      analysis,
      center,
      asText: () => defaultHandleExternalTextContent(editor, content),
    })
  })
  // Working on the canvas instead of answering dismisses the prompt (nothing is pasted).
  const onEvent = (info: TLEventInfo) => {
    if (info.type === 'pointer' && info.name === 'pointer_down' && pendingPaste(editor).get()) {
      pendingPaste(editor).set(null)
    }
  }
  editor.on('event', onEvent)
  return () => {
    editor.off('event', onEvent)
    pendingPaste(editor).set(null)
    editor.registerExternalContentHandler('text', (content) =>
      defaultHandleExternalTextContent(editor, content),
    )
  }
}

function boundsOf(editor: Editor, shape: TLShape | TLShapeId): Rect | null {
  const b = editor.getShapePageBounds(shape)
  return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null
}

/** The innermost unlocked frame whose page bounds contain `point`. */
function frameUnder(editor: Editor, point: Point): TLShape | undefined {
  return editor.getShapeAtPoint(point, {
    hitInside: true,
    hitFrameInside: true,
    filter: (s) => s.type === 'frame' && !editor.isShapeOrAncestorLocked(s),
  })
}

/**
 * "Paste as sticky notes": one note per non-empty cell (a long single column or row as a compact
 * grid), centred on the paste point and moved to the nearest empty spot, inside the frame under the
 * paste point when it fits there; all selected, one undo step.
 */
export function pasteAsNotes(editor: Editor, text: string, center: { x: number; y: number }): TLShapeId[] {
  const ctx = getFeatureCtx(editor)
  const pageId = editor.getCurrentPageId()
  const result = buildBulkNotes(text, {
    center,
    pageId,
    color: editor.getStyleForNextShape(DefaultColorStyle),
    font: editor.getStyleForNextShape(DefaultFontStyle),
    maxNotes: DEFAULT_MAX_NOTES,
  })
  if (!result.shapes.length) return []
  const ids = result.shapes.map((s) => s.id)
  if (!editor.canCreateShapes(ids)) {
    ctx?.notify({
      key: 'bulk-paste',
      text: 'This board has too many objects to paste that many notes.',
      tone: 'error',
      testId: 'bulk-paste-notice',
    })
    return []
  }

  // Obstacles: the target frame's children, or the page's top-level shapes (frames included).
  const target = frameUnder(editor, center)
  const targetBounds = target ? boundsOf(editor, target) : null
  const rectsOf = (childIds: readonly TLShapeId[]) =>
    childIds.flatMap((id) => {
      const b = boundsOf(editor, id)
      return b ? [b] : []
    })
  const placement = placeBulkGrid({
    size: { w: result.bounds.w, h: result.bounds.h },
    center,
    frame: targetBounds,
    frameObstacles: target ? rectsOf(editor.getSortedChildIdsForParent(target.id)) : [],
    pageObstacles: rectsOf(editor.getSortedChildIdsForParent(pageId)),
  })
  const dx = placement.topLeft.x - result.bounds.x
  const dy = placement.topLeft.y - result.bounds.y
  const shapes = result.shapes.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }))
  const bounds = { ...result.bounds, x: result.bounds.x + dx, y: result.bounds.y + dy }

  // Parent into the frame under the paste point when the grid is inside it; else into whichever
  // unlocked frame fully contains the grid (if any).
  let frameId: TLShapeId | null = null
  if (target && targetBounds && placement.inFrame && rectContains(targetBounds, bounds)) frameId = target.id
  else {
    const frames = editor
      .getCurrentPageShapes()
      .filter((s) => s.type === 'frame' && !editor.isShapeOrAncestorLocked(s))
      .flatMap((s) => {
        const b = boundsOf(editor, s)
        return b ? [{ id: s.id, bounds: b }] : []
      })
    frameId = (containingFrame(bounds, frames)?.id as TLShapeId | undefined) ?? null
  }

  editor.markHistoryStoppingPoint('paste as notes')
  editor.run(() => {
    editor.createShapes(shapes)
    if (frameId) editor.reparentShapes(ids, frameId)
    editor.select(...ids)
  })
  // Keep the whole grid in view (zooming out only, never in).
  const vp = editor.getViewportPageBounds()
  if (!rectContains({ x: vp.x, y: vp.y, w: vp.w, h: vp.h }, bounds)) {
    editor.zoomToBounds(bounds, { targetZoom: editor.getZoomLevel(), animation: { duration: 220 } })
  }
  const msg = truncationMessage(result.shapes.length, result.omitted, result.textShortened, DEFAULT_MAX_NOTES)
  if (msg) ctx?.notify({ key: 'bulk-paste', text: msg, timeoutMs: 10_000, testId: 'bulk-paste-notice' })
  return ids
}
