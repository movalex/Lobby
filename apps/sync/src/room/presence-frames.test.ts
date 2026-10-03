// presence.ts frames after the per-tick serialization of each changed peer: every frame a recipient gets
// parses to exactly what `JSON.stringify({type, peers, off?, drags?})` gave before (the shared frame of a
// small board, the capped per-recipient frames of a large one, drags and `off` included).

import { CURSORS_PER_RECIPIENT } from '@draftroom/canvas-schema/limits'
import { type PeerPresence, ServerMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PresenceHub, type PresenceRecipient, RERANK_EVERY_TICKS } from './presence.ts'

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

// ---- CR-3C-1 (wave A, A2): follow target, the cap's re-rank, followers, rev-9 recipients -------------------

/** Rev 9's presence frame, as a rev-9 client parses it (strict: no `f`, no `view.z`, no `followers`). */
const Rect9 = z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const PresenceOut9 = z.strictObject({
  type: z.literal('presence'),
  peers: z.array(
    z.strictObject({
      sid: z.string(),
      pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
      button: z.enum(['up', 'down']),
      sel: z.unknown(),
      view: Rect9.nullable(),
      idle: z.boolean(),
      editing: z.string().nullable(),
    }),
  ),
  off: z.array(z.string()).optional(),
  drags: z.array(z.unknown()).optional(),
})

type View = { x: number; y: number; w: number; h: number; z?: number }

/** A room of `n` sessions on a fake clock: every recipient's frames, what it holds, its followers list. */
function room(n: number) {
  let now = 1_000
  const h = new PresenceHub(() => now)
  const frames = new Map<string, string[]>()
  const held = new Map<string, Map<string, PeerPresence>>()
  const followers = new Map<string, string[] | undefined>()
  const recipients: PresenceRecipient[] = []
  const sid = (i: number) => `u${String(i).padStart(3, '0')}:t`
  const join = (i: number) => {
    const s = sid(i)
    frames.set(s, [])
    held.set(s, new Map())
    const take = (f: string) => {
      frames.get(s)?.push(f)
      const m = parsed(f)
      if (m.type !== 'presence') throw new Error('presence expected')
      const mine = held.get(s) as Map<string, PeerPresence>
      for (const p of m.peers) mine.set(p.sid, p)
      for (const o of m.off ?? []) mine.delete(o)
      if (m.followers) followers.set(s, m.followers)
    }
    recipients.push({ sid: s, key: i + 1, congested: false, send: take })
    return take
  }
  for (let i = 0; i < n; i++) join(i)
  const say = (
    i: number,
    p: { pointer?: { x: number; y: number } | null; view?: View | null; f?: string | null; rich?: boolean },
  ) => {
    now += 60 // under 20 Hz per session
    return h.input(
      sid(i),
      false,
      {
        type: 'presence',
        pointer: p.pointer === undefined ? { x: 5_000 + i, y: 5_000 } : p.pointer,
        button: 'up',
        sel: [],
        view: p.view ?? null,
        idle: false,
        editing: null,
        ...(p.rich || p.f !== undefined ? { f: p.f ?? null } : {}),
      },
      false,
      i + 1,
    )
  }
  const tick = () => {
    now += 100
    h.tick(recipients)
  }
  const leave = (i: number) => {
    const s = sid(i)
    const at = recipients.findIndex((r) => r.sid === s)
    if (at >= 0) recipients.splice(at, 1)
    h.forgetRecipient(i + 1)
    h.remove(s)
    for (const m of held.values()) m.delete(s) // the roster's leave, as the client applies it
  }
  return { h, frames, held, followers, recipients, sid, say, tick, join, leave }
}

