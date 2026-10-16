// Wave T (WS3): the animatic's clock and transport on a fake clock and a fake media element: panel boundaries within
// one 60 Hz frame, speed, pause, seek, loop, the end, and the sound as the master (its start awaited, a positive offset
// started when the playhead reaches it, a stall, a failed sound, a playhead that never moves back while playing).
import { describe, expect, it } from 'vitest'
import { AUDIO_START_TIMEOUT_MS, type MediaLike, segmentAt, Transport } from './clock.ts'

const FRAME = 1000 / 60

/** Panels of these durations, back to back. */
const segments = (durations: readonly number[]) => {
  let at = 0
  return durations.map((d) => {
    const s = { startMs: at, durationMs: d }
    at += d
    return s
  })
}

function fakeClock() {
  let t = 1000
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

class FakeMedia implements MediaLike {
  currentTime = 0
  duration = Number.NaN
  paused = true
  ended = false
  playbackRate = 1
  plays = 0
  refuse = false
  play() {
    this.plays++
    this.paused = false
    return this.refuse ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  /** the element's time moves on by `ms` of real time */
  run(ms: number) {
    if (!this.paused) this.currentTime += (ms / 1000) * this.playbackRate
  }
}

/** Runs frames until `until` ms of fake time passed; returns each frame's panel swaps: [index, time since start]. */
function swapsOf(
  t: Transport,
  clock: ReturnType<typeof fakeClock>,
  segs: ReturnType<typeof segments>,
  ms: number,
) {
  const out: [number, number][] = []
  let shown = -1
  const start = clock.now()
  for (let elapsed = 0; elapsed <= ms; elapsed += FRAME) {
    const pos = t.tick()
    const i = segmentAt(segs, pos)
    if (i !== shown) {
      shown = i
      out.push([i, clock.now() - start])
    }
    clock.advance(FRAME)
  }
  return out
}

describe('segmentAt', () => {
  const segs = segments([2000, 500, 1500])
  it('finds the panel whose span holds the playhead (its start belongs to it)', () => {
    expect(segmentAt(segs, 0)).toBe(0)
    expect(segmentAt(segs, 1999)).toBe(0)
    expect(segmentAt(segs, 2000)).toBe(1)
    expect(segmentAt(segs, 2499)).toBe(1)
    expect(segmentAt(segs, 2500)).toBe(2)
    expect(segmentAt(segs, 99_999)).toBe(2)
    expect(segmentAt(segs, -5)).toBe(0)
    expect(segmentAt([], 10)).toBe(-1)
  })
})

describe('the transport without sound', () => {
  it('swaps each panel on the first frame past its boundary (within one frame)', () => {
    const clock = fakeClock()
    const segs = segments([2000, 1000, 2500, 500, 1500, 3000])
    const total = segs.reduce((n, s) => n + s.durationMs, 0)
    const t = new Transport({ totalMs: total, now: clock.now })
    t.play()
    const swaps = swapsOf(t, clock, segs, total - 1)
    expect(swaps.map(([i]) => i)).toEqual([0, 1, 2, 3, 4, 5])
    for (const [i, at] of swaps) {
      const late = at - (segs[i]?.startMs ?? 0)
      expect(late, `panel ${i}`).toBeGreaterThanOrEqual(0)
      expect(late, `panel ${i}`).toBeLessThan(FRAME + 0.001)
    }
  })

  it('at 2× it takes half the time; at 0.5× twice', () => {
    for (const speed of [2, 0.5] as const) {
      const clock = fakeClock()
      const segs = segments([1000, 1000, 1000])
      const t = new Transport({ totalMs: 3000, now: clock.now })
      t.setSpeed(speed)
      t.play()
      const swaps = swapsOf(t, clock, segs, 3000 / speed - 1)
      expect(swaps.map(([i]) => i)).toEqual([0, 1, 2])
      expect(Math.abs((swaps[2]?.[1] ?? 0) - 2000 / speed)).toBeLessThan(FRAME + 0.001)
    }
  })

  it('pause holds the playhead; play goes on from there; seek moves it (inside the animatic)', () => {
    const clock = fakeClock()
    const t = new Transport({ totalMs: 5000, now: clock.now })
    t.play()
    clock.advance(1200)
    expect(t.tick()).toBeCloseTo(1200)
    t.pause()
    clock.advance(5000)
    expect(t.tick()).toBeCloseTo(1200)
    t.play()
    clock.advance(300)
    expect(t.tick()).toBeCloseTo(1500)
    t.seek(4000)
    expect(t.tick()).toBe(4000)
    expect(t.playing).toBe(true)
    t.seek(-50)
    expect(t.position()).toBe(0)
    t.seek(99_000)
    expect(t.position()).toBe(5000)
    expect(t.state).toBe('ended')
    t.play()
    expect(t.tick()).toBe(0)
  })

  it('ends on the last panel when not looping, and plays again from the start', () => {
    const clock = fakeClock()
    const t = new Transport({ totalMs: 1000, now: clock.now })
    t.play()
    clock.advance(1500)
    expect(t.tick()).toBe(1000)
    expect(t.state).toBe('ended')
    expect(t.playing).toBe(false)
    t.play()
    expect(t.tick()).toBe(0)
    expect(t.playing).toBe(true)
  })

  it('loops back to the start', () => {
    const clock = fakeClock()
    const segs = segments([500, 500])
    const t = new Transport({ totalMs: 1000, now: clock.now, loop: true })
    t.play()
    const swaps = swapsOf(t, clock, segs, 2600)
    expect(swaps.map(([i]) => i)).toEqual([0, 1, 0, 1, 0, 1])
    expect(t.playing).toBe(true)
  })
})

describe('the transport with sound', () => {
  it('waits for the sound to start, then follows its time (the master)', async () => {
    const clock = fakeClock()
    const media = new FakeMedia()
    const t = new Transport({ totalMs: 4000, now: clock.now, media })
    t.play()
    expect(t.state).toBe('starting')
    expect(media.plays).toBe(1)
    clock.advance(120) // the sound's start latency: the pictures wait
    expect(t.tick()).toBe(0)
    t.mediaPlaying()
    expect(t.state).toBe('playing')
    // the element runs a little slow: the playhead follows it, not performance.now
    for (let i = 0; i < 60; i++) {
      clock.advance(FRAME)
      media.run(FRAME * 0.98)
    }
    expect(t.tick()).toBeCloseTo(media.currentTime * 1000, 5)
    expect(t.tick()).toBeLessThan(1000)
  })

  it('a positive offset: the clock runs alone, then starts the sound when the playhead reaches it', () => {
    const clock = fakeClock()
    const media = new FakeMedia()
    const t = new Transport({ totalMs: 5000, now: clock.now, media, offsetMs: 1000 })
    t.play()
    expect(t.state).toBe('playing')
    expect(media.plays).toBe(0)
    clock.advance(1100)
    t.tick()
    expect(media.plays).toBe(1)
    expect(media.currentTime).toBeCloseTo(0.1, 2)
    t.mediaPlaying()
    media.currentTime = 0.5
    expect(t.tick()).toBeCloseTo(1500)
  })

  it('a negative offset skips the start of the sound; seeking puts the sound where the playhead is', () => {
    const clock = fakeClock()
    const media = new FakeMedia()
    const t = new Transport({ totalMs: 5000, now: clock.now, media, offsetMs: -2000 })
    t.seek(1000)
    t.play()
    expect(media.currentTime).toBeCloseTo(3)
  })

  it('never moves back while playing (a late sound holds the picture)', () => {
    const clock = fakeClock()
    const media = new FakeMedia()
    const t = new Transport({ totalMs: 5000, now: clock.now, media, offsetMs: 1000 })
    t.play()
    clock.advance(1100)
    const before = t.tick()
    t.mediaPlaying()
    media.currentTime = 0.02 // the sound started 80 ms late
    expect(t.tick()).toBe(before)
    media.currentTime = 0.2
    expect(t.tick()).toBeCloseTo(1200)
  })

  it('plays the pictures alone when the sound does not start in time, or cannot play at all', async () => {
    const clock = fakeClock()
    const media = new FakeMedia()
    const t = new Transport({ totalMs: 5000, now: clock.now, media })
    t.play()
    clock.advance(AUDIO_START_TIMEOUT_MS + 1)
    t.tick()
    expect(t.state).toBe('playing')
    clock.advance(500)
    expect(t.tick()).toBeCloseTo(500, 0)

    const refused = new FakeMedia()
    refused.refuse = true
    const r = new Transport({ totalMs: 5000, now: clock.now, media: refused })
    r.play()
    await Promise.resolve()
    await Promise.resolve()
    expect(r.state).toBe('playing')

    const failing = new FakeMedia()
    const f = new Transport({ totalMs: 5000, now: clock.now, media: failing })
    f.play()
    f.detachMedia()
    expect(f.hasMedia).toBe(false)
    clock.advance(250)
    expect(f.tick()).toBeCloseTo(250, 0)
  })

  it('a stall hands the clock back to performance.now until the sound plays again; pause pauses the sound', () => {
    const clock = fakeClock()
    const media = new FakeMedia()
    const t = new Transport({ totalMs: 5000, now: clock.now, media })
    t.play()
    t.mediaPlaying()
    media.currentTime = 1
    clock.advance(1000)
    expect(t.tick()).toBeCloseTo(1000)
    t.mediaStalled()
    clock.advance(100)
    expect(t.tick()).toBeCloseTo(1100)
    t.pause()
    expect(media.paused).toBe(true)
    expect(t.state).toBe('paused')
  })

  it('the sound plays at the chosen speed', () => {
    const clock = fakeClock()
    const media = new FakeMedia()
    const t = new Transport({ totalMs: 5000, now: clock.now, media })
    t.setSpeed(2)
    t.play()
    expect(media.playbackRate).toBe(2)
  })
})
