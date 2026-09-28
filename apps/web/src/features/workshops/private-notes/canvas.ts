// Canvas helpers for private brainstorming: where the notes will go (the selected frame, or a new
// "Private ideas" frame in view), finding the notes a session placed, and fitting their height to
// their text once they arrive.
//
// Why the fit: the sync server places the notes but cannot measure text, so it gives each note a
// conservative (tall) growY. The client that asked for the reveal measures them with tldraw's own
// note sizing and writes the real growY once (history: 'ignore', so nobody's undo includes it).

import { PRIVATE_FRAME_DEFAULT_NAME, PRIVATE_NOTE_META_KEY, type PrivateTarget } from '@draftroom/contracts'
import { createShapeId, type Editor, type TLNoteShape, type TLShape, type TLShapeId } from 'tldraw'

/** A new frame holds 4 × 3 notes before it grows (200 px notes, 24 px gaps, 40 px padding). */
export const NEW_FRAME_W = 2 * 40 + 4 * 200 + 3 * 24
export const NEW_FRAME_H = 2 * 40 + 3 * 200 + 2 * 24

/** The frame the selection is (or is inside), if any. */
export function selectedFrame(editor: Editor): TLShape | null {
  for (const s of editor.getSelectedShapes()) {
    if (s.type === 'frame') return s
    const anc = editor.findShapeAncestor(s, (a) => a.type === 'frame')
    if (anc) return anc
  }
  return null
}

export function frameName(shape: TLShape | null | undefined): string {
  const name = (shape?.props as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name.trim() ? name.trim() : 'Frame'
}

/** The target for an existing frame (its page bounds now). */
export function targetForFrame(editor: Editor, frame: TLShape): PrivateTarget | null {
  const b = editor.getShapePageBounds(frame)
  const pageId = editor.getAncestorPageId(frame)
  if (!b || !pageId) return null
  return { frameId: frame.id, pageId, x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h) }
}

/** Where a new frame goes: centred in the viewport, at a size that holds 12 notes. */
export function newFrameBounds(viewport: { x: number; y: number; w: number; h: number }) {
  return {
    x: Math.round(viewport.x + viewport.w / 2 - NEW_FRAME_W / 2),
    y: Math.round(viewport.y + viewport.h / 2 - NEW_FRAME_H / 2),
    w: NEW_FRAME_W,
    h: NEW_FRAME_H,
  }
}

/** Creates the "Private ideas" frame in view (a normal, undoable canvas edit) and returns its target. */
export function createPrivateFrame(editor: Editor): PrivateTarget {
  const id = createShapeId()
  const b = newFrameBounds(editor.getViewportPageBounds())
  editor.createShape({
    id,
    type: 'frame',
    x: b.x,
    y: b.y,
    props: { w: b.w, h: b.h, name: PRIVATE_FRAME_DEFAULT_NAME },
  })
  return { frameId: id, pageId: editor.getCurrentPageId(), ...b }
}

/** Notes a session placed, on any page (their meta names the session). */
export function placedNoteIds(editor: Editor, sessionId: string): TLShapeId[] {
  const out: TLShapeId[] = []
  for (const rec of editor.store.allRecords()) {
    if (rec.typeName !== 'shape' || rec.type !== 'note') continue
    const meta = (rec.meta as Record<string, unknown>)[PRIVATE_NOTE_META_KEY] as
      | { session?: unknown }
      | undefined
    if (meta?.session === sessionId) out.push(rec.id)
  }
  return out
}

/**
 * Makes tldraw measure the notes' text: a size change makes NoteShapeUtil.onBeforeUpdate recompute
 * growY and fontSizeAdjustment, so the notes go to another size and straight back, in one batch that
 * no undo history records. Only the net change (growY, fontSizeAdjustment) is synced.
 */
export function fitNotes(editor: Editor, ids: readonly TLShapeId[]) {
  const notes = ids
    .map((id) => editor.getShape(id))
    .filter((s): s is TLNoteShape => s?.type === 'note' && !s.isLocked)
  if (notes.length === 0 || editor.getIsReadonly()) return
  editor.run(
    () => {
      editor.updateShapes<TLNoteShape>(
        notes.map((n) => ({ id: n.id, type: 'note', props: { size: n.props.size === 's' ? 'm' : 's' } })),
      )
      editor.updateShapes<TLNoteShape>(
        notes.map((n) => ({ id: n.id, type: 'note', props: { size: n.props.size } })),
      )
    },
    { history: 'ignore' },
  )
}

/**
 * Fits the session's notes as they arrive (the canvas broadcast and the API's answer race), each
 * once, for up to `timeoutMs`. Returns a stop function.
 */
export function fitPlacedNotes(editor: Editor, sessionId: string, expected: number, timeoutMs = 15_000) {
  const done = new Set<string>()
  const run = () => {
    const fresh = placedNoteIds(editor, sessionId).filter((id) => !done.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) done.add(id)
    fitNotes(editor, fresh)
    if (done.size >= expected) stop()
  }
  const unlisten = editor.store.listen(() => run(), { source: 'remote', scope: 'document' })
  const timer = setTimeout(() => stop(), timeoutMs)
  let stopped = false
  function stop() {
    if (stopped) return
    stopped = true
    unlisten()
    clearTimeout(timer)
  }
  run()
  return stop
}

/**
 * Zooms to where a session's notes are: the frame holding them (the target, or the one recreated for
 * it when the target was deleted), else the target frame. Returns false when neither is on the board.
 */
export function zoomToSession(editor: Editor, sessionId: string, frameId: string): boolean {
  const note = placedNoteIds(editor, sessionId)
    .map((id) => editor.getShape(id))
    .find(Boolean)
  const parent = note ? editor.getShape(note.parentId as TLShapeId) : undefined
  const target = parent?.type === 'frame' ? parent : (editor.getShape(frameId as TLShapeId) ?? note)
  if (!target) return false
  const pageId = editor.getAncestorPageId(target)
  if (pageId && pageId !== editor.getCurrentPageId()) editor.setCurrentPage(pageId)
  const b = editor.getShapePageBounds(target)
  if (!b) return false
  editor.zoomToBounds(b, { animation: { duration: editor.options.animationMediumMs }, inset: 48 })
  return true
}