describe('the 40-cursor cap with a follow target (CR-3C-1, CONTRACTS_REV 10)', () => {
  it('100 sessions: the followed peer always arrives (outside the cap), and so does the list of followers', () => {
    const r = room(100)
    const leader = r.sid(99)
    // everyone moves, far from recipient 0's view; recipient 0 follows the leader, whose pointer is off the
    // canvas (null) and whose view is elsewhere: before, the first 40 pointers filled its set for good
    for (let i = 1; i < 99; i++) r.say(i, { pointer: { x: 10 * i, y: 10 } })
    r.say(99, { pointer: null, view: { x: 9_000, y: 9_000, w: 800, h: 600, z: 1.5 }, rich: true })
    r.say(0, { view: { x: 0, y: 0, w: 100, h: 100 }, f: leader })
    // 60 of the others follow the leader as well (a "Gather everyone")
    for (let i = 1; i <= 60; i++) r.say(i, { pointer: { x: 10 * i, y: 10 }, f: leader })
    r.tick()
    const zero = r.held.get(r.sid(0)) as Map<string, PeerPresence>
    expect(zero.has(leader)).toBe(true)
    expect(zero.get(leader)?.view).toEqual({ x: 9_000, y: 9_000, w: 800, h: 600, z: 1.5 })
    expect(zero.size).toBe(CURSORS_PER_RECIPIENT + 1) // 40 cursors and the followed peer
    // the leader holds 40 cursors (not the 61 followers'), and the whole sorted list of who follows it
    const lead = r.held.get(leader) as Map<string, PeerPresence>
    expect(lead.size).toBe(CURSORS_PER_RECIPIENT)
    const want = [0, ...Array.from({ length: 60 }, (_, i) => i + 1)].map(r.sid).sort()
    expect(r.followers.get(leader)).toEqual(want)
    // a rev-10 recipient sees whom the peers it holds follow
    expect(zero.get(r.sid(1))?.f).toBe(leader)
    // every frame of every recipient stays within the cap plus the followed peer
    for (const fs of r.frames.values())
      for (const f of fs) {
        const m = parsed(f)
        if (m.type === 'presence') expect(m.peers.length).toBeLessThanOrEqual(CURSORS_PER_RECIPIENT + 1)
      }
    // the leader moves its camera: the follower gets it on the next tick, though it is not a top-40 cursor
    r.say(99, { pointer: null, view: { x: 100, y: 100, w: 400, h: 300, z: 3 }, rich: true })
    r.tick()
    expect(zero.get(leader)?.view).toEqual({ x: 100, y: 100, w: 400, h: 300, z: 3 })
    // ten followers stop following: the leader's list shrinks, in one frame
    for (let i = 51; i <= 60; i++) r.say(i, { pointer: { x: 10 * i, y: 10 }, f: null })
    r.tick()
    expect(r.followers.get(leader)).toHaveLength(51)
    // recipient 0 stops following: the leader goes from what it holds (it was never a top-40 cursor)
    r.say(0, { view: { x: 0, y: 0, w: 100, h: 100 }, f: null })
    r.tick()
    expect(zero.has(leader)).toBe(false)
    expect(zero.size).toBe(CURSORS_PER_RECIPIENT)
  })

  it('100 sessions: the shown set re-ranks on a view change (in-view peers replace out-of-view ones through off)', () => {
    const r = room(100)
    // peers 1..99 on a row, x = 100 * i; recipient 0's view first covers peers 1..20
    for (let i = 1; i < 100; i++) r.say(i, { pointer: { x: 100 * i, y: 50 } })
    r.say(0, { view: { x: 50, y: 0, w: 2_000, h: 100 }, rich: true })
    r.tick()
    const zero = r.held.get(r.sid(0)) as Map<string, PeerPresence>
    expect(zero.size).toBe(CURSORS_PER_RECIPIENT)
    for (let i = 1; i <= 20; i++) expect(zero.has(r.sid(i))).toBe(true)
    // its camera moves over peers 70..99: they all arrive, and 30 out-of-view ones go through `off`
    r.say(0, { view: { x: 6_950, y: 0, w: 3_000, h: 100 }, rich: true })
    r.tick()
    const last = parsed((r.frames.get(r.sid(0)) as string[]).at(-1) as string)
    if (last.type !== 'presence') throw new Error('presence expected')
    expect(last.off).toHaveLength(30)
    expect(zero.size).toBe(CURSORS_PER_RECIPIENT)
    for (let i = 70; i < 100; i++) expect(zero.has(r.sid(i))).toBe(true)
    // nothing churns while nothing moves into the view
    const count = (r.frames.get(r.sid(0)) as string[]).length
    r.say(5, { pointer: { x: 501, y: 50 } })
    r.tick()
    const quiet = parsed((r.frames.get(r.sid(0)) as string[]).at(-1) as string)
    if (quiet.type !== 'presence') throw new Error('presence expected')
    expect((r.frames.get(r.sid(0)) as string[]).length).toBeLessThanOrEqual(count + 1)
    expect(quiet.off ?? []).toEqual([])
    // a newcomer moving into the view replaces an out-of-view cursor, never an in-view one
    const before = new Set(zero.keys())
    const newcomer = [...Array(100).keys()].slice(1, 70).find((i) => !before.has(r.sid(i))) as number
    r.say(newcomer, { pointer: { x: 7_000, y: 60 } })
    r.tick()
    expect(zero.has(r.sid(newcomer))).toBe(true)
    for (let i = 70; i < 100; i++) expect(zero.has(r.sid(i))).toBe(true)
    expect(zero.size).toBe(CURSORS_PER_RECIPIENT)
  })

  it('a late joiner starts with at most 40, and a leaver frees its slot without an `off`', () => {
    const r = room(60)
    for (let i = 0; i < 60; i++) r.say(i, { pointer: { x: i, y: i } })
    r.tick()
    const late = r.join(60)
    const first = r.h.welcomeFrame(61, r.sid(60))
    expect(first).not.toBeNull()
    late(first as string)
    expect(r.held.get(r.sid(60))?.size).toBe(CURSORS_PER_RECIPIENT)
    r.say(60, { view: { x: 0, y: 0, w: 10_000, h: 10_000 } })
    r.tick()
    const lateHeld = r.held.get(r.sid(60)) as Map<string, PeerPresence>
    const someone = [...lateHeld.keys()][0] as string
    r.leave(Number(someone.slice(1, 4)))
    r.tick()
    expect(lateHeld.has(someone)).toBe(false)
    expect(lateHeld.size).toBe(CURSORS_PER_RECIPIENT)
    const frames = (r.frames.get(r.sid(60)) as string[]).map(parsed)
    expect(frames.flatMap((m) => (m.type === 'presence' ? (m.off ?? []) : []))).not.toContain(someone)
  })

  it('a rev-9 recipient (it never sends `f`) only gets frames a rev-9 client parses, capped as before', () => {
    const r = room(50)
    for (let i = 1; i < 50; i++)
      r.say(i, { pointer: { x: i, y: i }, view: { x: 0, y: 0, w: 10, h: 10, z: 2 }, f: r.sid(0) })
    r.say(0, { view: { x: 0, y: 0, w: 1_000, h: 1_000 } }) // a rev-9 client: no `f` key
    r.tick()
    for (let i = 1; i < 50; i++)
      r.say(i, { pointer: { x: i + 1, y: i }, view: { x: 0, y: 0, w: 10, h: 10, z: 2 }, f: r.sid(0) })
    r.tick()
    const zero = r.frames.get(r.sid(0)) as string[]
    expect(zero.length).toBeGreaterThan(0)
    for (const f of zero) {
      const ok = PresenceOut9.safeParse(JSON.parse(f))
      expect(ok.success, f.slice(0, 200)).toBe(true)
    }
    expect(r.followers.get(r.sid(0))).toBeUndefined()
    expect(r.held.get(r.sid(0))?.size).toBe(CURSORS_PER_RECIPIENT)
    // the rev-10 recipients of the same ticks got the rich entries
    const one = r.held.get(r.sid(1)) as Map<string, PeerPresence>
    const peer = [...one.values()].find((p) => p.sid !== r.sid(0))
    expect(peer?.f).toBe(r.sid(0))
    expect(peer?.view?.z).toBe(2)
  })

  it('a socket that becomes rev 10 gets what it holds again, with `f` and `view.z`, and its followers', () => {
    const r = room(5)
    r.say(1, { view: { x: 0, y: 0, w: 10, h: 10, z: 0.5 }, f: r.sid(0) })
    r.say(0, {})
    r.tick()
    const zero = r.held.get(r.sid(0)) as Map<string, PeerPresence>
    expect(zero.get(r.sid(1))?.view).toEqual({ x: 0, y: 0, w: 10, h: 10 }) // rev-9 form
    expect(zero.get(r.sid(1))?.f).toBeUndefined()
    // its first message with `f` (the room's contracts frame reached it): everything again, rich
    r.say(0, { rich: true })
    r.tick()
    expect(zero.get(r.sid(1))?.view).toEqual({ x: 0, y: 0, w: 10, h: 10, z: 0.5 })
    expect(zero.get(r.sid(1))?.f).toBe(r.sid(0))
    expect(r.followers.get(r.sid(0))).toEqual([r.sid(1)])
    // the shared frame of a small board still serves every recipient of one form alike
    r.say(2, { pointer: { x: 9, y: 9 } })
    r.tick()
    const f3 = (r.frames.get(r.sid(3)) as string[]).at(-1)
    const f4 = (r.frames.get(r.sid(4)) as string[]).at(-1)
    expect(f3).toBe(f4)
  })

  it('a room that drops back to 41 sessions sends each recipient the peers it was not getting', () => {
    const r = room(50)
    for (let i = 0; i < 50; i++) r.say(i, { pointer: { x: i, y: i } })
    r.tick()
    expect(r.held.get(r.sid(0))?.size).toBe(CURSORS_PER_RECIPIENT)
    // nine of the peers it holds leave (it held 1..40): it must now get 41..49, which never moved since
    for (let i = 1; i <= 9; i++) r.leave(i)
    r.tick()
    expect([...(r.held.get(r.sid(0)) as Map<string, PeerPresence>).keys()].sort()).toEqual(
      Array.from({ length: 40 }, (_, i) => r.sid(i + 10)),
    )
  })

  it('200 sessions, everyone moving and every view panning: all ranked each tick, a tick stays cheap', () => {
    const r = room(200)
    const at = (i: number, round: number) => ({ x: (i * 37 + round * 11) % 2_000, y: (i * 53) % 2_000 })
    for (let i = 0; i < 200; i++)
      r.say(i, { pointer: at(i, 0), view: { x: 0, y: 0, w: 1_000, h: 1_000 }, rich: true })
    r.tick()
    const t0 = performance.now()
    const ranks0 = r.h.rankCalls
    for (let round = 1; round <= 10; round++) {
      for (let i = 0; i < 200; i++)
        r.say(i, { pointer: at(i, round), view: { x: round * 50, y: 0, w: 1_000, h: 1_000 }, rich: true })
      r.tick()
    }
    const perTick = (performance.now() - t0) / 10
    // every view moved, so every recipient is ranked (D1 ranks only when the set can change: here it can),
    // with one bucket per tick for the one view they share; bounded loosely so a slow box does not flake
    expect(r.h.rankCalls - ranks0).toBe(200 * 10)
    expect(perTick).toBeLessThan(100)
    for (const m of r.held.values()) expect(m.size).toBeLessThanOrEqual(CURSORS_PER_RECIPIENT)
  })

  it('200 sessions, everyone moving inside still views: nobody ranked but the backstop (D1)', () => {
    const r = room(200)
    const at = (i: number, round: number) => ({
      x: 100 + ((i * 37 + round * 11) % 800),
      y: 100 + ((i * 53) % 800),
    })
    for (let i = 0; i < 200; i++)
      r.say(i, { pointer: at(i, 0), view: { x: 0, y: 0, w: 1_000, h: 1_000 }, rich: true })
    r.tick() // every recipient ranked once: none was yet
    const ranks0 = r.h.rankCalls
    for (let round = 1; round <= 50; round++) {
      for (let i = 0; i < 200; i++)
        r.say(i, { pointer: at(i, round), view: { x: 0, y: 0, w: 1_000, h: 1_000 }, rich: true })
      r.tick()
    }
    // CR-3C-1 ranked 200 x 50 here; the backstop ranks each recipient once in RERANK_EVERY_TICKS ticks
    expect(r.h.rankCalls - ranks0).toBe((200 * 50) / RERANK_EVERY_TICKS)
    // and every recipient holds 40 cursors
    for (const m of r.held.values()) expect(m.size).toBe(CURSORS_PER_RECIPIENT)
  })
})
