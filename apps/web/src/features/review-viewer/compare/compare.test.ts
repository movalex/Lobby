// WS2 (wave S): compare's geometry (fit, letterbox, the slider's clip, the shared zoom and pan) and the video A/B
// follower (B on A's clock, on a fake clock).
import { describe, expect, it } from 'vitest'
import {
  FIT,
  fitBox,
  MAX_ZOOM,
  panBy,
  percentAt,
  sameAspect,
  sharedBox,
  sliderClip,
  viewTransform,
  zoomAt,
} from './geometry.ts'
import {
  DRIFT_TOLERANCE_S,
  FOLLOW_INTERVAL_MS,
  follow,
  followStep,
  formatTimecode,
  type MediaClock,
} from './video-sync.ts'

describe('fit and letterbox', () => {
  it('fits without cropping, centred; an unknown size fills the box', () => {
    expect(fitBox({ w: 1600, h: 900 }, { w: 800, h: 800 })).toEqual({ x: 0, y: 175, w: 800, h: 450 })
    expect(fitBox({ w: 900, h: 1600 }, { w: 800, h: 800 })).toEqual({ x: 175, y: 0, w: 450, h: 800 })
    expect(fitBox(null, { w: 300, h: 200 })).toEqual({ x: 0, y: 0, w: 300, h: 200 })
    expect(fitBox({ w: 0, h: 10 }, { w: 300, h: 200 })).toEqual({ x: 0, y: 0, w: 300, h: 200 })
  })

  it('the slider box takes A’s proportions; different proportions are reported, 1 % is the same', () => {
    expect(sharedBox({ w: 1600, h: 900 }, { w: 900, h: 1600 }, { w: 1000, h: 1000 })).toEqual({
      w: 1000,
      h: 562.5,
    })
    expect(sharedBox(null, { w: 1000, h: 500 }, { w: 1000, h: 1000 })).toEqual({ w: 1000, h: 500 })
    expect(sharedBox(null, null, { w: 640, h: 480 })).toEqual({ w: 640, h: 480 })
    expect(sameAspect({ w: 1600, h: 900 }, { w: 1920, h: 1080 })).toBe(true)
    expect(sameAspect({ w: 1600, h: 900 }, { w: 1600, h: 905 })).toBe(true)
    expect(sameAspect({ w: 1600, h: 900 }, { w: 900, h: 1600 })).toBe(false)
    expect(sameAspect(null, { w: 1, h: 2 })).toBe(true)
  })

  it('the slider clips B right of the divider; a pointer maps to a clamped percent', () => {
    expect(sliderClip(30)).toBe('inset(0 0 0 30%)')
    expect(sliderClip(-5)).toBe('inset(0 0 0 0%)')
    expect(sliderClip(140)).toBe('inset(0 0 0 100%)')
    expect(sliderClip(Number.NaN)).toBe('inset(0 0 0 50%)')
    expect(percentAt(150, 100, 200)).toBe(25)
    expect(percentAt(50, 100, 200)).toBe(0)
    expect(percentAt(400, 100, 200)).toBe(100)
    expect(percentAt(150, 100, 0)).toBe(50)
  })
})

