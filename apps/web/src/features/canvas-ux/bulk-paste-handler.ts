// COL-05 wiring: a 'text' external-content handler. Single cells (a word, a sentence, a URL that
// reached the text path) go straight to tldraw's default text handler; multi-line / TSV / CSV text opens
// the "Paste as sticky notes or as text?" prompt (BulkPastePrompt in the overlay).

import {
  DefaultColorStyle,
  defaultHandleExternalTextContent,
  type Editor,
  type TLEventInfo,
  type TLShapeId,
} from 'tldraw'
import { getFeatureCtx, pendingPaste } from './bridge.ts'
import { analyzeBulkPaste, buildBulkNotes, pickPlainText, truncationMessage } from './bulk-paste.ts'
import { DEFAULT_MAX_NOTES } from './deps.ts'
import { containingFrame, rectContains } from './placement.ts'

let pasteSeq = 0

export function registerBulkPaste(editor: Editor): () => void {
  editor.registerExternalContentHandler('text', async (content) => {
    const text = pickPlainText(content)
    const analysis = editor.getIsReadonly() ? null : analyzeBulkPaste(text)
    if (!analysis) {
      await defaultHandleExternalTextContent(editor, content)
      return
    }
    const center =
      content.point ??
      (editor.inputs.getShiftKey()
        ? editor.inputs.getCurrentPagePoint()
        : editor.getViewportPageBounds().center)
    pendingPaste(editor).set({
      id: ++pasteSeq,
      text,
      analysis,
      center: { x: center.x, y: center.y },
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

/**
 * "Paste as sticky notes": one note per non-empty cell in the source layout, centred on the paste
 * point, inside the frame that fully contains the grid (if any), all selected, one undo step.
 */
export function pasteAsNotes(editor: Editor, text: string, center: { x: number; y: number }): TLShapeId[] {
  const ctx = getFeatureCtx(editor)
  const color = editor.getStyleForNextShape(DefaultColorStyle)
  const result = buildBulkNotes(text, {
    center,
    pageId: editor.getCurrentPageId(),
    color,
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
  const frames = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === 'frame' && !editor.isShapeOrAncestorLocked(s))
    .flatMap((s) => {
      const b = editor.getShapePageBounds(s)
      return b ? [{ id: s.id, bounds: { x: b.x, y: b.y, w: b.w, h: b.h } }] : []
    })
  const frame = containingFrame(result.bounds, frames)
  editor.markHistoryStoppingPoint('paste as notes')
  editor.run(() => {
    editor.createShapes(result.shapes)
    if (frame) editor.reparentShapes(ids, frame.id as TLShapeId)
    editor.select(...ids)
  })
  // Keep the whole grid in view (zooming out only, never in).
  const vp = editor.getViewportPageBounds()
  if (!rectContains({ x: vp.x, y: vp.y, w: vp.w, h: vp.h }, result.bounds)) {
    editor.zoomToBounds(result.bounds, { targetZoom: editor.getZoomLevel(), animation: { duration: 220 } })
  }
  const msg = truncationMessage(result.shapes.length, result.omitted, result.textShortened, DEFAULT_MAX_NOTES)
  if (msg) ctx?.notify({ key: 'bulk-paste', text: msg, timeoutMs: 10_000, testId: 'bulk-paste-notice' })
  return ids
}
