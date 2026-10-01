// V2's re-check (wave 5, 2A): a relayed drag kept alive by one frame every 10 s stayed up for everyone,
// late joiners included. The relay now ends any drag a minute after its start, and the expired drag cannot
// start again by re-sending its ids. Failed on f336ae4 (the drag was still relayed after 70 s); a real
// drag is unchanged. PresenceHub on a fake clock (no server).

import type { PresenceIn } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { DRAG_TTL_MS, PresenceHub } from '../../src/room/presence.ts'

const msg = (drag: PresenceIn['drag']): PresenceIn => ({
  type: 'presence',
  pointer: { x: 1, y: 1 },
  button: 'down',
  sel: [],
  view: null,
  idle: false,
  editing: null,
  drag,
})

function hub() {
  let now = 1_000_000
  const h = new PresenceHub(() => now)
  const sent: string[] = []
  const tick = () =>
    h.tick([{ sid: 'quinn:t', key: 1, congested: false, send: (f: string) => void sent.push(f) }])
  return {
    h,
    sent,
    tick,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('the drag relay ends a drag a minute after its start (V2 re-check)', () => {
  it('one frame every 10 s no longer keeps a drag up past 60 s; an expired drag cannot be restarted', () => {
    const { h, tick, advance } = hub()
    h.input('mallory:t', false, msg({ d: 1, ids: ['n1'], dx: 0, dy: 0 }), false)
    tick()
    for (let t = 10_000; t <= 50_000; t += 10_000) {
      advance(10_000)
      h.input('mallory:t', false, msg({ d: 1, dx: t / 1000, dy: 0 }), false)
      tick()
    }
    expect(h.activeDrags().map((d) => d.sid)).toEqual(['mallory:t'])
    advance(10_000)
    h.input('mallory:t', false, msg({ d: 1, dx: 60, dy: 0 }), false)
    advance(1_000)
    tick()
    expect(h.activeDrags()).toEqual([])
    // re-sending the ids of the expired drag does not bring it back; a new drag does start
    advance(100)
    h.input('mallory:t', false, msg({ d: 1, ids: ['n1'], dx: 0, dy: 0 }), false)
    expect(h.activeDrags()).toEqual([])
    advance(100)
    h.input('mallory:t', false, msg({ d: 2, ids: ['n2'], dx: 0, dy: 0 }), false)
    expect(h.activeDrags().map((d) => [d.sid, d.d])).toEqual([['mallory:t', 2]])
  })

  it('a quiet drag still ends after DRAG_TTL_MS, and a short real drag is relayed as before', () => {
    const { h, sent, tick, advance } = hub()
    h.input('ann:t', false, msg({ d: 7, ids: ['a', 'b'], dx: 0, dy: 0 }), false)
    tick()
    advance(100)
    h.input('ann:t', false, msg({ d: 7, dx: 5, dy: 5 }), false)
    tick()
    expect(sent.some((f) => f.includes('"dx":5'))).toBe(true)
    advance(DRAG_TTL_MS + 1)
    tick()
    expect(h.activeDrags()).toEqual([])
    expect(sent.some((f) => f.includes('"end":true'))).toBe(true)
  })
})
