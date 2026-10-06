// D1 (wave D, PRES-RANK): the room's presence relay ranks a recipient's 40-cursor set again only when the
// set can change, sharing each view's sorted peers between the recipients with that view; CR-3C-1's relay
// (wave A, `reference-hub.ts`, verbatim) ranked every recipient on every tick.
//
//  1. The differential test: both relays get the same inputs on the same clock (joins and leaves across
//     the 41-session line, pointers moving, leaving the view and going away, views panning, follows,
//     rev-9 and rev-10 sockets, congested ticks, drags) and every recipient's frame of every tick is the
//     same, up to the order of the entries in it: the same peers, the same `off`, drags and followers.
//  2. The bounds: on a 200-session board ranks per tick stay a small fraction of the recipients (CR-3C-1:
//     every recipient, every tick), with one bucket per distinct view.

import { CURSORS_PER_RECIPIENT } from '@draftroom/canvas-schema/limits'
import type { PresenceIn } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { PresenceHub, type PresenceRecipient, RERANK_EVERY_TICKS } from '../../src/room/presence.ts'
import { ReferencePresenceHub } from './reference-hub.ts'

/** mulberry32: a small seeded generator, so a failure replays */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Hub = PresenceHub | ReferencePresenceHub
type View = { x: number; y: number; w: number; h: number; z?: number }

interface Sess {
  readonly i: number
  readonly sid: string
  key: number
  /** a rev-10 socket (sends `f`) */
  readonly rich: boolean
  pointer: { x: number; y: number } | null
  view: View | null
  f: string | null
  d: number
  dragging: boolean
}

/** A frame without the order of its entries: what a client does with it is the same. */
function normal(frame: string): string {
  const m = JSON.parse(frame) as {
    peers: { sid: string }[]
    off?: string[]
    drags?: unknown[]
    followers?: string[]
  }
  return JSON.stringify({
    peers: m.peers.map((p) => JSON.stringify(p)).sort(),
    off: [...(m.off ?? [])].sort(),
    drags: m.drags ?? null,
    followers: m.followers ?? null,
  })
}

/**
 * Two rooms, the relay and the oracle, driven alike. `tick()` returns, per socket key, its normalized frames
 * of that tick from each relay.
 */
function pair() {
  let now = 1_000
  const clock = () => now
  const hubs: Hub[] = [new PresenceHub(clock), new ReferencePresenceHub(clock)]
  const live = new Map<string, Sess>()
  let nextKey = 1
  const congested = new Set<number>()
  const input = (s: Sess, extra: Partial<PresenceIn> = {}) => {
    const msg = {
      type: 'presence',
      pointer: s.pointer,
      button: 'up',
      sel: [],
      view: s.view,
      idle: s.pointer === null,
      editing: null,
      ...(s.rich ? { f: s.f } : {}),
      ...extra,
    } as PresenceIn
    const oks = hubs.map((h) => h.input(s.sid, false, msg, false, s.key))
    expect(oks[0]).toBe(oks[1])
  }
  const welcome = (s: Sess) => {
    const w = hubs.map((h) => h.welcomeFrame(s.key, s.sid))
    expect(w[0] === null ? null : normal(w[0] as string)).toBe(w[1] === null ? null : normal(w[1] as string))
  }
  const join = (i: number, rich: boolean): Sess => {
    const s: Sess = {
      i,
      sid: `u${String(i).padStart(3, '0')}:t`,
      key: nextKey++,
      rich,
      pointer: null,
      view: null,
      f: null,
      d: 0,
      dragging: false,
    }
    live.set(s.sid, s)
    welcome(s)
    return s
  }
  const leave = (s: Sess) => {
    live.delete(s.sid)
    for (const h of hubs) {
      h.forgetRecipient(s.key)
      h.remove(s.sid)
    }
  }
  /** a replaced socket: the same session, a new handle and a new welcome (it starts over as rev 9) */
  const reconnect = (s: Sess) => {
    for (const h of hubs) h.forgetRecipient(s.key)
    s.key = nextKey++
    welcome(s)
  }
  const tick = (): [Map<number, string[]>, Map<number, string[]>] => {
    now += 100
    const out: [Map<number, string[]>, Map<number, string[]>] = [new Map(), new Map()]
    hubs.forEach((h, n) => {
      const rs: PresenceRecipient[] = [...live.values()].map((s) => ({
        sid: s.sid,
        key: s.key,
        congested: congested.has(s.key),
        send: (f: string) => {
          const mine = out[n] as Map<number, string[]>
          const list = mine.get(s.key) ?? []
          list.push(normal(f))
          mine.set(s.key, list)
        },
      }))
      h.tick(rs)
    })
    return out
  }
  return { hubs, live, join, leave, reconnect, input, tick, congested, clock: () => now }
}