describe('side by side: one zoom and pan', () => {
  it('zooms at the pointer (the point under it stays), clamps, and is centred again at the fitted zoom', () => {
    const v = zoomAt(FIT, 2, { x: 100, y: 50 })
    expect(v).toEqual({ zoom: 2, x: -100, y: -50 })
    // the content point under the pointer: (100 - x) / zoom stays 100 / 1
    expect((100 - v.x) / v.zoom).toBe(100)
    expect(zoomAt(v, 100, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(v, 0.1, { x: 30, y: 30 })).toEqual(FIT)
    expect(zoomAt(v, Number.NaN, { x: 0, y: 0 })).toEqual(v)
    expect(viewTransform(v)).toBe('translate(-100px, -50px) scale(2)')
  })

  it('pans inside the content’s overflow only; at the fitted zoom nothing pans', () => {
    const pane = { w: 400, h: 300 }
    const v = { zoom: 2, x: -100, y: -50 }
    expect(panBy(v, 50, 20, pane)).toEqual({ zoom: 2, x: -50, y: -30 })
    expect(panBy(v, 500, 500, pane)).toEqual({ zoom: 2, x: 0, y: 0 })
    expect(panBy(v, -1000, -1000, pane)).toEqual({ zoom: 2, x: -400, y: -300 })
    expect(panBy(FIT, 10, 10, pane)).toEqual(FIT)
  })
})

function fakeVideo(init: Partial<MediaClock> = {}) {
  const v = {
    currentTime: 0,
    paused: true,
    playbackRate: 1,
    muted: false,
    seeks: 0,
    play() {
      v.paused = false
    },
    pause() {
      v.paused = true
    },
    ...init,
  }
  return new Proxy(v, {
    set(t, k, val) {
      if (k === 'currentTime') t.seeks++
      ;(t as Record<string | symbol, unknown>)[k] = val
      return true
    },
  })
}

function fakeClock() {
  let now = 0
  const timers: { every: number; next: number; run: () => void; on: boolean }[] = []
  const frames: (() => void)[] = []
  return {
    scheduler: {
      every(ms: number, run: () => void) {
        const t = { every: ms, next: now + ms, run, on: true }
        timers.push(t)
        return () => {
          t.on = false
        }
      },
      onFrame(run: () => void) {
        frames.push(run)
        return () => {
          const i = frames.indexOf(run)
          if (i >= 0) frames.splice(i, 1)
        }
      },
    },
    advance(ms: number) {
      now += ms
      for (const t of timers)
        while (t.on && t.next <= now) {
          t.next += t.every
          t.run()
        }
    },
    frame() {
      const run = frames.shift()
      run?.()
    },
    pendingFrames: () => frames.length,
  }
}

describe('video A/B: B follows A', () => {
  it('one step: B is muted, takes A’s rate and play state, and is seeked only past the tolerance', () => {
    const a = fakeVideo({ currentTime: 10, paused: false, playbackRate: 1.5 })
    const b = fakeVideo({ currentTime: 10 + DRIFT_TOLERANCE_S / 2 })
    expect(followStep(a, b)).toBe(false)
    expect(b).toMatchObject({ muted: true, playbackRate: 1.5, paused: false, seeks: 0 })
    b.currentTime = 10.2
    b.seeks = 0
    expect(followStep(a, b)).toBe(true)
    expect(b.currentTime).toBe(10)
    a.pause()
    followStep(a, b)
    expect(b.paused).toBe(true)
  })

  it('on a fake clock: every frame and every 250 ms; a seek of A while paused reaches B; stop ends it', () => {
    const clock = fakeClock()
    const a = fakeVideo()
    const b = fakeVideo()
    const stop = follow(a, b, clock.scheduler)
    expect(b.muted).toBe(true)
    a.play()
    a.currentTime = 1
    clock.frame() // A's next frame
    expect(b).toMatchObject({ paused: false, currentTime: 1 })
    expect(clock.pendingFrames()).toBe(1) // asks for the next one
    // paused A: no frames, the timer still runs
    a.pause()
    a.currentTime = 42
    clock.advance(FOLLOW_INTERVAL_MS)
    expect(b).toMatchObject({ paused: true, currentTime: 42 })
    stop()
    a.currentTime = 7
    clock.advance(FOLLOW_INTERVAL_MS * 4)
    clock.frame()
    expect(b.currentTime).toBe(42)
  })

  it('timecodes', () => {
    expect(formatTimecode(12.43)).toBe('0:12.4')
    expect(formatTimecode(75)).toBe('1:15.0')
    expect(formatTimecode(3723.5)).toBe('1:02:03.5')
    expect(formatTimecode(Number.NaN)).toBe('0:00.0')
  })
})
