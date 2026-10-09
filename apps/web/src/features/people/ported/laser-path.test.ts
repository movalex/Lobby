// L6-1 (wave L): the shape of another session's laser (./laser-path.ts), pure.
import { describe, expect, it } from 'vitest'
import { catmullRom, LASER_FADE_MS, LASER_WIDTH_PX, laserShape, taperedOutline } from './laser-path.ts'

const id = (p: { x: number; y: number }) => p
const samples = (n: number, now: number, stepMs = 30) =>
  Array.from({ length: n }, (_, i) => ({ x: i * 20, y: 10, at: now - (n - 1 - i) * stepMs }))

describe('laserShape', () => {
  it('a trail of fresh samples is one closed outline, widest at the newest sample', () => {
    const now = 10_000
    const s = laserShape(samples(8, now), now, id)
    expect(s?.samples).toBe(8)
    expect(s?.d).toMatch(/^M.* Z$/)
    expect(s?.head).toEqual({ x: 140, y: 10 })
    // the outline's points around the head are LASER_WIDTH_PX apart (half above, half below the line)
    const nums = (s?.d ?? '').replace(/[MLZ]/g, ' ').trim().split(/\s+/).map(Number)
    const ys = nums.filter((_, i) => i % 2 === 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(LASER_WIDTH_PX, 0)
  })

  it('samples older than the fade are dropped; with none left there is nothing to draw', () => {
    const now = 10_000
    const old = samples(5, now - LASER_FADE_MS - 200)
    expect(laserShape(old, now, id)).toBeNull()
    // a pressed laser keeps its newest sample: a dot, no line
    const held = laserShape(old, now, id, { keepNewest: true })
    expect(held).toMatchObject({ d: null, samples: 1, head: { x: 80, y: 10 } })
    // part of a trail faded: only the young samples are drawn
    const mixed = [
      ...samples(3, now - LASER_FADE_MS - 100),
      ...samples(4, now).map((p) => ({ ...p, x: p.x + 500 })),
    ]
    expect(laserShape(mixed, now, id)?.samples).toBe(4)
  })

  it('maps samples through toOverlay (a camera move moves the trail)', () => {
    const now = 0
    const s = laserShape(samples(3, now), now, (p) => ({ x: p.x * 2 - 100, y: p.y * 2 }))
    expect(s?.head).toEqual({ x: -20, y: 20 })
  })
})

describe('the smoothing and the outline', () => {
  it('Catmull-Rom passes through every sample and adds points between them', () => {
    const pts = [
      { x: 0, y: 0, w: 1 },
      { x: 10, y: 10, w: 2 },
      { x: 20, y: 0, w: 3 },
    ]
    const out = catmullRom(pts, 4)
    expect(out).toHaveLength(9)
    expect(out[0]).toEqual(pts[0])
    expect(out[4]).toMatchObject({ x: 10, y: 10, w: 2 })
    expect(out.at(-1)).toEqual(pts[2])
    expect(catmullRom(pts.slice(0, 2))).toHaveLength(2)
  })

  it('an outline needs two points; a point repeated does not break it', () => {
    expect(taperedOutline([{ x: 0, y: 0, w: 2 }])).toBeNull()
    expect(
      taperedOutline([
        { x: 0, y: 0, w: 2 },
        { x: 0, y: 0, w: 2 },
      ]),
    ).toMatch(/^M0 1 L0 1 L0 -1 L0 -1 Z$/)
  })
})