/** One random run; returns the number of ticks compared and how many recipients' frames were compared. */
function randomRun(seed: number, opts: { ticks: number; lo: number; hi: number; area: number }) {
  const rand = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
  const r = pair()
  let next = 0
  // sessions that left: one may come back under the same sid (a new peer, the old one forgotten)
  const gone: number[] = []
  const target = () => opts.lo + Math.floor(rand() * (opts.hi - opts.lo + 1))
  let want = target()
  const views: View[] = [
    { x: 0, y: 0, w: opts.area, h: opts.area },
    { x: 0, y: 0, w: opts.area / 2, h: opts.area / 2 },
    { x: opts.area / 2, y: opts.area / 2, w: opts.area / 3, h: opts.area / 3, z: 2 },
  ]
  const point = () => ({ x: Math.round(rand() * opts.area * 1.2), y: Math.round(rand() * opts.area * 1.2) })
  let compared = 0
  for (let t = 0; t < opts.ticks; t++) {
    if (t % 80 === 0) want = target()
    // joins and leaves toward the target (crossing 41 now and then)
    const n = r.live.size
    if (n < want || (n === want && rand() < 0.05)) {
      for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
        const back = gone.length > 0 && rand() < 0.3
        const i = back ? (gone.splice(Math.floor(rand() * gone.length), 1)[0] as number) : next++
        const s = r.join(i, rand() < 0.6)
        s.view = rand() < 0.1 ? null : pick(views)
        s.pointer = rand() < 0.2 ? null : point()
        r.input(s)
      }
    } else if (n > want || rand() < 0.05) {
      for (let k = 0; k < 1 + Math.floor(rand() * 3) && r.live.size; k++) {
        const s = pick([...r.live.values()])
        r.leave(s)
        gone.push(s.i)
      }
    }
    const all = [...r.live.values()]
    if (all.length && rand() < 0.03) r.reconnect(pick(all))
    r.congested.clear()
    for (const s of all) if (rand() < 0.03) r.congested.add(s.key)
    for (const s of all) {
      const u = rand()
      if (u < 0.45) {
        // a move: mostly small, sometimes far (out of a view, into another), sometimes away
        if (s.pointer && rand() < 0.85)
          s.pointer = {
            x: s.pointer.x + Math.round((rand() - 0.5) * opts.area * 0.1),
            y: s.pointer.y + Math.round((rand() - 0.5) * opts.area * 0.1),
          }
        else s.pointer = rand() < 0.3 ? null : point()
      } else if (u < 0.5) {
        // a pan, a jump to another view, or no view
        const v = s.view
        s.view =
          v && rand() < 0.6
            ? { ...v, x: v.x + Math.round((rand() - 0.5) * 200), y: v.y + Math.round((rand() - 0.5) * 200) }
            : rand() < 0.15
              ? null
              : pick(views)
      } else if (u < 0.53 && s.rich) {
        // follow someone (now and then a session that is not there, or nobody)
        const others = all.filter((o) => o !== s)
        s.f = rand() < 0.3 || !others.length ? null : rand() < 0.1 ? 'nobody:t' : pick(others).sid
      } else if (u < 0.55) {
        // a drag (one at a time per session; its relay is outside the cap)
        if (!s.dragging) {
          s.dragging = true
          s.d++
          r.input(s, { drag: { d: s.d, ids: ['a', 'b'], dx: 0, dy: 0 } })
          continue
        }
        s.dragging = false
        r.input(s, { drag: null })
        continue
      } else continue
      r.input(s)
    }
    const [mine, ref] = r.tick()
    for (const s of r.live.values()) {
      expect(mine.get(s.key) ?? [], `seed ${seed} tick ${t} recipient ${s.sid}`).toEqual(ref.get(s.key) ?? [])
      compared++
    }
    expect([...mine.keys()].sort()).toEqual([...ref.keys()].sort())
  }
  return { compared, hub: r.hubs[0] as PresenceHub }
}

