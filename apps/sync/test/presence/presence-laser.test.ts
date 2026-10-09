// L6-1 (wave L, CONTRACTS_REV 12): the room relays the shared laser (presence.ts).
//
//  1. The relay itself (PresenceHub on a fake clock): `t` and `trail` go only to sockets that have sent `t`
//     (rev-12 readers); a rev-10/11 socket gets entries its strict rev-11 parse accepts and a rev-9 one its
//     rev-9 parse; a trail over MAX_LASER_TRAIL_POINTS, or one sent without `t: 'laser'`, is dropped and the
//     rest of the message kept; two messages in one tick give one trail (their samples and the first one's
//     pointer, thinned to at most 6, oldest first) and a trail goes out once; a viewer's laser is relayed;
//     during an anonymous vote the button is still 'up' while `t` is relayed; the 20 Hz input cap and the
//     100 ms tick are unchanged.
//  2. Through the real server process: a viewer's laser reaches a rev-12 editor and never a rev-11 tab, and
//     the anonymous vote keeps its masking.

import { PRESENCE_IN_HZ } from '@draftroom/canvas-schema/limits'
import {
  MAX_LASER_TRAIL_POINTS,
  type PeerPresence,
  type PresenceIn,
  ServerMessage,
} from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PresenceHub, type PresenceRecipient, thinTrail } from '../../src/room/presence.ts'
import type { RawClient } from '../element-room/support/client.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { callInternal } from '../harness/tickets.ts'

// ---- the strict schemas of the older readers ----------------------------------------------------------

const Rect = z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const Base = {
  sid: z.string(),
  pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  button: z.enum(['up', 'down']),
  sel: z.unknown(),
  idle: z.boolean(),
  editing: z.string().nullable(),
}
/** Rev 11's (and rev 10's) entry: `f` and `view.z`, no laser. */
const Peer11 = z.strictObject({
  ...Base,
  view: Rect.extend({ z: z.number().positive().optional() }).nullable(),
  f: z.string().nullable().optional(),
})
/** Rev 9's entry: no `f`, no `view.z`. */
const Peer9 = z.strictObject({ ...Base, view: Rect.nullable() })

// ---- a hub on a fake clock ----------------------------------------------------------------------------------

interface Sock {
  readonly sid: string
  readonly key: number
  readonly frames: string[]
}

function room() {
  let now = 10_000
  const hub = new PresenceHub(() => now)
  const socks: Sock[] = []
  let nextKey = 1
  const join = (name: string): Sock => {
    const s = { sid: `${name}:tab`, key: nextKey++, frames: [] as string[] }
    socks.push(s)
    hub.welcomeFrame(s.key, s.sid)
    return s
  }
  const recipients = (): PresenceRecipient[] =>
    socks.map((s) => ({ sid: s.sid, key: s.key, congested: false, send: (f: string) => s.frames.push(f) }))
  const tick = () => {
    now += 100
    hub.tick(recipients())
  }
  const advance = (ms: number) => {
    now += ms
  }
  return { hub, join, tick, advance, socks }
}

type Rev = 9 | 10 | 12
interface Say {
  rev: Rev
  pointer?: { x: number; y: number } | null
  laser?: boolean
  trail?: { x: number; y: number }[]
  view?: { x: number; y: number; w: number; h: number; z?: number } | null
  readonly?: boolean
  vote?: boolean | { voteOpen: boolean; anonymous: boolean }
  /** force a `t` value (a rev-12 sender always sends one) */
  t?: 'laser' | null
}
/** What a client of revision `rev` sends (rev 12: `f` and `t` in every message, `trail` with the laser). */
function say(r: ReturnType<typeof room>, s: Sock, o: Say): boolean {
  const msg: Record<string, unknown> = {
    type: 'presence',
    pointer: o.pointer === undefined ? { x: 1, y: 1 } : o.pointer,
    button: o.laser ? 'down' : 'up',
    sel: [],
    view: o.view ?? null,
    idle: false,
    editing: null,
  }
  if (o.rev >= 10) msg.f = null
  if (o.rev >= 12) msg.t = o.t !== undefined ? o.t : o.laser ? 'laser' : null
  if (o.trail) msg.trail = o.trail
  return r.hub.input(s.sid, o.readonly ?? false, msg as PresenceIn, o.vote ?? false, s.key)
}

/** Every entry `s` was sent for the peer `of`, parsed (the frames parse with the current schema too). */
function entriesFor(s: Sock, of: Sock): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const f of s.frames) {
    const m = JSON.parse(f) as { type: string; peers: Record<string, unknown>[] }
    expect(ServerMessage.safeParse(m).success, f).toBe(true)
    if (m.type !== 'presence') continue
    for (const p of m.peers) if (p.sid === of.sid) out.push(p)
  }
  return out
}

