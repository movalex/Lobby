// canvas-ux's listeners on the board's input stream (`canvas.on('input')`: capture-phase events over the
// canvas, before the engine acts; `handled()` keeps the engine from acting):
//  - a right-click opens Lobby's context menu (./context-menu-open.ts); inside an open text editor the
//    textarea keeps its own;
//  - RETRO-21b: a double-click on empty canvas makes a sticky note there (inside the unlocked frame under
//    it) and edits it, instead of the engine's text box; a double-click on an element still edits it, and
//    one on a frame's name renames the frame (RETRO-14). Nothing is made on something locked, or inside a
//    locked frame: F8's hint explains why;
//  - RETRO-02: the note left selected by finishing an edit is remembered until the selection changes or
//    the board is pressed again (./keys.ts reads it).
import type {
  CanvasElement,
  CanvasFeatureContext,
  CanvasInputEvent,
  ScenePoint,
} from '../../../canvas/api/index.ts'
import { openContextMenu } from './context-menu-open.ts'
import { FRAME_NAME_BAND_PX } from './FrameRename.tsx'
import { createNoteAt, frameAt } from './notes.ts'
import { uxState } from './state.ts'

/** The frame whose name (drawn above its top edge) is at `point`, or null. */
export function frameNameAt(ctx: CanvasFeatureContext, point: ScenePoint): CanvasElement | null {
  const zoom = ctx.canvas.viewport.get().zoom
  const band = FRAME_NAME_BAND_PX / zoom
  for (const el of ctx.canvas.items()) {
    if (el.type !== 'frame' || (el as { isDeleted?: boolean }).isDeleted) continue
    if (point.x >= el.x && point.x <= el.x + el.width && point.y <= el.y && point.y >= el.y - band) return el
  }
  return null
}

/** What a double-click on the canvas does for canvas-ux (pure over the canvas; `null`: not ours). */
export function doubleClickAction(
  ctx: CanvasFeatureContext,
  e: {
    scene: ScenePoint
    hit: CanvasElement | null
    shift: boolean
    ctrl: boolean
    meta: boolean
    alt: boolean
  },
): { kind: 'note' } | { kind: 'rename'; frameId: string } | { kind: 'swallow' } | null {
  const { canvas } = ctx
  if (e.shift || e.ctrl || e.meta || e.alt) return null
  if (canvas.readOnly() || canvas.tool() !== 'select' || canvas.editingId() !== null) return null
  const named = frameNameAt(ctx, e.scene)
  if (named) return named.locked ? { kind: 'swallow' } : { kind: 'rename', frameId: named.id }
  const hit = e.hit
  // an element (not a frame's empty inside) edits as usual
  if (hit && hit.type !== 'frame') return null
  const frame = hit ?? frameAt(canvas, e.scene)
  if (frame && canvas.isLocked(frame.id)) return { kind: 'swallow' }
  return { kind: 'note' }
}

export function installCanvasEvents(ctx: CanvasFeatureContext): () => void {
  const { canvas } = ctx
  const state = uxState(canvas)
  const offs: (() => void)[] = []
  /** the editor Escape closed (the note it leaves stays selected, as on the tldraw page) */
  let escaped: string | null = null
  offs.push(
    canvas.on('input', (e: CanvasInputEvent) => {
      if (e.type === 'key-down') {
        if (e.key === 'Escape' && canvas.editingId() !== null) escaped = canvas.editingId()
        return
      }
      if (e.type === 'pointer-down') {
        state.leftEditing.set(null)
        return
      }
      if (e.type === 'context-menu') {
        if (canvas.editingId() !== null) return
        e.handled()
        openContextMenu(ctx, e.scene, e.hit, false)
        return
      }
      if (e.type !== 'double-click' || e.button !== 0) return
      const action = doubleClickAction(ctx, e)
      if (!action) return
      e.handled()
      if (action.kind === 'rename') state.renamingFrame.set(action.frameId)
      else if (action.kind === 'note') createNoteAt(ctx, e.scene)
    }),
  )
  let editing = canvas.editingId()
  offs.push(
    canvas.on('editingChanged', (id) => {
      const prev = editing
      editing = id
      if (id !== null) {
        state.leftEditing.set(null)
        return
      }
      const el = prev ? canvas.get(prev) : undefined
      const byEscape = escaped !== null && escaped === prev
      escaped = null
      if (el?.type !== 'stickynote') {
        state.leftEditing.set(null)
        return
      }
      // Escape leaves the note selected (the engine may clear the selection when an editor it opened
      // for a new note closes): the next key is a command for it, Enter edits it again
      if (byEscape && canvas.selection.length === 0 && !(el as { isDeleted?: boolean }).isDeleted)
        canvas.select([el.id])
      state.leftEditing.set(el.id)
    }),
  )
  offs.push(
    canvas.on('selectionChanged', (ids) => {
      const left = state.leftEditing.get()
      if (left && ids.length > 0 && !(ids.length === 1 && ids[0] === left)) state.leftEditing.set(null)
    }),
  )
  return () => {
    for (const off of offs.reverse()) off()
    state.leftEditing.set(null)
  }
}