describe('the 40-cursor rank (D1): the same frames as CR-3C-1, ranking only when the set can change', () => {
  it('random rooms around the 41-session line: every frame the same as the oracle', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { compared } = randomRun(seed, { ticks: 400, lo: 30, hi: 60, area: 2_000 })
      expect(compared).toBeGreaterThan(400 * 25)
    }
  })

  it('random rooms of 80 to 140 sessions (always capped): the same frames, and fewer ranks', () => {
    for (const seed of [11, 12, 13]) {
      const { compared, hub } = randomRun(seed, { ticks: 400, lo: 80, hi: 140, area: 3_000 })
      expect(compared).toBeGreaterThan(400 * 70)
      // CR-3C-1 ranked every recipient every tick; with this much moving the relay still ranks fewer
      expect(hub.rankCalls).toBeLessThan(compared)
    }
  })

  it('crowded views (everyone in view, cursors going away and coming back): the same frames', () => {
    for (const seed of [21, 22]) randomRun(seed, { ticks: 300, lo: 90, hi: 110, area: 400 })
  })

  it('PRES-2: the random rooms share ranks (and still give the same frames)', () => {
    const { hub } = randomRun(31, { ticks: 300, lo: 80, hi: 140, area: 3_000 })
    expect(hub.rankShares).toBeGreaterThan(0)
    expect(hub.rankShares).toBeLessThan(hub.rankCalls)
  })

  it('PRES-2: a join storm (a restart: welcomes back to back, then everyone moving) gives the same frames; the joiners share ranks', () => {
    const r = pair()
    const view = { x: 0, y: 0, w: 1_920, h: 1_080 }
    const all: Sess[] = []
    // 100 sessions on the board (each says where it is), then 100 more join back to back: their welcomes
    // see the same 100 peers and hold nothing yet
    for (let i = 0; i < 100; i++) {
      const s = r.join(i, i % 2 === 0)
      s.view = view
      s.pointer = { x: (i * 37) % 1_900, y: (i * 53) % 1_000 }
      r.input(s)
      all.push(s)
    }
    r.tick()
    const shares0 = (r.hubs[0] as PresenceHub).rankShares
    for (let i = 100; i < 200; i++) all.push(r.join(i, i % 3 === 0))
    // most of the 100 welcomes share the first one's rank: those the first one took cannot have it
    expect((r.hubs[0] as PresenceHub).rankShares - shares0).toBeGreaterThan(50)
    for (let t = 0; t < 60; t++) {
      for (const s of all) {
        s.view = view
        s.pointer = (t + s.i) % 17 === 0 ? null : { x: (s.i * 37 + t * 7) % 1_900, y: (s.i * 53) % 1_000 }
        r.input(s)
      }
      const [mine, ref] = r.tick()
      for (const s of all) expect(mine.get(s.key) ?? [], `tick ${t} ${s.sid}`).toEqual(ref.get(s.key) ?? [])
    }
    expect((r.hubs[0] as PresenceHub).rankShares).toBeGreaterThan(shares0 + 50)
  })
})

// ---- a 200-session board: L1's ---------------------------------------------------------------------------

/**
 * L1's board in miniature (e2e/load/profiles.ts): 195 sessions look at the same 1920 x 1080 view and 5 at
 * the presence probe's region (the probe and 4 measuring viewers); 159 watchers (the 4 measuring viewers
 * among them: their pointers are where everyone's are) move for 5 s and go away (pointer null) for 5 s,
 * staggered; 40 editors' pointers stay on the board and move now and then; the probe moves all the time.
 * Every hub given gets the same inputs; `step()` returns, per hub, each socket's frames of the tick, and
 * the sids that went away in it.
 */