const line = (n: number, x0 = 0) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * 10, y: 5 }))

describe('L6-1: the laser relay (PresenceHub)', () => {
  it('relays t and trail only to sockets that sent t; rev-10/11 and rev-9 sockets get entries their strict parse accepts', () => {
    const r = room()
    const laser = r.join('laser')
    const r12 = r.join('rev12')
    const r11 = r.join('rev11')
    const r9 = r.join('rev9')
    // each says what it reads (a rev-9 tab says nothing new)
    say(r, r12, { rev: 12 })
    say(r, r11, { rev: 10 })
    say(r, r9, { rev: 9 })
    r.tick()
    for (const s of r.socks) s.frames.length = 0
    expect(
      say(r, laser, {
        rev: 12,
        laser: true,
        pointer: { x: 140, y: 5 },
        trail: line(4, 100),
        view: { x: 0, y: 0, w: 800, h: 600, z: 1.5 },
      }),
    ).toBe(true)
    r.tick()
    const [to12] = entriesFor(r12, laser)
    expect(to12).toMatchObject({ t: 'laser', pointer: { x: 140, y: 5 }, trail: line(4, 100) })
    expect((to12?.view as { z?: number } | undefined)?.z).toBe(1.5)
    const [to11] = entriesFor(r11, laser)
    expect(to11).not.toHaveProperty('t')
    expect(to11).not.toHaveProperty('trail')
    expect(Peer11.safeParse(to11).success, JSON.stringify(to11)).toBe(true)
    expect((to11?.view as { z?: number } | undefined)?.z).toBe(1.5) // a rev-10/11 reader keeps the zoom
    const [to9] = entriesFor(r9, laser)
    expect(Peer9.safeParse(to9).success, JSON.stringify(to9)).toBe(true)
    // the sender gets no entry of its own
    expect(entriesFor(laser, laser)).toEqual([])
    expect(r.hub.laserIn).toBe(1)
  })

  it('a trail over MAX_LASER_TRAIL_POINTS, or one without t: laser, is dropped; the rest of the message is kept', () => {
    const r = room()
    const laser = r.join('laser')
    const watch = r.join('watch')
    say(r, watch, { rev: 12 })
    r.tick()
    watch.frames.length = 0
    // 7 points: the trail goes, the pointer and the laser stay
    say(r, laser, {
      rev: 12,
      laser: true,
      pointer: { x: 77, y: 7 },
      trail: line(MAX_LASER_TRAIL_POINTS + 1),
    })
    r.tick()
    let seen = entriesFor(watch, laser).at(-1)
    expect(seen).toMatchObject({ pointer: { x: 77, y: 7 }, button: 'down', t: 'laser' })
    expect(seen).not.toHaveProperty('trail')
    expect(r.hub.droppedTrails).toBe(1)
    // a trail with the laser released (t: null): dropped, and no t
    r.advance(100)
    say(r, laser, { rev: 12, t: null, pointer: { x: 88, y: 8 }, trail: line(3) })
    r.tick()
    seen = entriesFor(watch, laser).at(-1)
    expect(seen).toMatchObject({ pointer: { x: 88, y: 8 }, button: 'up' })
    expect(seen).not.toHaveProperty('t')
    expect(seen).not.toHaveProperty('trail')
    expect(r.hub.droppedTrails).toBe(2)
    // exactly MAX_LASER_TRAIL_POINTS is kept
    r.advance(100)
    say(r, laser, { rev: 12, laser: true, pointer: { x: 99, y: 9 }, trail: line(MAX_LASER_TRAIL_POINTS) })
    r.tick()
    expect(entriesFor(watch, laser).at(-1)?.trail).toEqual(line(MAX_LASER_TRAIL_POINTS))
    expect(r.hub.droppedTrails).toBe(2)
  })

  it('two messages in one tick give one trail (the first pointer included, thinned to 6, oldest first); a trail goes out once', () => {
    const r = room()
    const laser = r.join('laser')
    const watch = r.join('watch')
    say(r, watch, { rev: 12 })
    r.tick()
    watch.frames.length = 0
    say(r, laser, { rev: 12, laser: true, pointer: { x: 50, y: 5 }, trail: line(5, 0) }) // 0..40, then 50
    r.advance(50)
    say(r, laser, { rev: 12, laser: true, pointer: { x: 110, y: 5 }, trail: line(5, 60) }) // 60..100, then 110
    r.tick()
    const e = entriesFor(watch, laser)
    expect(e).toHaveLength(1)
    const trail = e[0]?.trail as { x: number; y: number }[]
    expect(trail.length).toBe(MAX_LASER_TRAIL_POINTS)
    // the first sample and the last sample before the entry's pointer are kept, in order
    expect(trail[0]).toEqual({ x: 0, y: 5 })
    expect(trail.at(-1)).toEqual({ x: 100, y: 5 })
    expect(trail.map((p) => p.x)).toEqual([...trail.map((p) => p.x)].sort((a, b) => a - b))
    expect(e[0]?.pointer).toEqual({ x: 110, y: 5 })
    // the samples between the two messages include the first one's pointer (thinned evenly from 11 to 6)
    expect(thinTrail([...line(5, 0), { x: 50, y: 5 }, ...line(5, 60)], 6)).toEqual(trail)
    // a newcomer that becomes a rev-12 reader gets the laser held down (t) but not the trail it was sent
    const late = r.join('late')
    say(r, late, { rev: 12 })
    r.tick()
    const toLate = entriesFor(late, laser).at(-1)
    expect(toLate).toMatchObject({ t: 'laser', pointer: { x: 110, y: 5 } })
    expect(toLate).not.toHaveProperty('trail')
    // the watcher is not sent the same trail again on the next tick
    watch.frames.length = 0
    r.tick()
    for (const p of entriesFor(watch, laser)) expect(p).not.toHaveProperty('trail')
  })

  it('a socket that starts sending t gets what it holds again, with the laser of whoever has it down', () => {
    const r = room()
    const laser = r.join('laser')
    const tab = r.join('tab')
    say(r, tab, { rev: 10 }) // rich, not a laser reader yet
    say(r, laser, { rev: 12, laser: true, pointer: { x: 5, y: 5 } })
    r.tick()
    expect(entriesFor(tab, laser).at(-1)).not.toHaveProperty('t')
    tab.frames.length = 0
    // the room's contracts frame came: from now on the tab sends t (null) in every message
    say(r, tab, { rev: 12 })
    r.tick()
    expect(entriesFor(tab, laser).at(-1)).toMatchObject({ t: 'laser', pointer: { x: 5, y: 5 } })
  })

  it("a viewer's laser is relayed (a read-only session points; only its drag is dropped)", () => {
    const r = room()
    const viewer = r.join('viewer')
    const ed = r.join('editor')
    say(r, ed, { rev: 12 })
    say(r, viewer, { rev: 12, readonly: true, laser: true, pointer: { x: 30, y: 3 }, trail: line(3) })
    r.tick()
    expect(entriesFor(ed, viewer).at(-1)).toMatchObject({ t: 'laser', trail: line(3), button: 'down' })
  })

  it('during an anonymous vote the button is still relayed as up, and t with its trail is relayed', () => {
    const r = room()
    const laser = r.join('laser')
    const watch = r.join('watch')
    say(r, watch, { rev: 12 })
    const vote = { voteOpen: true, anonymous: true }
    say(r, laser, { rev: 12, laser: true, pointer: { x: 9, y: 9 }, trail: line(2), vote })
    r.tick()
    const seen = entriesFor(watch, laser).at(-1)
    expect(seen).toMatchObject({ button: 'up', sel: null, t: 'laser', trail: line(2) })
    // a press with another tool (no t) during the vote: up, as before
    r.advance(100)
    say(r, laser, { rev: 12, laser: false, t: null, pointer: { x: 10, y: 9 }, vote })
    r.tick()
    const plain = entriesFor(watch, laser).at(-1)
    expect(plain).toMatchObject({ button: 'up', sel: null })
    expect(plain).not.toHaveProperty('t')
  })

  it('the input cap is unchanged: 20 messages a second, a laser message counted like any other', () => {
    expect(PRESENCE_IN_HZ).toBe(20)
    const r = room()
    const laser = r.join('laser')
    const watch = r.join('watch')
    say(r, watch, { rev: 12 })
    let taken = 0
    for (let i = 0; i < 30; i++)
      if (say(r, laser, { rev: 12, laser: true, pointer: { x: i, y: 0 }, trail: line(2, i) })) taken++
    // a full bucket (20) and nothing more at the same instant
    expect(taken).toBe(PRESENCE_IN_HZ)
    r.advance(1000)
    let later = 0
    for (let i = 0; i < 30; i++) if (say(r, laser, { rev: 12, laser: true, pointer: { x: i, y: 1 } })) later++
    expect(later).toBe(PRESENCE_IN_HZ)
    // however many samples arrived, an entry carries at most MAX_LASER_TRAIL_POINTS of them
    r.tick()
    for (const p of entriesFor(watch, laser))
      expect(((p.trail as unknown[]) ?? []).length).toBeLessThanOrEqual(MAX_LASER_TRAIL_POINTS)
  })

  it('a released laser: the next entry has no t (a rev-12 reader stops drawing it)', () => {
    const r = room()
    const laser = r.join('laser')
    const watch = r.join('watch')
    say(r, watch, { rev: 12 })
    say(r, laser, { rev: 12, laser: true, pointer: { x: 1, y: 1 }, trail: line(2) })
    r.tick()
    r.advance(100)
    say(r, laser, { rev: 12, laser: false, pointer: { x: 2, y: 1 } })
    r.tick()
    const e = entriesFor(watch, laser)
    expect(e.at(-2)).toMatchObject({ t: 'laser' })
    expect(e.at(-1)).not.toHaveProperty('t')
    expect(e.at(-1)).not.toHaveProperty('trail')
  })

  it('thinTrail keeps the first and the last point and the order; short trails are the same array', () => {
    const pts = line(13)
    const out = thinTrail(pts, 6)
    expect(out).toHaveLength(6)
    expect(out[0]).toEqual(pts[0])
    expect(out.at(-1)).toEqual(pts.at(-1))
    const short = line(4)
    expect(thinTrail(short, 6)).toBe(short)
    expect(thinTrail(pts, 1)).toEqual([pts.at(-1)])
  })
})

