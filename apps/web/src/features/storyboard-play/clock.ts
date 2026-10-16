// OWNER: WS3 (wave T). The animatic's own clock and transport (docs/WAVE-T-CONTRACTS.md §1, the design §3.1). Pure: the
// time source and the media element are injected, so the boundaries are unit-tested on a fake clock.
//
//  - Without sound the playhead is `now()` (performance.now) times the speed from where it was last placed.
//  - With sound the media element is the master while it plays: the playhead is its `currentTime` plus the offset
//    (the sound starts `offsetMs` after the animatic). Pressing play where the sound plays waits for the element's
//    `playing` before the clock runs (so the pictures never run ahead of a slow start); where it does not play yet
//    (before a positive offset, after its end) the clock runs alone and starts the sound when the playhead reaches it.
//  - While playing the playhead never moves back (a sound that starts a few ms late holds the picture instead of
//    swapping back); only a seek moves it back.
//  - At the end: back to the start when looping, else paused on the last panel.

/** What the transport needs of a media element (an HTMLMediaElement fits). */
export interface MediaLike {
  currentTime: number
  readonly duration: number
  readonly paused: boolean
  readonly ended: boolean
  playbackRate: number
  play(): Promise<void> | undefined
  pause(): void
}

export interface Segment {
  readonly startMs: number
  readonly durationMs: number
}

/** The segment the playhead `ms` is in: the last one whose start is at or before it (0 before the first). */
export function segmentAt(segments: readonly Segment[], ms: number): number {
  let lo = 0
  let hi = segments.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((segments[mid] as Segment).startMs <= ms) lo = mid
    else hi = mid - 1
  }
  return lo
}

export const SPEEDS = [0.5, 1, 2] as const
export type Speed = (typeof SPEEDS)[number]

/** How long play waits for the sound to start before the pictures run without it. */
export const AUDIO_START_TIMEOUT_MS = 1500

export type TransportState = 'paused' | 'starting' | 'playing' | 'ended'

export interface TransportOptions {
  readonly totalMs: number
  readonly now: () => number
  readonly media?: MediaLike | null
  /** ms after the animatic's start the media starts */
  readonly offsetMs?: number
  readonly loop?: boolean
}

export class Transport {
  totalMs: number
  loop: boolean
  speed: Speed = 1
  readonly offsetMs: number
  private readonly now: () => number
  private media: MediaLike | null
  private base = 0
  private startedAt = 0
  private stateValue: TransportState = 'paused'
  private startingSince = 0
  /** the media fired `playing` since the last play/seek (it is the master) */
  private mediaRunning = false
  private last = 0

  constructor(o: TransportOptions) {
    this.totalMs = Math.max(0, o.totalMs)
    this.now = o.now
    this.media = o.media ?? null
    this.offsetMs = o.offsetMs ?? 0
    this.loop = o.loop ?? false
  }

  get state(): TransportState {
    return this.stateValue
  }

  get playing(): boolean {
    return this.stateValue === 'playing' || this.stateValue === 'starting'
  }

  /** The media time (s) of the playhead `ms`, or null when the sound does not play there. */
  private mediaTimeAt(ms: number): number | null {
    const m = this.media
    if (!m) return null
    const t = (ms - this.offsetMs) / 1000
    const d = Number.isFinite(m.duration) && m.duration > 0 ? m.duration : Number.POSITIVE_INFINITY
    return t >= 0 && t < d ? t : null
  }

  private clockAt(at: number): number {
    return this.stateValue === 'playing' ? this.base + (at - this.startedAt) * this.speed : this.base
  }

  private startMedia(ms: number): boolean {
    const m = this.media
    const t = this.mediaTimeAt(ms)
    if (!m || t === null) return false
    m.playbackRate = this.speed
    if (Math.abs(m.currentTime - t) > 0.02) m.currentTime = t
    this.mediaRunning = false
    m.play()?.catch(() => {
      // refused (no gesture, decoding failed): the pictures run alone
      this.mediaRunning = false
      if (this.stateValue === 'starting') this.run(this.now())
    })
    return true
  }

  private run(at: number) {
    this.startedAt = at
    this.stateValue = 'playing'
  }