function l1Board(hubs: Hub[], opts: { watchersGoAway: boolean }) {
  let now = 1_000
  const main = { x: 0, y: 0, w: 1_920, h: 1_080 }
  const probe = { x: 50_000, y: 50_000, w: 1_000, h: 1_000 }
  type S = { sid: string; key: number; kind: 'editor' | 'watcher' | 'probe' | 'measure'; phase: number }
  const ss: S[] = []
  for (let i = 0; i < 200; i++) {
    const kind = i < 40 ? 'editor' : i === 40 ? 'probe' : i < 45 ? 'measure' : 'watcher'
    ss.push({ sid: `s${i}:t`, key: i + 1, kind, phase: (i * 37) % 100 })
  }
  const say = (s: S, pointer: { x: number; y: number } | null) => {
    const msg: PresenceIn = {
      type: 'presence',
      pointer,
      button: 'up',
      sel: [],
      view: s.kind === 'measure' || s.kind === 'probe' ? probe : main,
      idle: pointer === null,
      editing: null,
    }
    for (const h of hubs) h.input(s.sid, false, msg, false, s.key)
  }
  let t = 0
  const step = () => {
    t++
    const away = new Set<string>()
    for (const s of ss) {
      if (s.kind === 'probe') say(s, { x: 50_000 + ((t * 7) % 1_000), y: 50_000 + ((t * 3) % 1_000) })
      else if (s.kind === 'editor') {
        if ((t + s.phase) % 30 < 8) say(s, { x: 400 + s.phase * 10 + (t % 40), y: 300 + s.phase * 5 })
      } else {
        // a watcher (the measuring viewers too: they look at the probe's region, their pointers elsewhere)
        // 5 s moving (50 ticks), 5 s away, staggered
        const moving = !opts.watchersGoAway || (t + s.phase) % 100 < 50
        const a = (t + s.phase) * 0.05
        if (moving) say(s, { x: Math.round(960 + 700 * Math.cos(a)), y: Math.round(540 + 400 * Math.sin(a)) })
        else if ((t + s.phase) % 100 === 50) {
          say(s, null)
          away.add(s.sid)
        }
      }
    }
    now += 100
    const out = hubs.map((h) => {
      const frames = new Map<number, string[]>()
      h.tick(
        ss.map((s) => ({
          sid: s.sid,
          key: s.key,
          congested: false,
          send: (f: string) => frames.set(s.key, [...(frames.get(s.key) ?? []), f]),
        })),
      )
      return frames
    })
    return { out, away }
  }
  return { step, ss, clock: () => now }
}

