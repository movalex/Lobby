import { describe, expect, it } from 'vitest'
import { rectContains, rectsOverlap } from '../canvas-ux/placement.ts'
import { FRAME_PLACE_PAD, fitFrameAround, placeInFrame } from './frame-place.ts'

const ROOM = { w: 976, h: 360 }

describe('placeInFrame (R7)', () => {
  it('uses free space inside the frame, clear of its content, without growing it', () => {
    const frame = { x: 0, y: 0, w: 1600, h: 1200 }
    const notes = [{ x: 60, y: 60, w: 1480, h: 400 }]
    const p = placeInFrame(ROOM, { x: 800, y: 300 }, frame, notes)
    expect(p.growToH).toBeNull()
    const box = { ...p.at, ...p.room }
    expect(rectContains(frame, box)).toBe(true)
    for (const n of notes) expect(rectsOverlap(box, n)).toBe(false)
  })

  it('a full frame grows downward and the map goes below its content (the Retro frame)', () => {
    const frame = { x: -560, y: 216, w: 1600, h: 960 }
    const notes = [
      { x: -500, y: 280, w: 700, h: 800 },
      { x: 260, y: 280, w: 700, h: 820 },
    ]
    const p = placeInFrame(ROOM, { x: 240, y: 700 }, frame, notes)
    const box = { ...p.at, ...p.room }
    expect(p.growToH).not.toBeNull()
    const grown = { ...frame, h: p.growToH as number }
    expect(rectContains(grown, box)).toBe(true)
    for (const n of notes) expect(rectsOverlap(box, n)).toBe(false)
    expect(box.y).toBeGreaterThanOrEqual(1100 + FRAME_PLACE_PAD)
    // Centred on the view horizontally, as far as the frame allows.
    expect(box.x + box.w / 2).toBeCloseTo(240)
  })

  it('a frame narrower than the room narrows the room to the frame', () => {
    const frame = { x: 0, y: 0, w: 700, h: 600 }
    const p = placeInFrame(ROOM, { x: 350, y: 300 }, frame, [])
    expect(p.room.w).toBe(700 - 2 * FRAME_PLACE_PAD)
    expect(rectContains(frame, { ...p.at, ...p.room })).toBe(true)
    expect(p.growToH).toBeNull()
  })
})

describe('fitFrameAround (R7)', () => {
  const frame = { x: 0, y: 0, w: 1000, h: 800 }

  it('changes nothing while the map fits', () => {
    expect(fitFrameAround(frame, { x: 100, y: 100, w: 500, h: 400 })).toBeNull()
  })

  it('grows the frame right and down around a map that grew past its edges', () => {
    const fit = fitFrameAround(frame, { x: 600, y: 500, w: 600, h: 500 })
    expect(fit).toEqual({ dx: 0, dy: 0, w: 1232, h: 1032 })
  })

  it('moves a map off the top and left edges, then grows the frame to hold it', () => {
    const fit = fitFrameAround(frame, { x: -50, y: -100, w: 400, h: 300 })
    expect(fit).toMatchObject({ dx: 82, dy: 132 })
    expect(fit?.h).toBe(800)
    const tall = fitFrameAround(frame, { x: 100, y: -200, w: 400, h: 1000 })
    expect(tall).toMatchObject({ dx: 0, dy: 232, h: 1064 })
  })

  it('leaves a map moved wholly outside the frame alone', () => {
    expect(fitFrameAround(frame, { x: 1400, y: 0, w: 300, h: 200 })).toBeNull()
    expect(fitFrameAround(frame, null)).toBeNull()
  })
})
