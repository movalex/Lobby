/**
 * A press held without moving (wave L, W6, L6-2): the compass chips' "press and hold to follow" on a touch
 * screen, where there is no Shift-click. `LongPress` is the timing (pure, Node-tested with a fake timer);
 * `useLongPress` binds it to a React element's pointer events and swallows the click that follows a long
 * press, so the chip does not also "go there".
 */
import { useEffect, useRef } from 'react'

/** A press longer than this is a long press. */
export const LONG_PRESS_MS = 500
/** Moving the pointer farther than this (px) is a drag, not a press. */
export const LONG_PRESS_SLOP_PX = 10

export interface LongPressTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: LongPressTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class LongPress<K> {
  private timer: unknown = null
  private key: K | null = null
  private x = 0
  private y = 0
  private fired = false
  private readonly onLong: (key: K) => void
  private readonly ms: number
  private readonly timers: LongPressTimers

  constructor(onLong: (key: K) => void, ms = LONG_PRESS_MS, timers: LongPressTimers = realTimers) {
    this.onLong = onLong
    this.ms = ms
    this.timers = timers
  }

  /** The pointer went down on `key` at (x, y). */
  down(key: K, x: number, y: number): void {
    this.cancel()
    this.key = key
    this.x = x
    this.y = y
    this.fired = false
    this.timer = this.timers.set(() => {
      this.timer = null
      this.fired = true
      if (this.key !== null) this.onLong(this.key)
    }, this.ms)
  }

  /** The pointer moved: farther than the slop, it is not a press any more. */
  move(x: number, y: number): void {
    if (this.timer !== null && Math.hypot(x - this.x, y - this.y) > LONG_PRESS_SLOP_PX) this.cancel()
  }

  /** The pointer went up (or the press was cancelled). */
  up(): void {
    this.cancel()
  }

  /** Whether the click now arriving ends a long press (it is swallowed); asking clears it. */
  takeClick(): boolean {
    const f = this.fired
    this.fired = false
    return f
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}

/** The pointer handlers of a long press on many elements (one at a time), and the click guard. */
export function useLongPress<K>(onLong: (key: K) => void, ms = LONG_PRESS_MS) {
  const cb = useRef(onLong)
  cb.current = onLong
  const lp = useRef<LongPress<K> | null>(null)
  if (!lp.current) lp.current = new LongPress<K>((k) => cb.current(k), ms)
  const gesture = lp.current
  useEffect(() => () => gesture.cancel(), [gesture])
  return {
    bind: (key: K) => ({
      onPointerDown: (e: { readonly clientX: number; readonly clientY: number; readonly button: number }) => {
        if (e.button === 0) gesture.down(key, e.clientX, e.clientY)
      },
      onPointerMove: (e: { readonly clientX: number; readonly clientY: number }) =>
        gesture.move(e.clientX, e.clientY),
      onPointerUp: () => gesture.up(),
      onPointerCancel: () => gesture.up(),
      onPointerLeave: () => gesture.up(),
      // a held finger opens the browser's menu on some phones: not on these
      onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    }),
    /** true when this click ends a long press (do nothing else) */
    takeClick: () => gesture.takeClick(),
  }
}
