// presence.ts frames after the per-tick serialization of each changed peer: every frame a recipient gets
// parses to exactly what `JSON.stringify({type, peers, off?, drags?})` gave before (the shared frame of a
// small board, the capped per-recipient frames of a large one, drags and `off` included).

import { CURSORS_PER_RECIPIENT } from '@draftroom/canvas-schema/limits'
import { ServerMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { PresenceHub, type PresenceRecipient } from './presence.ts'

function hub(n: number) {
  let now = 1_000
  const h = new PresenceHub(() => now)
  const frames = new Map<string, string[]>()
  const recipients: PresenceRecipient[] = []
  for (let i = 0; i < n; i++) {
    const sid = `u${i}:t`
    frames.set(sid, [])
    recipients.push({ sid, key: i + 1, congested: false, send: (f) => frames.get(sid)?.push(f) })
  }
  const move = (i: number, x: number, drag?: unknown) =>
    h.input(
      `u${i}:t`,
      false,
      {
        pointer: { x, y: i },
        button: 'up',
        sel: [],
        view: { x: 0, y: 0, w: 1000, h: 1000 },
        idle: false,
        editing: null,
        ...(drag !== undefined ? { drag } : {}),
      } as never,
      false,
    )
  const tick = () => {
    now += 100
    h.tick(recipients)
  }
  return { h, frames, recipients, move, tick }
}

const parsed = (f: string) => {
  const r = ServerMessage.safeParse(JSON.parse(f))
  if (!r.success) throw new Error(r.error.issues[0]?.message)
  return r.data
}

describe('presence frames', () => {
  it('a small board: one shared frame, valid, with every changed peer; the mover gets it without itself', () => {
    const { frames, move, tick } = hub(5)
    move(0, 10)
    move(1, 11)
    tick()
    const f2 = frames.get('u2:t') as string[]
    const f3 = frames.get('u3:t') as string[]
    expect(f2).toHaveLength(1)
    expect(f2[0]).toBe(f3[0]) // the same serialization for everyone whose own entry is not in it
    const m = parsed(f2[0] as string)
    expect(m.type).toBe('presence')
    if (m.type !== 'presence') return
    expect(m.peers.map((p) => [p.sid, p.pointer?.x])).toEqual([
      ['u0:t', 10],
      ['u1:t', 11],
    ])
    expect(m.off).toBeUndefined()
    expect(m.drags).toBeUndefined()
    // the frame is the plain serialization of the object (key order type, peers)
    expect(f2[0]).toBe(JSON.stringify({ type: 'presence', peers: m.peers }))
    const own = parsed((frames.get('u0:t') as string[])[0] as string)
    if (own.type === 'presence') expect(own.peers.map((p) => p.sid)).toEqual(['u1:t'])
  })

  it('drags ride in the frame; a drag end goes out as such', () => {
    const { frames, move, tick } = hub(3)
    move(0, 1, { d: 1, ids: ['a', 'b'], dx: 2.26, dy: 0 })
    tick()
    const m = parsed((frames.get('u1:t') as string[])[0] as string)
    if (m.type !== 'presence') throw new Error('presence expected')
    expect(m.drags).toEqual([{ sid: 'u0:t', d: 1, ids: ['a', 'b'], dx: 2.3, dy: 0 }])
    expect((frames.get('u1:t') as string[])[0]).toBe(
      JSON.stringify({ type: 'presence', peers: m.peers, drags: m.drags }),
    )
    move(0, 2, null)
    tick()
    const end = parsed((frames.get('u1:t') as string[])[1] as string)
    if (end.type === 'presence') expect(end.drags).toEqual([{ sid: 'u0:t', d: 1, end: true }])
  })

  it('a large board: capped per-recipient frames, each valid, at most the cap, every peer serialized once', () => {
    const n = CURSORS_PER_RECIPIENT + 12
    const { frames, move, tick } = hub(n)
    for (let i = 0; i < n; i++) move(i, i * 3)
    tick()
    for (const [sid, fs] of frames) {
      expect(fs).toHaveLength(1)
      const m = parsed(fs[0] as string)
      if (m.type !== 'presence') throw new Error('presence expected')
      expect(m.peers.length).toBeLessThanOrEqual(CURSORS_PER_RECIPIENT)
      expect(m.peers.some((p) => p.sid === sid)).toBe(false)
      // the entries are the peers' own serializations: byte-identical across recipients
      for (const p of m.peers) expect((fs[0] as string).includes(JSON.stringify(p))).toBe(true)
    }
    // a recipient's shown set fills up: a second tick with everyone moving again sends only shown peers
    for (let i = 0; i < n; i++) move(i, i * 5)
    tick()
    const second = parsed((frames.get('u0:t') as string[])[1] as string)
    if (second.type === 'presence') expect(second.peers.length).toBeLessThanOrEqual(CURSORS_PER_RECIPIENT)
  })
})
