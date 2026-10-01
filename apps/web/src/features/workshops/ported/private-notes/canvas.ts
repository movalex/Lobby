// OWNER: 3f. Canvas helpers for private brainstorming on the Excalidraw page (the tldraw board's
// private-notes/canvas.ts): where the notes will go (the selected frame, or a new "Private ideas" frame in
// free space near the view), finding the notes a session placed, and showing them to the person who
// revealed them.
//
// What changed from the tldraw board:
//  - No text fit after the reveal. The sync server lays placed notes out with Excalidraw's own code and
//    the server's text metrics (apps/sync room-internal/place-notes.ts, canvas-schema engine
//    `buildStickyNote`), so the revealing tab only waits for them to arrive and shows them.
//  - The "Private ideas" frame carries `customData.lobby.privateFrame {session, by}`, a create-only key
//    (canvas-schema custom-data.ts), so it is made AFTER the session starts, with the session's id, under
//    an id chosen before the start (the session's target names it). A start that fails leaves nothing to
//    take away. On the tldraw board the frame was made first and deleted again when the start failed.
//  - Placed notes carry `customData.lobbyServer.privateNote {session, author?}` (server-owned), not
//    `meta.drPrivateNote`.
import {
  PRIVATE_FRAME_DEFAULT_NAME,
  PRIVATE_FRAME_MAX_EXTENT,
  type PrivateTarget,
} from '@draftroom/contracts'
import {
  type Bounds,
  type CanvasElement,
  geometry,
  items,
  type LobbyCanvas,
  SINGLE_PAGE_ID,
} from '../../../../canvas/api/index.ts'
import { findEmptySpot, type Rect } from '../../../canvas-ux/placement.ts'
import { followingNow, inView, zoomToBounds } from '../camera.ts'
import { elementIdOf, frameName, frameOf, refOf } from '../elements.ts'

export { frameName }

/** A new frame holds 4 × 3 notes before it grows (200 px notes, 24 px gaps, 40 px padding). */
export const NEW_FRAME_W = 2 * 40 + 4 * 200 + 3 * 24
export const NEW_FRAME_H = 2 * 40 + 3 * 200 + 2 * 24

const get = (canvas: LobbyCanvas) => (id: string) => canvas.get(id)
const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The frame the selection is (or is inside), if any. */
export function selectedFrame(canvas: LobbyCanvas): CanvasElement | null {
  for (const id of canvas.selection) {
    const frame = frameOf(canvas.get(id), get(canvas))
    if (frame) return frame
  }
  return null
}

const extent = (v: number) => Math.min(PRIVATE_FRAME_MAX_EXTENT, Math.max(1, v))

/**
 * The target for an existing frame (its bounds now). The size only matters if the frame is gone at
 * reveal (it is recreated at this size), so a huge frame is clamped rather than refused. Null for a frame
 * the api cannot name.
 */
export function targetForFrame(canvas: LobbyCanvas, frame: CanvasElement): PrivateTarget | null {
  const ref = refOf(frame.id)
  const b = canvas.bounds(frame.id)
  if (!ref || !b) return null
  return { frameId: ref, pageId: SINGLE_PAGE_ID, x: b.x, y: b.y, w: extent(b.width), h: extent(b.height) }
}

/** Clearance kept between a new "Private ideas" frame and anything already on the board. */
const NEW_FRAME_GAP = 80

/**
 * Where a new frame goes, at a size that holds 12 notes: centred in the viewport when that is empty,
 * else the free space nearest it (beside or below the frames in view), never over another element or
 * frame (final review DANA2-02 / R2-01). `obstacles` are the bounds of the board's top-level elements
 * (frames include their children).
 */
export function newFrameBounds(
  viewport: { x: number; y: number; w: number; h: number },
  obstacles: readonly Rect[] = [],
) {
  const center = { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 }
  const at = findEmptySpot({ w: NEW_FRAME_W, h: NEW_FRAME_H }, center, obstacles, { gap: NEW_FRAME_GAP })
  return { x: Math.round(at.x), y: Math.round(at.y), w: NEW_FRAME_W, h: NEW_FRAME_H }
}

