// The comment tool: a tldraw StateNode registered at runtime with `editor.root.addChild` (public in
// 5.4.2; features cannot pass <Tldraw tools>). Click a shape to attach a comment to it, click empty
// canvas to pin one there; dragging pans like the hand tool; Esc closes the composer, then returns to
// the select tool. Works on read-only canvases (commenters): it never writes to the document.
//
// The tool id is 'comment', the id tldraw's own toolbar/quick-action slots look for. Its kbd is gated
// by tldraw's commenting licence, so the C shortcut is also bound through an action (overrides.ts).

import type { Editor } from 'tldraw'
import { StateNode, type TLPointerEventInfo, Vec } from 'tldraw'
import type { Point } from './model.ts'

export const COMMENT_TOOL_ID = 'comment'

export interface CommentToolHandler {
  /** A click (not a drag) at a page point. */
  place(pagePoint: Point): void
  /** Esc: close the composer/popover; return false when nothing was open (the tool then exits). */
  cancel(): boolean
  enter?(): void
  exit?(): void
}

const handlers = new WeakMap<Editor, CommentToolHandler>()

export function setCommentToolHandler(editor: Editor, handler: CommentToolHandler | null) {
  if (handler) handlers.set(editor, handler)
  else handlers.delete(editor)
}

/** Screen pixels a press may move and still count as a click. */
const CLICK_SLOP = 5

export class CommentTool extends StateNode {
  static override id = COMMENT_TOOL_ID
  static override isLockable = false

  private down: { screen: Vec; camera: Vec } | null = null
  private dragging = false

  override onEnter() {
    this.editor.setCursor({ type: 'comment', rotation: 0 })
    handlers.get(this.editor)?.enter?.()
  }

  override onExit() {
    this.down = null
    this.dragging = false
    handlers.get(this.editor)?.exit?.()
  }

  override onPointerDown(info: TLPointerEventInfo) {
    if (info.button !== 0) return
    this.editor.stopCameraAnimation()
    this.down = {
      screen: Vec.From(this.editor.inputs.getCurrentScreenPoint()),
      camera: Vec.From(this.editor.getCamera()),
    }
    this.dragging = false
  }

  override onPointerMove() {
    if (!this.down) return
    const current = this.editor.inputs.getCurrentScreenPoint()
    if (!this.dragging && Vec.Dist(current, this.down.screen) < CLICK_SLOP) return
    this.dragging = true
    this.editor.setCursor({ type: 'grabbing', rotation: 0 })
    const delta = Vec.Sub(current, this.down.screen).div(this.editor.getZoomLevel())
    this.editor.setCamera(this.down.camera.clone().add(delta))
  }

  override onPointerUp() {
    const wasDown = this.down
    const dragged = this.dragging
    this.down = null
    this.dragging = false
    if (dragged) this.editor.setCursor({ type: 'comment', rotation: 0 })
    if (!wasDown || dragged) return
    handlers.get(this.editor)?.place(Vec.From(this.editor.inputs.getCurrentPagePoint()))
  }

  override onCancel() {
    this.down = null
    const closed = handlers.get(this.editor)?.cancel() ?? false
    if (!closed) this.editor.setCurrentTool('select')
  }

  override onInterrupt() {
    this.down = null
    this.dragging = false
  }
}

/** Idempotent (React StrictMode mounts twice; a second addChild would throw). */
export function registerCommentTool(editor: Editor) {
  if (!editor.root.children?.[COMMENT_TOOL_ID]) editor.root.addChild(CommentTool)
}
