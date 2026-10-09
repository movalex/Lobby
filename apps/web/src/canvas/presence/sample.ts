/**
 * What Lobby's presence pointer listener (./pointer.ts) hands the presence hub (./hub.ts). Types only, with no
 * DOM types, so the hub type-checks where there is no DOM (the sync server's tests run the hub against the
 * real room: apps/sync/test/element-room/stale-pairs-rev12.test.ts).
 */

export interface PresencePoint {
  x: number
  y: number
}

export interface PresenceSample {
  /** Scene coordinates, or null when the pointer left the board. */
  pointer: PresencePoint | null
  /**
   * While the button is down: the scene points the pointer passed since the previous sample, oldest first,
   * without `pointer` itself (the shared laser's trail, wave L L6-1). Absent or empty otherwise.
   */
  trail?: readonly PresencePoint[]
  button: 'down' | 'up'
  /** The DOM event that produced it, for tests: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointerleave'. */
  source: string
  pointerType: string
}
