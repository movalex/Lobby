// OWNER: WS2 (wave S, compare). Video A/B with one transport (docs/WAVE-S-CONTRACTS.md §3.3): B follows A's clock.
// Play, pause and the rate are copied from A to B, and B is seeked to A's time when they drift apart by more than
// DRIFT_TOLERANCE_S (about a frame and a half at 25 fps), checked on each of A's frames (requestVideoFrameCallback)
// or every FOLLOW_INTERVAL_MS where the browser has none. B is always muted: one sound. No DOM types beyond what a
// <video> offers: unit-tested with fakes on a fake clock (video-sync.test.ts).

export const DRIFT_TOLERANCE_S = 0.06
export const FOLLOW_INTERVAL_MS = 250

/** The part of HTMLVideoElement the follower reads and writes. */
export interface MediaClock {
  currentTime: number
  readonly paused: boolean
  playbackRate: number
  muted: boolean
  play(): Promise<void> | void
  pause(): void
}

/** One check: B takes A's play state, rate and (when it drifted) time. Returns whether B was seeked. */
export function followStep(a: MediaClock, b: MediaClock, tolerance = DRIFT_TOLERANCE_S): boolean {
  if (!b.muted) b.muted = true
  if (b.playbackRate !== a.playbackRate) b.playbackRate = a.playbackRate
  if (a.paused && !b.paused) b.pause()
  else if (!a.paused && b.paused) void Promise.resolve(b.play()).catch(() => {})
  if (Math.abs(b.currentTime - a.currentTime) > tolerance) {
    b.currentTime = a.currentTime
    return true
  }
  return false
}

export interface FollowScheduler {
  /** A's next frame (requestVideoFrameCallback), when the browser has it; returns its cancel */
  onFrame?: (run: () => void) => () => void
  /** a repeating timer; returns its cancel */
  every: (ms: number, run: () => void) => () => void
}

type FrameVideo = MediaClock & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/** The browser's scheduler for `a`: its frame callback when it has one, and a 250 ms timer (paused videos too). */
export function browserScheduler(a: FrameVideo): FollowScheduler {
  const request = a.requestVideoFrameCallback?.bind(a)
  const cancel = a.cancelVideoFrameCallback?.bind(a)
  return {
    ...(request && cancel
      ? {
          onFrame: (run: () => void) => {
            const h = request(run)
            return () => cancel(h)
          },
        }
      : {}),
    every: (ms, run) => {
      const t = setInterval(run, ms)
      return () => clearInterval(t)
    },
  }
}

/** Keeps B on A's clock until the returned stop is called. */
export function follow(a: MediaClock, b: MediaClock, scheduler: FollowScheduler): () => void {
  let stopped = false
  let cancelFrame: (() => void) | null = null
  const frame = () => {
    if (stopped) return
    followStep(a, b)
    cancelFrame = scheduler.onFrame?.(frame) ?? null
  }
  b.muted = true
  followStep(a, b)
  cancelFrame = scheduler.onFrame?.(frame) ?? null
  // the timer also covers a paused A (no frames) and a seek while paused
  const cancelTimer = scheduler.every(FOLLOW_INTERVAL_MS, () => {
    if (!stopped) followStep(a, b)
  })
  return () => {
    stopped = true
    cancelFrame?.()
    cancelTimer()
  }
}

/** "1:02.4" (or "1:02:03.4" past an hour), from seconds. */
export function formatTimecode(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const tenths = Math.floor(s * 10) % 10
  const whole = Math.floor(s)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const sec = whole % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}.${tenths}`
}
