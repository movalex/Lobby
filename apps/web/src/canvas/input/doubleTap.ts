// Lobby's tap-twice detector (docs/EXCALIDRAW-MIGRATION.md §2.9.2, P4). Pure.
//
// Excalidraw opens the text editor from a touch double-tap in its own `touchstart` listener on the
// interactive canvas (App.onTouchStart, @excalidraw/excalidraw dist/dev/index.js:43477-43517, attached at
// :47143-47148 with passive: false); no `dblclick` fires. Its state is module-level (`didTapTwice`,
// `firstTapPosition`, a 300 ms `tappedTwiceTimer`), so Lobby cannot reset it. Instead this detector
// MIRRORS that state machine exactly, fed with every touchstart Lobby lets through, and says which
// touchstart Excalidraw would turn into `handleCanvasDoubleClick`. Lobby swallows only that one
// (stopPropagation + preventDefault) and runs its own lease flow; Excalidraw's state then stays as it
// was (didTapTwice still true until its timer fires), which the mirror models by not advancing.
//
// Thresholds are Excalidraw's own: TAP_TWICE_TIMEOUT 300 ms, DOUBLE_TAP_POSITION_THRESHOLD 35 px
// (@excalidraw/common dist/dev/index.js:1892, :2069).

export const TAP_TWICE_TIMEOUT = 300
export const DOUBLE_TAP_POSITION_THRESHOLD = 35

export interface TouchStartLike {
  /** Performance-clock time of the event, in ms. */
  time: number
  /** event.touches: every finger currently down, including this one. */
  touches: readonly { clientX: number; clientY: number }[]
}

export type TapVerdict =
  /** Let it through; Excalidraw's state advances as mirrored. */
  | { kind: 'pass' }
  /** Excalidraw would treat it as the second tap: swallow it and run Lobby's handler at (x, y). */
  | { kind: 'double'; clientX: number; clientY: number }

export class DoubleTapMirror {
  private didTapTwice = false
  private firstTap: { x: number; y: number } | null = null
  /** When Excalidraw's tappedTwiceTimer fires (resets didTapTwice). */
  private deadline = 0

  /** Call for every touchstart that reaches the wrapper while interaction is enabled. */
  onTouchStart(e: TouchStartLike): TapVerdict {
    if (this.didTapTwice && e.time >= this.deadline) this.didTapTwice = false // the timer fired
    if (!this.didTapTwice) {
      // Excalidraw: first tap. Records the position only for a one-finger touch; restarts the timer.
      this.didTapTwice = true
      const t = e.touches[0]
      if (e.touches.length === 1 && t) this.firstTap = { x: t.clientX, y: t.clientY }
      this.deadline = e.time + TAP_TWICE_TIMEOUT
      return { kind: 'pass' }
    }
    const t = e.touches[0]
    if (e.touches.length === 1 && this.firstTap && t) {
      const d = Math.hypot(t.clientX - this.firstTap.x, t.clientY - this.firstTap.y)
      if (d <= DOUBLE_TAP_POSITION_THRESHOLD) {
        // Excalidraw would call handleCanvasDoubleClick here. Swallowed: its state does NOT advance.
        return { kind: 'double', clientX: t.clientX, clientY: t.clientY }
      }
      // Too far: Excalidraw ends the pair (didTapTwice = false, timer cleared) and does nothing.
      this.didTapTwice = false
      return { kind: 'pass' }
    }
    // Two or more fingers (pinch, pan): Excalidraw leaves didTapTwice as it is.
    return { kind: 'pass' }
  }
}
// Note: after a swallowed double, Excalidraw's didTapTwice stays true until its timer; a third quick tap
// near the first one would pair again there, so the mirror keeps pairing too and Lobby swallows it again.