  /** Starts (or resumes) playing; from the start again after the end. */
  play(): void {
    if (this.playing) return
    const at = this.now()
    if (this.stateValue === 'ended' || this.base >= this.totalMs) this.base = 0
    this.last = this.base
    if (this.startMedia(this.base)) {
      this.stateValue = 'starting'
      this.startingSince = at
    } else this.run(at)
  }

  pause(): void {
    if (!this.playing) return
    this.base = this.position()
    this.stateValue = 'paused'
    this.mediaRunning = false
    this.media?.pause()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /** Moves the playhead (kept inside the animatic); playing goes on from there. */
  seek(ms: number): void {
    const to = Math.min(Math.max(0, ms), this.totalMs)
    const wasPlaying = this.playing
    this.mediaRunning = false
    this.media?.pause()
    this.base = to
    this.last = to
    // at the very end: ended (play starts again from the start), else paused there or playing on
    this.stateValue = to >= this.totalMs && (wasPlaying || this.stateValue === 'ended') ? 'ended' : 'paused'
    if (wasPlaying && this.stateValue !== 'ended') this.play()
  }

  setSpeed(speed: Speed): void {
    if (this.stateValue === 'playing') {
      this.base = this.position()
      this.startedAt = this.now()
    }
    this.speed = speed
    if (this.media) this.media.playbackRate = speed
  }

  /** The media element fired `playing`: from now on it is the master (while it plays). */
  mediaPlaying(): void {
    this.mediaRunning = true
    if (this.stateValue === 'starting') this.run(this.now())
  }

  /** The sound cannot play (a load or decode error): the pictures go on alone, from where they are. */
  detachMedia(): void {
    if (!this.media) return
    const at = this.now()
    const pos = this.position()
    this.media = null
    this.mediaRunning = false
    this.base = pos
    if (this.stateValue === 'starting' || this.stateValue === 'playing') this.run(at)
  }

  /** Whether a sound track drives the clock (false without one, or after detachMedia). */
  get hasMedia(): boolean {
    return this.media !== null
  }

  /** The media element stalled (`waiting`) or paused on its own: the clock runs alone until `playing` again. */
  mediaStalled(): void {
    if (!this.mediaRunning) return
    this.base = this.position()
    this.startedAt = this.now()
    this.mediaRunning = false
  }

  /**
   * The playhead now (ms), advancing the transport: called once per animation frame. Starts the sound when the
   * playhead reaches it, falls back to the clock alone when the sound does not start in time, loops or ends.
   */
  tick(): number {
    const at = this.now()
    if (this.stateValue === 'starting') {
      if (at - this.startingSince < AUDIO_START_TIMEOUT_MS) return this.base
      this.run(at)
    }
    if (this.stateValue !== 'playing') return this.base
    let pos = this.clockAt(at)
    const m = this.media
    if (m && this.mediaRunning && !m.paused && !m.ended) {
      const fromMedia = m.currentTime * 1000 + this.offsetMs
      // the master; the clock follows it so that it goes on where the sound stops
      if (Number.isFinite(fromMedia)) {
        pos = fromMedia
        this.base = fromMedia
        this.startedAt = at
      }
    } else if (m && !this.mediaRunning && m.paused && this.mediaTimeAt(pos) !== null && pos < this.totalMs) {
      // the playhead reached the sound (a positive offset): start it; the clock runs until it plays
      this.startMedia(pos)
    }
    pos = Math.max(pos, this.last)
    if (pos >= this.totalMs) {
      if (this.loop && this.totalMs > 0) {
        this.base = 0
        this.last = 0
        this.mediaRunning = false
        m?.pause()
        if (this.startMedia(0)) {
          this.stateValue = 'starting'
          this.startingSince = at
        } else this.run(at)
        return 0
      }
      this.base = this.totalMs
      this.last = this.totalMs
      this.stateValue = 'ended'
      this.mediaRunning = false
      m?.pause()
      return this.totalMs
    }
    this.last = pos
    return pos
  }

  /** The playhead without advancing anything (between frames). */
  position(): number {
    if (this.stateValue !== 'playing') return this.base
    const m = this.media
    if (m && this.mediaRunning && !m.paused && !m.ended)
      return Math.max(this.last, Math.min(this.totalMs, m.currentTime * 1000 + this.offsetMs))
    return Math.max(this.last, Math.min(this.totalMs, this.clockAt(this.now())))
  }
}
