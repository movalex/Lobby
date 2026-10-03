// W5-51: which frame names would run into a neighbouring frame (./frame-names.ts). Boxes are screen pixels:
// a frame's name is a label 17.5 px high, just above the frame's top edge, at most as wide as the frame.
import { describe, expect, it } from 'vitest'
import { crowdedFrameNames, type FrameNameBoxes, hiddenNamesCss } from './frame-names.ts'

const NAME_H = 17.5
const OFFSET = 6

/** A frame at (x, y) w × h on screen with a name `nameW` wide (cut to the frame's width, as the engine does). */
const frame = (id: string, x: number, y: number, w: number, h: number, nameW = 80): FrameNameBoxes => ({
  id,
  frame: { x, y, width: w, height: h },
  name: { x, y: y - OFFSET - NAME_H, width: Math.min(nameW, w), height: NAME_H },
})

describe('crowded frame names (W5-51)', () => {
  it('a grid zoomed out: each lower frame’s name lands on the frame above it, so only the top row keeps names', () => {
    // a template's 2 × 2 grid (frames 1000 × 600 scene px, 120 px apart) at 14 %: the gap is 16.8 px
    const z = 0.14
    const at = (c: number, r: number) =>
      frame(`f${c}${r}`, c * 1120 * z, 100 + r * 720 * z, 1000 * z, 600 * z)
    const grid = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)]
    expect([...crowdedFrameNames(grid)].sort()).toEqual(['f01', 'f11'])
  })

  it('the same grid at fit zoom (the gap is wider than a name): every name stays', () => {
    const z = 0.45
    const at = (c: number, r: number) =>
      frame(`f${c}${r}`, c * 1120 * z, 100 + r * 720 * z, 1000 * z, 600 * z)
    expect(crowdedFrameNames([at(0, 0), at(1, 0), at(0, 1), at(1, 1)]).size).toBe(0)
  })

  it('side by side frames never crowd each other (a name is no wider than its frame)', () => {
    const row = [frame('a', 0, 100, 140, 84, 400), frame('b', 150, 100, 140, 84, 400)]
    expect(crowdedFrameNames(row).size).toBe(0)
  })

  it('a frame inside another frame keeps its name at 100 % (a converted board’s lifted nested frame)', () => {
    // the review's probe: Outer 1000 × 700, Inner at (100, 200) 300 × 200, zoom 1
    const outer = frame('outer', 0, 0, 1000, 700)
    const inner = frame('inner', 100, 200, 300, 200)
    expect(crowdedFrameNames([outer, inner]).size).toBe(0)
    expect(crowdedFrameNames([inner, outer]).size).toBe(0)
  })

  it('a frame laid over part of another keeps its name, and so does the one under it', () => {
    const under = frame('under', 0, 100, 400, 300)
    const over = frame('over', 250, 300, 400, 300)
    expect(crowdedFrameNames([under, over]).size).toBe(0)
  })

  it('two frames inside one frame still crowd each other zoomed out: the lower name hides', () => {
    // a parent with two children stacked 120 px apart, at 14 %: the lower child's name lands on the upper child
    const z = 0.14
    const parent = frame('parent', 0, 0, 2000 * z, 2000 * z)
    const upper = frame('upper', 100 * z, 200 * z, 1000 * z, 600 * z)
    const lower = frame('lower', 100 * z, 920 * z, 1000 * z, 600 * z)
    expect([...crowdedFrameNames([parent, upper, lower])]).toEqual(['lower'])
  })

  it('a name on a neighbouring frame hides, unless it is being edited', () => {
    const above = frame('above', 0, 0, 200, 90)
    const below = frame('below', 0, 100, 200, 90)
    expect([...crowdedFrameNames([above, below])]).toEqual(['below'])
    expect(crowdedFrameNames([above, { ...below, editing: true }]).size).toBe(0)
  })

  it('of two names that overlap each other, the upper one stays', () => {
    // a's name spans y 76.5 to 94; b's (a drag preview's offset put it there) 80 to 97.5, clear of a's frame
    const a = frame('a', 0, 100, 60, 10)
    const b = { ...frame('b', 30, 500, 60, 10), name: { x: 30, y: 80, width: 60, height: NAME_H } }
    expect([...crowdedFrameNames([a, b])]).toEqual(['b'])
    expect([...crowdedFrameNames([b, a])]).toEqual(['b'])
  })

  it('a frame drawn with no name now (out of view) is still a neighbour, and hides nothing itself', () => {
    const above = { ...frame('above', 0, 0, 200, 90), name: null }
    const below = frame('below', 0, 100, 200, 90)
    expect([...crowdedFrameNames([above, below])]).toEqual(['below'])
  })

  it('the stylesheet hides exactly those labels, and never puts an id that is not an element id in a selector', () => {
    expect(hiddenNamesCss(['b2', 'a1'])).toBe(
      '.excalidraw .frame-name[id$="-frame-name-a1"]{visibility:hidden}\n' +
        '.excalidraw .frame-name[id$="-frame-name-b2"]{visibility:hidden}',
    )
    expect(hiddenNamesCss(['x"]{} body{display:none', ''])).toBe('')
  })
})
