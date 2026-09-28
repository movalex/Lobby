// Canvas helpers for private brainstorming: where the notes will go (the selected frame, or a new
// "Private ideas" frame in view), finding the notes a session placed, fitting their height to their
// text once they arrive, and showing them to the person who revealed them.
//
// Why the fit: the sync server places the notes but cannot measure text, so it gives each note a
// conservative (tall) growY. The client that asked for the reveal measures them with tldraw's own
// note sizing and writes the real growY once (history: 'ignore', so nobody's undo includes it).

import {
  PRIVATE_FRAME_DEFAULT_NAME,
  PRIVATE_FRAME_MAX_EXTENT,
  PRIVATE_NOTE_META_KEY,
  type PrivateTarget,
} from '@draftroom/contracts'
import { Box, createShapeId, type Editor, type TLNoteShape, type TLShape, type TLShapeId } from 'tldraw'
import { findEmptySpot, type Rect } from '../../canvas-ux/placement.ts'

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

/**
 * The target for an existing frame (its page bounds now). The size only matters if the frame is
 * gone at reveal (it is recreated at this size), so a huge frame is clamped rather than refused.
 */
export function targetForFrame(editor: Editor, frame: TLShape): PrivateTarget | null {
  const b = editor.getShapePageBounds(frame)
  const pageId = editor.getAncestorPageId(frame)
  if (!b || !pageId) return null
  const extent = (v: number) => Math.min(PRIVATE_FRAME_MAX_EXTENT, Math.max(1, v))
  return { frameId: frame.id, pageId, x: b.x, y: b.y, w: extent(b.w), h: extent(b.h) }
}

/** Clearance kept between a new "Private ideas" frame and anything already on the page. */
const NEW_FRAME_GAP = 80

/**
 * Where a new frame goes, at a size that holds 12 notes: centred in the viewport when that is empty,
 * else the free space nearest it (beside or below the frames in view), never over another shape or
 * frame (final review DANA2-02 / R2-01: it used to cover the frame in view and hide its notes).
 * `obstacles` are the page bounds of the page's top-level shapes (frames include their children).
 */
export function newFrameBounds(
  viewport: { x: number; y: number; w: number; h: number },
  obstacles: readonly Rect[] = [],
) {
  const center = { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 }
  const at = findEmptySpot({ w: NEW_FRAME_W, h: NEW_FRAME_H }, center, obstacles, { gap: NEW_FRAME_GAP })
  return { x: Math.round(at.x), y: Math.round(at.y), w: NEW_FRAME_W, h: NEW_FRAME_H }
}

/** Page bounds of the current page's top-level shapes (a frame's bounds cover its children). */
function topLevelBounds(editor: Editor): Rect[] {
  const out: Rect[] = []
  for (const id of editor.getSortedChildIdsForParent(editor.getCurrentPageId())) {
    const b = editor.getShapePageBounds(id)
    if (b) out.push({ x: b.x, y: b.y, w: b.w, h: b.h })
  }
  return out
}

/**
 * Marks a frame made by "A new frame, Private ideas, in view", so ending its brainstorm without notes
 * (Cancel, or a reveal with none) can take it away again (R2-01). Never a frame someone picked.
 */
export const PRIVATE_FRAME_META_KEY = 'drPrivateFrame'

/**
 * Creates the "Private ideas" frame in free space near the view (a normal, undoable canvas edit), as
 * a child of the page (tldraw would otherwise parent it into a frame under its top-left corner), and
 * returns its target.
 */
export function createPrivateFrame(editor: Editor): PrivateTarget {
  const id = createShapeId()
  const pageId = editor.getCurrentPageId()
  const b = newFrameBounds(editor.getViewportPageBounds(), topLevelBounds(editor))
  editor.createShape({
    id,
    type: 'frame',
    parentId: pageId,
    x: b.x,
    y: b.y,
    meta: { [PRIVATE_FRAME_META_KEY]: true },
    props: { w: b.w, h: b.h, name: PRIVATE_FRAME_DEFAULT_NAME },
  })
  return { frameId: id, pageId, ...b }
}

/**
 * Brings a frame into view (the "Private ideas" frame just made) unless it is already all on screen:
 * at the current zoom when it fits, never closer than 100%. Not while following someone.
 */
export function showFrame(editor: Editor, frameId: string, presenting: boolean): boolean {
  if (presenting || editor.getInstanceState().followingUserId) return false
  const b = editor.getShapePageBounds(frameId as TLShapeId)
  if (!b) return false
  if (editor.getViewportPageBounds().contains(b)) return false
  editor.zoomToBounds(b, {
    targetZoom: Math.min(1, editor.getZoomLevel()),
    inset: 64,
    animation: { duration: editor.options.animationMediumMs },
  })
  return true
}

