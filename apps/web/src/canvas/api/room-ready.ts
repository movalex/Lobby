// Wave K.1 (follow-up 5, K2-4): whether the board's first sync is complete, per canvas. Features mount after the
// room's first `welcome`, but that is not yet the whole board: a joiner within 5 s of someone else gets the room's
// cached reset snapshot and, right behind it, the rows written since as a `changes` frame (apps/sync
// room/element-room.ts `snapshotFor`), so a populated board reads as empty between the two (K2-4's start card and
// dot grid flashed up on every such open). The room sends its `contracts` frame after the welcome, the snapshot and
// that catch-up, so the board session (../board/session.ts) marks the board ready on the first `contracts` frame
// after the first welcome, or ROOM_READY_FALLBACK_MS after that welcome when a room sends none. Once ready it stays
// ready for the canvas's life (a reconnect does not empty the board).
import { type Atom, atom } from '../../lib/signals.ts'

/** A room that sends no `contracts` frame (older than CONTRACTS_REV 10): ready this long after the first welcome. */
export const ROOM_READY_FALLBACK_MS = 1_500

const ready = new WeakMap<object, Atom<boolean>>()

/** Reactive: the first welcome and its catch-up are applied on `canvas` (false until then). */
export function roomReadyOf(canvas: object): Atom<boolean> {
  let a = ready.get(canvas)
  if (!a) {
    a = atom('lobby-room-ready', false)
    ready.set(canvas, a)
  }
  return a
}

/** The board session's mark (idempotent). */
export function markRoomReady(canvas: object): void {
  const a = roomReadyOf(canvas)
  if (!a.get()) a.set(true)
}