// ---- through the real server ----------------------------------------------------------------------------------

const h = useElementHarness()
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
const sidOf = (c: RawClient) => c.welcome?.sid as string

function send(c: RawClient, o: Say) {
  c.send({
    type: 'presence',
    pointer: o.pointer === undefined ? { x: 1, y: 1 } : o.pointer,
    button: o.laser ? 'down' : 'up',
    sel: [],
    view: o.view ?? null,
    idle: false,
    editing: null,
    ...(o.rev >= 10 ? { f: null } : {}),
    ...(o.rev >= 12 ? { t: o.laser ? 'laser' : null } : {}),
    ...(o.trail ? { trail: o.trail } : {}),
  })
}
const peersOf = (c: RawClient, of: RawClient): PeerPresence[] =>
  c
    .of('presence')
    .flatMap((f) => f.peers)
    .filter((p) => p.sid === sidOf(of))

describe('L6-1 through the room', () => {
  it("a viewer's laser reaches a rev-12 editor with its trail, and a rev-11 tab only as a cursor", async () => {
    const st = await h.stack()
    const b = newBoardId()
    const viewer = await st.client({ boardId: b, user: 'client-viewer', role: 'viewer' })
    const ed = await st.client({ boardId: b, user: 'ed12' })
    const old = await st.client({ boardId: b, user: 'old11' })
    send(ed, { rev: 12 })
    send(old, { rev: 10 })
    await sleep(150)
    for (let i = 0; i < 5; i++) {
      send(viewer, { rev: 12, laser: true, pointer: { x: 100 + i * 30, y: 50 }, trail: line(3, 70 + i * 30) })
      await sleep(60)
    }
    send(viewer, { rev: 12, laser: false, pointer: { x: 300, y: 50 } })
    await ed.until(() => peersOf(ed, viewer).some((p) => p.pointer?.x === 300), 'the release')
    const toEd = peersOf(ed, viewer)
    expect(toEd.some((p) => p.t === 'laser' && (p.trail?.length ?? 0) > 0)).toBe(true)
    expect(toEd.at(-1)).not.toHaveProperty('t')
    await old.until(() => peersOf(old, viewer).some((p) => p.pointer?.x === 300), 'the release (rev 11)')
    for (const p of peersOf(old, viewer)) {
      expect(p).not.toHaveProperty('t')
      expect(p).not.toHaveProperty('trail')
      expect(Peer11.safeParse(p).success).toBe(true)
    }
    for (const c of [viewer, ed, old]) {
      expect(c.closeCode).toBeNull()
      expect(c.schemaErrors).toEqual([])
    }
  })

  it('an anonymous vote still relays the button as up; the laser (t) is relayed', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const laser = await st.client({ boardId: b, user: 'pointer' })
    const watch = await st.client({ boardId: b, user: 'watcher' })
    send(watch, { rev: 12 })
    const res = await callInternal(st.server.url, 'POST', `/internal/boards/${b}/workshop-state`, {
      body: { voteOpen: true, anonymous: true },
    })
    expect(res.status).toBe(204)
    await laser.until(() => laser.of('workshop').some((w) => w.voteOpen), 'the vote')
    send(laser, { rev: 12, laser: true, pointer: { x: 42, y: 4 }, trail: line(2) })
    await watch.until(() => peersOf(watch, laser).some((p) => p.pointer?.x === 42), 'the laser')
    const p = peersOf(watch, laser).find((x) => x.pointer?.x === 42)
    expect(p).toMatchObject({ button: 'up', sel: null, t: 'laser' })
  })
})