/** Bounds of the board's top-level elements (not in a frame, labels left out: a frame covers its children). */
function topLevelBounds(canvas: LobbyCanvas): Rect[] {
  const out: Rect[] = []
  for (const el of canvas.items()) {
    if (el.frameId || (el.type === 'text' && el.containerId)) continue
    const b = canvas.bounds(el.id)
    if (b) out.push({ x: b.x, y: b.y, w: b.width, h: b.height })
  }
  return out
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

/** A fresh element id (21 URL-safe characters, the engine's own id shape). */
export function newElementId(): string {
  const bytes = new Uint8Array(21)
  crypto.getRandomValues(bytes)
  let id = ''
  for (const b of bytes) id += ID_ALPHABET[b & 63]
  return id
}

/** A "Private ideas" frame planned in free space near the view: its id and target, not made yet. */
export interface PlannedFrame {
  readonly id: string
  readonly target: PrivateTarget
}

export function planPrivateFrame(canvas: LobbyCanvas): PlannedFrame {
  const id = newElementId()
  const v = canvas.viewport.get()
  const b = newFrameBounds({ x: v.x, y: v.y, w: v.width, h: v.height }, topLevelBounds(canvas))
  return { id, target: { frameId: `shape:${id}`, pageId: SINGLE_PAGE_ID, ...b } }
}

/**
 * Makes the planned frame (a normal, undoable canvas edit) for session `session`, marked as made for it
 * (`privateFrame`), so ending its brainstorm without notes can take it away again (R2-01).
 */
export function createPrivateFrame(
  canvas: LobbyCanvas,
  plan: PlannedFrame,
  session: string,
  by: string,
): boolean {
  if (canvas.readOnly()) return false
  const t = plan.target
  try {
    canvas.transact('private ideas frame', (tx) =>
      tx.create('frame', {
        id: plan.id,
        x: t.x,
        y: t.y,
        width: t.w,
        height: t.h,
        name: PRIVATE_FRAME_DEFAULT_NAME,
        customData: { lobby: { privateFrame: { session, by } } },
      }),
    )
    return true
  } catch {
    return false
  }
}

/**
 * Brings a frame into view (the "Private ideas" frame just made) unless it is already all on screen: at
 * the current zoom when it fits, never closer than 100%. Not while presenting or following someone.
 */
export function showFrame(canvas: LobbyCanvas, frameRef: string, presenting: boolean): boolean {
  if (presenting || followingNow(canvas)) return false
  const id = elementIdOf(frameRef)
  const b = id ? canvas.bounds(id) : null
  if (!b || inView(canvas, b)) return false
  zoomToBounds(canvas, b, { maxZoom: Math.min(1, canvas.viewport.get().zoom), inset: 64 })
  return true
}

/**
 * After a brainstorm ended without putting notes into its frame (cancelled, or revealed with none):
 * removes the frame made for it, if it is still empty, unlocked and still called "Private ideas" (an
 * ordinary edit, so Ctrl+Z brings it back). Returns whether it was removed.
 */
export function removeEmptyPrivateFrame(canvas: LobbyCanvas, frameRef: string): boolean {
  const id = elementIdOf(frameRef)
  const frame = id ? canvas.get(id) : undefined
  if (!id || !isLive(frame) || frame.type !== 'frame' || frame.locked || canvas.readOnly()) return false
  if (items.lobbyValue(frame, 'privateFrame') === undefined) return false
  if (frameName(frame) !== PRIVATE_FRAME_DEFAULT_NAME) return false
  if (items.childrenOf(id, canvas.items()).length > 0) return false
  try {
    canvas.transact('remove empty private frame', (tx) => tx.delete(id))
  } catch {
    return false
  }
  return !isLive(canvas.get(id))
}

/** The session a placed note came from (`customData.lobbyServer.privateNote.session`), or null. */
export function privateSessionOf(el: CanvasElement): string | null {
  const server = el.customData?.lobbyServer as { privateNote?: { session?: unknown } } | undefined
  const s = server?.privateNote?.session
  return typeof s === 'string' ? s : null
}

/** Notes a session placed. */
export function placedNoteIds(canvas: LobbyCanvas, sessionId: string): string[] {
  return canvas
    .items()
    .filter((el) => el.type === 'stickynote' && privateSessionOf(el) === sessionId)
    .map((el) => el.id)
}

/**
 * Waits for the session's notes to arrive (the canvas broadcast and the API's answer race), for up to
 * `timeoutMs`. `onArrived` runs once with the notes on the board: when all `expected` are there, or at
 * the timeout with those that came. Returns a stop function (which skips `onArrived`).
 */
export function waitForPlacedNotes(
  canvas: LobbyCanvas,
  sessionId: string,
  expected: number,
  onArrived?: (ids: string[]) => void,
  timeoutMs = 15_000,
): () => void {
  let stopped = false
  let off = () => {}
  const stop = () => {
    if (stopped) return false
    stopped = true
    off()
    clearTimeout(timer)
    return true
  }
  const finish = () => {
    const ids = placedNoteIds(canvas, sessionId)
    if (stop() && ids.length > 0) onArrived?.(ids)
  }
  const check = () => {
    if (placedNoteIds(canvas, sessionId).length >= expected) finish()
  }
  const timer = setTimeout(finish, timeoutMs)
  off = canvas.on('change', () => check())
  check()
  return () => void stop()
}

/**
 * Runs `fn` once the layout has settled (two frames) and the canvas has measured its container again:
 * after a dock panel opened or closed, a camera move then fits what is really on screen.
 */
export function afterLayout(canvas: LobbyCanvas, fn: () => void) {
  const run = () => {
    try {
      canvas.viewport.remeasure()
    } catch {
      // no board handles, or the board went away meanwhile
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
 * unless they are all on screen at a readable zoom already, the camera moves to show them all, at 100%
 * at most. Not while presenting or following someone. Returns whether the camera moved.
 */
export function showPlacedNotes(canvas: LobbyCanvas, ids: readonly string[], presenting: boolean): boolean {
  if (presenting || followingNow(canvas)) return false
  const all = geometry.union(ids.map((id) => canvas.bounds(id)))
  if (!all) return false
  if (inView(canvas, all) && canvas.viewport.get().zoom >= READABLE_ZOOM) return false
  zoomToBounds(canvas, all, { maxZoom: 1, inset: 96 })
  return true
}

/**
 * Zooms to where a session's notes are: the frame holding them (the target, or the one recreated for
 * it when the target was deleted), else the target frame. Returns false when neither is on the board.
 */
export function zoomToSession(canvas: LobbyCanvas, sessionId: string, frameRef: string): boolean {
  const note = placedNoteIds(canvas, sessionId)
    .map((id) => canvas.get(id))
    .find(isLive)
  const parent = note?.frameId ? canvas.get(note.frameId) : undefined
  const frameId = elementIdOf(frameRef)
  const targetFrame = frameId ? canvas.get(frameId) : undefined
  const target: CanvasElement | undefined =
    isLive(parent) && parent.type === 'frame' ? parent : isLive(targetFrame) ? targetFrame : note
  if (!target) return false
  const b: Bounds | null = canvas.bounds(target.id)
  if (!b) return false
  zoomToBounds(canvas, b, { inset: 48, maxZoom: 8 })
  return true
}