describe('a 200-session board (L1): the same frames, and ranks bounded per tick (CR-3C-1: 200 a tick)', () => {
  it('L1, watchers going away and coming back: every frame the same as the oracle', () => {
    let clock = () => 0
    const mine = new PresenceHub(() => clock())
    const b = l1Board([mine, new ReferencePresenceHub(() => clock())], { watchersGoAway: true })
    clock = b.clock
    for (let i = 0; i < 400; i++) {
      const { out } = b.step()
      const [a, ref] = out as [Map<number, string[]>, Map<number, string[]>]
      for (const s of b.ss)
        expect((a.get(s.key) ?? []).map(normal), `tick ${i} ${s.sid}`).toEqual(
          (ref.get(s.key) ?? []).map(normal),
        )
    }
  })

  it('L1, watchers going away: ranked are the holders of a cursor that went away, and the backstop', () => {
    let clock = () => 0
    const h = new PresenceHub(() => clock())
    const b = l1Board([h], { watchersGoAway: true })
    clock = b.clock
    // what each socket holds, as its client applies the frames
    const held = new Map<number, Set<string>>(b.ss.map((s) => [s.key, new Set<string>()]))
    const apply = (frames: Map<number, string[]>) => {
      for (const [key, fs] of frames)
        for (const f of fs) {
          const m = JSON.parse(f) as { peers: { sid: string }[]; off?: string[] }
          const mine = held.get(key) as Set<string>
          for (const p of m.peers) mine.add(p.sid)
          for (const o of m.off ?? []) mine.delete(o)
        }
    }
    const backstop = Math.ceil(b.ss.length / RERANK_EVERY_TICKS)
    let ranks = 0
    let holders = 0
    let worst = 0
    let builds = 0
    const ticks = 750
    let shares = 0
    for (let i = 0; i < ticks; i++) {
      const before = h.rankCalls
      const sharesBefore = h.rankShares
      const buildsBefore = h.bucketBuilds
      // what everyone holds as the tick starts (the frames of the ticks before it)
      const start = new Map([...held].map(([k, v]) => [k, new Set(v)]))
      const { out, away } = b.step()
      apply(out[0] as Map<number, string[]>)
      if (i < 150) continue // the joins and the first round of going away
      let n = 0
      for (const set of start.values()) if ([...away].some((s) => set.has(s))) n++
      const r = h.rankCalls - before
      expect(r, `tick ${i}`).toBeLessThanOrEqual(n + backstop)
      ranks += r
      shares += h.rankShares - sharesBefore
      holders += n
      worst = Math.max(worst, r)
      builds += h.bucketBuilds - buildsBefore
    }
    const measured = ticks - 150
    // a bucket per distinct view (two here) per tick at most, built only when someone with it is ranked
    expect(builds / measured).toBeLessThanOrEqual(2)
    for (const set of held.values()) expect(set.size).toBeLessThanOrEqual(CURSORS_PER_RECIPIENT)
    // PRES-2: the holders of the cursor that went away mostly hold the same 40, so most of them get the
    // first one's rank: the walks a tick are a few, not one per holder
    const walks = ranks - shares
    expect(walks / measured).toBeLessThan(ranks / measured / 4)
    console.info(
      `[presence-rank] L1 200 sessions, watchers going away: ${(ranks / measured).toFixed(1)} ranks/tick, of them ${(walks / measured).toFixed(1)} walked and ${(shares / measured).toFixed(1)} shared (PRES-2) (worst ${worst}; holders of a cursor gone away ${(holders / measured).toFixed(1)}/tick; backstop ${backstop}; CR-3C-1: 200), ${(builds / measured).toFixed(2)} buckets/tick`,
    )
  })

  it('L1, everyone moving inside the view and nobody going away: only the backstop ranks', () => {
    let clock = () => 0
    const h = new PresenceHub(() => clock())
    const b = l1Board([h], { watchersGoAway: false })
    clock = b.clock
    for (let i = 0; i < 60; i++) b.step()
    const ranks0 = h.rankCalls
    const got = new Map<number, number>()
    for (let i = 0; i < 200; i++) {
      const before = h.rankCalls
      const { out } = b.step()
      // the recipients whose turn it is (staggered by key), never more
      expect(h.rankCalls - before).toBeLessThanOrEqual(Math.ceil(200 / RERANK_EVERY_TICKS))
      for (const [k, fs] of out[0] as Map<number, string[]>) got.set(k, (got.get(k) ?? 0) + fs.length)
    }
    expect((h.rankCalls - ranks0) / 200).toBeLessThanOrEqual(200 / RERANK_EVERY_TICKS)
    // and every recipient still gets the changed cursors it holds
    for (const s of b.ss) expect(got.get(s.key) ?? 0).toBeGreaterThan(0)
  })

  it('one recipient panning over a still board of 200: it alone is ranked each tick (and the backstop)', () => {
    let now = 1_000
    const h = new PresenceHub(() => now)
    const rs: PresenceRecipient[] = []
    const say = (i: number, view: { x: number; y: number; w: number; h: number }) =>
      h.input(
        `p${i}:t`,
        false,
        {
          type: 'presence',
          pointer: { x: 10 * i, y: 10 * (i % 7) },
          button: 'up',
          sel: [],
          view,
          idle: false,
          editing: null,
        },
        false,
        i + 1,
      )
    for (let i = 0; i < 200; i++) {
      rs.push({ sid: `p${i}:t`, key: i + 1, congested: false, send: () => {} })
      say(i, { x: 0, y: 0, w: 4_000, h: 100 })
    }
    now += 100
    h.tick(rs)
    for (let t = 1; t <= 100; t++) {
      say(0, { x: t * 15, y: 0, w: 300, h: 100 })
      now += 100
      const before = h.rankCalls
      h.tick(rs)
      expect(h.rankCalls - before).toBeLessThanOrEqual(1 + Math.ceil(200 / RERANK_EVERY_TICKS))
    }
  })
})
