// OWNER: 3c. The comment tool on the Excalidraw board page (the tldraw page's ../tool.ts StateNode): a
// Lobby pointer tool (docs/EXCALIDRAW-CONTRACTS.md §3 `tools`) that never writes to the document, so it
// works for commenters and viewers. Click an element to attach a comment to it, click the board to pin one
// there; dragging pans like the hand tool. Its keys (Enter, Esc, Tab) are ./keys.ts.
//
// The clicks and drags come from the canvas's input stream (pointer-down, pointer-move, pointer-up over the
// canvas): with a Lobby pointer tool active the engine creates nothing and pans nothing, so the drag-to-pan
// is this module's, with `viewport.set`.

import type { CanvasFeatureContext, ScenePoint, ScreenPoint, Viewport } from '../../../canvas/api/index.ts'
import { COMMENT_TOOL_ID } from './controller.ts'

/** Screen pixels a press may move and still count as a click. */
const CLICK_SLOP = 5

export interface CommentToolHandler {
  /** A click (not a drag) at a scene point. */
  place(point: ScenePoint): void
}

/** Wires the click-to-comment and drag-to-pan of the comment tool; returns the cleanup. */
export function mountCommentTool(ctx: CanvasFeatureContext, handler: CommentToolHandler): () => void {
  const { canvas } = ctx
  let down: { screen: ScreenPoint; view: Viewport } | null = null
  let dragging = false
  const reset = () => {
    if (dragging) canvas.setCursor(null)
    down = null
    dragging = false
  }
  const off = canvas.on('input', (e) => {
    if (canvas.tool() !== COMMENT_TOOL_ID) {
      if (down) reset()
      return
    }
    if (e.type === 'pointer-down') {
      if (e.button !== 0) return
      canvas.viewport.stop()
      down = { screen: e.screen, view: canvas.viewport.get() }
      dragging = false
      return
    }
    if (e.type === 'pointer-move' && down) {
      const dx = e.screen.x - down.screen.x
      const dy = e.screen.y - down.screen.y
      if (!dragging && Math.hypot(dx, dy) < CLICK_SLOP) return
      if (!canvas.pointer()?.down) {
        reset()
        return
      }
      dragging = true
      canvas.setCursor('grabbing')
      canvas.viewport.set({ x: down.view.x - dx / down.view.zoom, y: down.view.y - dy / down.view.zoom })
      return
    }
    if (e.type === 'pointer-up' && down) {
      const dragged = dragging
      reset()
      if (!dragged) handler.place(e.scene)
    }
  })
  // a press released off the canvas (over the chrome, outside the window) ends the drag there
  const onUp = () => {
    if (down && !canvas.pointer()?.overCanvas) reset()
  }
  const doc = canvas.container()?.ownerDocument ?? document
  doc.addEventListener('pointerup', onUp, true)
  return () => {
    off()
    doc.removeEventListener('pointerup', onUp, true)
    reset()
  }
}
