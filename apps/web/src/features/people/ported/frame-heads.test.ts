// L6-2 (wave L): frame head counts (./frame-heads.ts).
import { describe, expect, it } from 'vitest'
import { frameHeads, innermostFrame } from './frame-heads.ts'

const frame = (id: string, x: number, y: number, width: number, height: number) => ({
  id,
  x,
  y,
  width,
  height,
})
const peer = (sid: string, cx: number, cy: number, uid = sid) => ({
  sid,
  uid,
  view: { x: cx - 200, y: cy - 100, width: 400, height: 200 },
})

describe('frame heads', () => {
  it('a person counts toward the innermost frame that contains their view centre', () => {
    const outer = frame('outer', 0, 0, 2000, 2000)
    const inner = frame('inner', 100, 100, 500, 500)
    const other = frame('other', 3000, 0, 800, 600)
    const heads = frameHeads(
      [outer, inner, other],
      [peer('a', 300, 300), peer('b', 1500, 1500), peer('c', 3400, 300)],
    )
    expect(heads.get('inner')?.map((p) => p.sid)).toEqual(['a'])
    expect(heads.get('outer')?.map((p) => p.sid)).toEqual(['b'])
    expect(heads.get('other')?.map((p) => p.sid)).toEqual(['c'])
    // the order of the frames does not change which is innermost
    expect(frameHeads([inner, outer], [peer('a', 300, 300)]).get('inner')?.length).toBe(1)
  })

  it('a peer with no view, or one the room does not stream, is not counted; nor is one outside every frame', () => {
    const f = frame('f', 0, 0, 1000, 1000)
    const heads = frameHeads(
      [f],
      [
        { sid: 'noview', uid: 'noview', view: null },
        { ...peer('capped', 500, 500), streaming: false },
        peer('away', 5000, 5000),
        peer('here', 500, 500),
      ],
    )
    expect([...heads.keys()]).toEqual(['f'])
    expect(heads.get('f')?.map((p) => p.sid)).toEqual(['here'])
  })

  it('a person with two tabs is one face', () => {
    const heads = frameHeads(
      [frame('f', 0, 0, 1000, 1000)],
      [peer('t1', 400, 400, 'u1'), peer('t2', 600, 600, 'u1')],
    )
    expect(heads.get('f')?.map((p) => p.sid)).toEqual(['t1'])
  })

  it('innermostFrame: a tie goes to the frame drawn later; empty frames never match', () => {
    const a = frame('a', 0, 0, 100, 100)
    const b = frame('b', 0, 0, 100, 100)
    expect(innermostFrame([a, b], { x: 50, y: 50 })?.id).toBe('b')
    expect(innermostFrame([frame('z', 0, 0, 0, 100)], { x: 0, y: 50 })).toBeNull()
    expect(frameHeads([], [peer('a', 1, 1)]).size).toBe(0)
  })
})