/**
 * After a brainstorm ended without putting notes into its frame (cancelled, or revealed with none):
 * removes the frame "A new frame" made for it, if it is still empty, unlocked and still called
 * "Private ideas" (an ordinary edit, so Ctrl+Z brings it back). Returns whether it was removed.
 */
export function removeEmptyPrivateFrame(editor: Editor, frameId: string): boolean {
  const frame = editor.getShape(frameId as TLShapeId)
  if (frame?.type !== 'frame' || frame.isLocked || editor.getIsReadonly()) return false
  if ((frame.meta as Record<string, unknown>)[PRIVATE_FRAME_META_KEY] !== true) return false
  if (frameName(frame) !== PRIVATE_FRAME_DEFAULT_NAME) return false
  if (editor.getSortedChildIdsForParent(frame.id).length > 0) return false
  editor.markHistoryStoppingPoint('remove empty private frame')
  editor.deleteShape(frame.id)
  return !editor.getShape(frame.id)
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
 * once, for up to `timeoutMs`. `onArrived` runs once with the notes on the board: when all
 * `expected` are there, or at the timeout with those that came. Returns a stop function (which skips
 * `onArrived`).
 */
export function fitPlacedNotes(
  editor: Editor,
  sessionId: string,
  expected: number,
  timeoutMs = 15_000,
  onArrived?: (ids: TLShapeId[]) => void,
  /** `fit: false` only waits for the notes (someone else's tab fits them). */
  opts: { fit?: boolean } = {},
) {
  const done = new Set<TLShapeId>()
  const run = () => {
    const fresh = placedNoteIds(editor, sessionId).filter((id) => !done.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) done.add(id)
    if (opts.fit !== false) fitNotes(editor, fresh)
    if (done.size >= expected) finish()
  }
  const unlisten = editor.store.listen(() => run(), { source: 'remote', scope: 'document' })
  const timer = setTimeout(() => finish(), timeoutMs)
  let stopped = false
  function stop() {
    if (stopped) return false
    stopped = true
    unlisten()
    clearTimeout(timer)
    return true
  }
  function finish() {
    if (stop() && done.size > 0) onArrived?.([...done])
  }
  run()
  return () => void stop()
}

/**
 * Runs `fn` once the layout has settled (two frames) and the editor has measured its container
 * again (tldraw's own measuring is throttled to 200 ms): after a dock panel opened or closed, a
 * camera move then fits what is really on screen (a panel closing on a phone left a 26 px wide
 * viewport to fit the notes into).
 */
export function afterLayout(editor: Editor, fn: () => void) {
  const run = () => {
    try {
      editor.updateViewportScreenBounds(editor.getContainer())
    } catch {
      // The board went away meanwhile.
      return
    }
    fn()
  }
  if (typeof requestAnimationFrame === 'undefined') return void setTimeout(run, 0)
  requestAnimationFrame(() => requestAnimationFrame(run))
}

/** Below this zoom a revealed note's text is too small to read: the camera moves in. */
const READABLE_ZOOM = 0.4

/**
 * Brings the notes a reveal just placed into view for the person who revealed them (round-2 F5):
 * unless they are all on screen at a readable zoom already, the camera moves to show them all, at
 * 100% at most. Not while presenting or following someone (their camera is not theirs to move).
 * Returns whether the camera moved.
 */
export function showPlacedNotes(editor: Editor, ids: readonly TLShapeId[], presenting: boolean): boolean {
  if (presenting || editor.getInstanceState().followingUserId) return false
  const shapes = ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => !!s)
  const first = shapes[0]
  if (!first) return false
  const pageId = editor.getAncestorPageId(first)
  if (pageId && pageId !== editor.getCurrentPageId()) editor.setCurrentPage(pageId)
  const boxes = shapes
    .filter((s) => editor.getAncestorPageId(s) === editor.getCurrentPageId())
    .map((s) => editor.getShapePageBounds(s))
    .filter((b): b is Box => !!b)
  if (boxes.length === 0) return false
  const all = Box.Common(boxes)
  if (editor.getViewportPageBounds().contains(all) && editor.getZoomLevel() >= READABLE_ZOOM) return false
  editor.zoomToBounds(all, {
    targetZoom: 1,
    inset: 96,
    animation: { duration: editor.options.animationMediumMs },
  })
  return true
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
