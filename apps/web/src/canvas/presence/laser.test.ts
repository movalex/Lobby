// L6-1 (wave L): the client half of the shared laser, pure parts (./laser.ts): what this tab sends as `trail`,
// how another session's samples are kept and fade, the per-core tool and laser registries.
import { COORD_LIMIT } from '@draftroom/canvas-schema/limits'
import { MAX_LASER_TRAIL_POINTS, type PeerPresence } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import {
  LASER_HOLD_MS,
  LASER_MAX_SAMPLES,
  LASER_TRAIL_MS,
  LaserTrails,
  lasersOf,
  laserToolOn,
  laserTrailOut,
  provideLasers,
  setLaserToolSource,
  thinPoints,
} from './laser.ts'

const peer = (sid: string, p: Partial<PeerPresence>): PeerPresence => ({
  sid,
  pointer: { x: 0, y: 0 },
  button: 'down',
  sel: [],
  view: null,
  idle: false,
  editing: null,
  ...p,
})

describe('laserTrailOut: the trail this tab sends', () => {
  it('integer points inside the coordinate limit, oldest first, without repeats or the pointer itself', () => {
    const out = laserTrailOut(
      [
        { x: 1.4, y: 2.6 },
        { x: 1.2, y: 2.9 }, // the same integer point again
        { x: 3e9, y: -3e9 },
        { x: Number.NaN, y: 0 },
        { x: 10, y: 10 },
      ],
      { x: 10.2, y: 9.8 },
    )
    expect(out).toEqual([
      { x: 1, y: 3 },
      { x: COORD_LIMIT, y: -COORD_LIMIT },
    ])
  })

  it('at most MAX_LASER_TRAIL_POINTS, thinned evenly (first and last kept)', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i * 5, y: 0 }))
    const out = laserTrailOut(pts, { x: 500, y: 0 })
    expect(out).toHaveLength(MAX_LASER_TRAIL_POINTS)
    expect(out[0]).toEqual({ x: 0, y: 0 })
    expect(out.at(-1)).toEqual({ x: 95, y: 0 })
    expect(laserTrailOut([], null)).toEqual([])
    expect(thinPoints([1, 2, 3], 6)).toEqual([1, 2, 3])
    expect(thinPoints([1, 2, 3, 4, 5], 1)).toEqual([5])
  })
})

describe('LaserTrails: the other sessions’ lasers', () => {
  it('an entry with t adds its trail and pointer, spread over the time since the previous entry', () => {
    const t = new LaserTrails()
    t.apply(peer('a', { t: 'laser', pointer: { x: 10, y: 0 } }), 1_000)
    t.apply(
      peer('a', {
        t: 'laser',
        pointer: { x: 40, y: 0 },
        trail: [
          { x: 20, y: 0 },
          { x: 30, y: 0 },
        ],
      }),
      1_100,
    )
    const [a] = t.trails(1_100)
    expect(a?.active).toBe(true)
    expect(a?.points.map((p) => p.x)).toEqual([10, 20, 30, 40])
    const ats = a?.points.map((p) => Math.round(p.at)) ?? []
    expect(ats[0]).toBe(1_000)
    expect(ats.slice(1)).toEqual([1_033, 1_067, 1_100])
  })

  it('an entry without t ends the press; what was drawn fades within LASER_TRAIL_MS and the laser goes', () => {
    const t = new LaserTrails()
    t.apply(peer('a', { t: 'laser', pointer: { x: 1, y: 0 } }), 0)
    t.apply(peer('a', { t: 'laser', pointer: { x: 2, y: 0 } }), 100)
    t.apply(peer('a', { button: 'up', pointer: { x: 3, y: 0 } }), 200)
    expect(t.trails(200)[0]).toMatchObject({ active: false })
    expect(t.trails(200)[0]?.points.map((p) => p.x)).toEqual([1, 2]) // a release adds no sample
    expect(t.trails(100 + LASER_TRAIL_MS + 1)).toEqual([])
    expect(t.any(100 + LASER_TRAIL_MS + 1)).toBe(false)
  })

  it('a pressed laser keeps its newest sample (its dot) until LASER_HOLD_MS without an entry', () => {
    const t = new LaserTrails()
    t.apply(peer('a', { t: 'laser', pointer: { x: 1, y: 0 } }), 0)
    t.apply(peer('a', { t: 'laser', pointer: { x: 2, y: 0 } }), 50)
    expect(t.trails(2_000)[0]?.points.map((p) => p.x)).toEqual([2])
    expect(t.trails(LASER_HOLD_MS + 100)).toEqual([])
  })

  it('peers without the laser are never kept; remove and clear forget at once; samples are bounded', () => {
    const t = new LaserTrails()
    t.apply(peer('b', { button: 'up' }), 0)
    expect(t.trails(0)).toEqual([])
    for (let i = 0; i < LASER_MAX_SAMPLES + 50; i++)
      t.apply(peer('a', { t: 'laser', pointer: { x: i, y: 0 } }), i)
    expect(t.trails(LASER_MAX_SAMPLES + 50)[0]?.points.length).toBeLessThanOrEqual(LASER_MAX_SAMPLES)
    t.remove('a')
    expect(t.trails(200)).toEqual([])
    t.apply(peer('c', { t: 'laser' }), 0)
    t.clear()
    expect(t.trails(0)).toEqual([])
  })
})

describe('the per-core registries', () => {
  it('the tool source and the laser source are keyed by the core; removal leaves a newer one alone', () => {
    const core = {}
    expect(laserToolOn(core)).toBe(false)
    let tool = 'select'
    const off = setLaserToolSource(core, () => tool === 'laser')
    expect(laserToolOn(core)).toBe(false)
    tool = 'laser'
    expect(laserToolOn(core)).toBe(true)
    expect(laserToolOn({})).toBe(false)
    off()
    expect(laserToolOn(core)).toBe(false)
    // a source that throws reads as no laser
    setLaserToolSource(core, () => {
      throw new Error('boom')
    })
    expect(laserToolOn(core)).toBe(false)

    expect(lasersOf(core, 0)).toEqual([])
    const a = provideLasers(core, () => [{ sid: 'x', active: true, points: [] }])
    const b = provideLasers(core, () => [{ sid: 'y', active: true, points: [] }])
    a() // an older provider's removal does not remove the newer one
    expect(lasersOf(core, 0).map((l) => l.sid)).toEqual(['y'])
    b()
    expect(lasersOf(core, 0)).toEqual([])
    expect(lasersOf(null, 0)).toEqual([])
  })
})
