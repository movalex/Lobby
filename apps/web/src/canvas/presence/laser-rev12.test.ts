// CONTRACTS_REV 12 (wave L foundation, the shared laser; owner W6) on the client: the stale-client pair "a
// rev-12 tab in a rev-11 room". The hub sends the laser fields (`t`, `trail`) only on a socket whose room
// announced PRESENCE_LASER_REV or later; in a rev-11 room (and a room older than rev 10) every message it sends
// is one that room's strict parse accepts, so it never closes its socket. The other pair (a rev-11 tab in a
// rev-12 room) is the room's: apps/sync/test/element-room/presence-rev12.test.ts. W6 adds the sending (L6-1);
// these cases hold before and after it.
import {
  MAX_LASER_TRAIL_POINTS,
  PRESENCE_LASER_REV,
  type RosterEntry,
  type ServerMessage,
} from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { setPresenceFollow } from './follow-target.ts'
import { PresenceHub, type PresenceHubOptions } from './hub.ts'
import { LASER_STILL_MAX_MS, lasersOf, setLaserToolSource } from './laser.ts'

/** Rev 11's `presence` in, as a rev-11 room parses it (strict: `f` and `view.z`, no `t`, no `trail`). */
const PresenceIn11 = z.strictObject({
  type: z.literal('presence'),
  pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  button: z.enum(['up', 'down']),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]),
  view: z
    .strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), z: z.number().optional() })
    .nullable(),
  idle: z.boolean(),
  editing: z.string().nullable(),
  drag: z.unknown().optional(),
  f: z.string().nullable().optional(),
})

const ME = 'usr_me:tab-1'
const BOB = 'usr_bob:tab-1'

function fakeCore() {
  const listeners = new Set<(e: { kind: string; message?: ServerMessage }) => void>()
  const sent: Record<string, unknown>[] = []
  const roster = new Map<string, RosterEntry>([
    [ME, { sid: ME, uid: 'usr_me', name: 'Me', color: '#111111', role: 'editor', guest: false }],
    [BOB, { sid: BOB, uid: 'usr_bob', name: 'Bob', color: '#222222', role: 'editor', guest: false }],
  ])
  const core = {
    sid: ME as string | null,
    on(l: (e: { kind: string; message?: ServerMessage }) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    roster: () => roster,
    sendPresence: (p: Record<string, unknown>): void => void sent.push({ type: 'presence', ...p }),
  }
  const deliver = (message: unknown) => {
    for (const l of [...listeners]) l({ kind: 'message', message: message as ServerMessage })
  }
  return { core, sent, deliver, welcome: () => deliver({ type: 'welcome', drags: [] }) }
}

const hubOn = (core: ReturnType<typeof fakeCore>['core'], extra: Partial<PresenceHubOptions> = {}) =>
  new PresenceHub({
    core: core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => [],
    view: () => ({ x: 10, y: 20, w: 800, h: 600, z: 1.5 }),
    readOnly: () => false,
    ...extra,
  })

/** A virtual clock for a hub: while the laser is pressed it spaces its messages by 50 ms (M2-6), so a test moves time on. */
function clockFor() {
  let t = 1_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  return {
    options: {
      now: () => t,
      setTimer: (fn: () => void, ms: number) => {
        const id = next++
        timers.set(id, { at: t + ms, fn })
        return id
      },
      clearTimer: (h: unknown) => void timers.delete(h as number),
    } satisfies Partial<PresenceHubOptions>,
    tick(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = Math.max(t, due[1].at)
        due[1].fn()
      }
      t = end
    },
  }
}

const press = (hub: PresenceHub, x: number, button: 'up' | 'down') =>
  hub.onPointer({ pointer: { x, y: 1 }, button, source: 'pointermove', pointerType: 'mouse' })

describe('a rev-12 tab in an older room (CONTRACTS_REV 12, deploy order)', () => {
  for (const rev of [null, 10, 11] as const) {
    it(`a ${rev === null ? 'pre-rev-10 room (no contracts frame)' : `rev-${rev} room`}: no laser field, every message one that room accepts`, () => {
      const c = fakeCore()
      const hub = hubOn(c.core)
      c.welcome()
      if (rev !== null) c.deliver({ type: 'contracts', rev })
      press(hub, 1, 'down')
      press(hub, 2, 'down')
      setPresenceFollow(c.core, BOB)
      press(hub, 3, 'up')
      expect(c.sent.length).toBeGreaterThanOrEqual(3)
      for (const m of c.sent) {
        expect(PresenceIn11.safeParse(m).success, JSON.stringify(m)).toBe(true)
        expect(m).not.toHaveProperty('t')
        expect(m).not.toHaveProperty('trail')
      }
      expect(rev === null ? 9 : rev).toBeLessThan(PRESENCE_LASER_REV)
      hub.dispose()
      setPresenceFollow(c.core, null)
    })
  }

  it('a reconnect from a rev-12 room to a rev-11 room (a rollback) sends rev-11 messages again', () => {
    const c = fakeCore()
    const hub = hubOn(c.core)
    c.welcome()
    c.deliver({ type: 'contracts', rev: PRESENCE_LASER_REV })
    press(hub, 1, 'down')
    const atRev11 = c.sent.length
    c.welcome()
    c.deliver({ type: 'contracts', rev: 11 })
    press(hub, 2, 'down')
    press(hub, 3, 'up')
    for (const m of c.sent.slice(atRev11)) {
      expect(PresenceIn11.safeParse(m).success, JSON.stringify(m)).toBe(true)
      expect(m).not.toHaveProperty('t')
    }
    hub.dispose()
  })
})

// ---- L6-1 (W6): the laser itself, in a rev-12 room -----------------------------------------------------------

describe('a rev-12 tab in a rev-12 room (L6-1): the laser goes out, others’ lasers come in', () => {
  const rev12 = () => {
    const c = fakeCore()
    let tool = 'select'
    const offTool = setLaserToolSource(c.core, () => tool === 'laser')
    const clock = clockFor()
    const hub = hubOn(c.core, clock.options)
    c.welcome()
    c.deliver({ type: 'contracts', rev: PRESENCE_LASER_REV })
    clock.tick(60) // the contracts frame's message was a handover: the first press waits for no slot
    return {
      c,
      hub,
      tick: clock.tick,
      /** the hub's clock (its received lasers are stamped with it) */
      now: clock.options.now,
      setTool: (t: string) => {
        tool = t
      },
      dispose: () => {
        hub.dispose()
        offTool()
      },
    }
  }
  const move = (hub: PresenceHub, x: number, button: 'up' | 'down', trail?: { x: number; y: number }[]) =>
    hub.onPointer({
      pointer: { x, y: 1 },
      button,
      source: 'pointermove',
      pointerType: 'mouse',
      ...(trail ? { trail } : {}),
    })

  it('the contracts frame makes it say t: null at once; every message after carries t', () => {
    const r = rev12()
    expect(r.c.sent.at(-1)).toMatchObject({ t: null, f: null })
    move(r.hub, 5, 'up')
    expect(r.c.sent.at(-1)).toMatchObject({ t: null })
    expect(r.c.sent.at(-1)).not.toHaveProperty('trail')
    r.dispose()
  })

  it('a press with the laser tool sends t: laser and the samples since the last message; release sends t: null', () => {
    const r = rev12()
    r.setTool('laser')
    move(r.hub, 10, 'down')
    expect(r.c.sent.at(-1)).toMatchObject({ t: 'laser', button: 'down', pointer: { x: 10, y: 1 } })
    expect(r.c.sent.at(-1)).not.toHaveProperty('trail')
    r.tick(60) // M2-6: the hub spaces laser messages by the 20 Hz interval
    move(r.hub, 40, 'down', [
      { x: 20.4, y: 1 },
      { x: 30, y: 1.2 },
    ])
    expect(r.c.sent.at(-1)).toMatchObject({
      t: 'laser',
      pointer: { x: 40, y: 1 },
      trail: [
        { x: 20, y: 1 },
        { x: 30, y: 1 },
      ],
    })
    // many samples: at most MAX_LASER_TRAIL_POINTS go
    r.tick(60)
    move(
      r.hub,
      400,
      'down',
      Array.from({ length: 30 }, (_, i) => ({ x: 50 + i * 10, y: 1 })),
    )
    expect((r.c.sent.at(-1)?.trail as unknown[] | undefined)?.length).toBe(MAX_LASER_TRAIL_POINTS)
    r.tick(60)
    move(r.hub, 401, 'up', [{ x: 400.6, y: 1 }])
    expect(r.c.sent.at(-1)).toMatchObject({ t: null, button: 'up' })
    expect(r.c.sent.at(-1)).not.toHaveProperty('trail')
    r.dispose()
  })

  it('the same sample handed over again (the session re-sends it on a camera move) brings no trail twice', () => {
    const r = rev12()
    r.setTool('laser')
    move(r.hub, 10, 'down')
    const sample = {
      pointer: { x: 40, y: 1 },
      button: 'down' as const,
      source: 'pointermove',
      pointerType: 'mouse',
      trail: [{ x: 25, y: 1 }],
    }
    r.tick(60)
    r.hub.onPointer(sample)
    expect(r.c.sent.at(-1)).toMatchObject({ t: 'laser', trail: [{ x: 25, y: 1 }] })
    r.tick(60)
    r.hub.onPointer(sample)
    expect(r.c.sent.at(-1)).toMatchObject({ t: 'laser', pointer: { x: 40, y: 1 } })
    expect(r.c.sent.at(-1)).not.toHaveProperty('trail')
    r.dispose()
  })

  // M2-6: the hub spaces laser messages by 50 ms; one a few ms short of its slot goes at once (the core counts whole
  // milliseconds, the hub fractions: a pointer sample a hair early must not wait for a ~15 ms timer)
  it('a laser message less than 5 ms short of its slot goes at once; one 10 ms short waits for the slot', () => {
    const r = rev12()
    r.setTool('laser')
    move(r.hub, 10, 'down')
    const n = r.c.sent.length
    r.tick(46) // 4 ms short of the slot
    move(r.hub, 20, 'down')
    expect(r.c.sent.length).toBe(n + 1)
    r.tick(40) // 10 ms short of the next slot (the last one went at +46: its slot is +96)
    move(r.hub, 30, 'down')
    expect(r.c.sent.length).toBe(n + 1)
    r.tick(10)
    expect(r.c.sent.length).toBe(n + 2)
    expect(r.c.sent.at(-1)).toMatchObject({ t: 'laser', pointer: { x: 30, y: 1 } })
    r.dispose()
  })

  it('a press with the selection tool never carries t: laser or a trail (what an anonymous vote relies on)', () => {
    const r = rev12()
    r.setTool('select')
    move(r.hub, 1, 'down')
    move(r.hub, 9, 'down', [{ x: 5, y: 1 }])
    for (const m of r.c.sent) {
      expect(m.t ?? null).toBeNull()
      expect(m).not.toHaveProperty('trail')
    }
    r.dispose()
  })

  it('receives other sessions’ lasers into lasersOf(core); off, a roster leave and a new welcome clear them', () => {
    const r = rev12()
    const entry = (x: number, t?: 'laser') => ({
      sid: BOB,
      pointer: { x, y: 0 },
      button: 'down',
      sel: [],
      view: null,
      idle: false,
      editing: null,
      ...(t ? { t, trail: [{ x: x - 5, y: 0 }] } : {}),
    })
    r.c.deliver({ type: 'presence', peers: [entry(10, 'laser')] })
    const now = r.now()
    expect(lasersOf(r.c.core, now).map((l) => [l.sid, l.active, l.points.map((p) => p.x)])).toEqual([
      [BOB, true, [5, 10]],
    ])
    r.c.deliver({ type: 'presence', peers: [], off: [BOB] })
    expect(lasersOf(r.c.core, r.now())).toEqual([])
    r.c.deliver({ type: 'presence', peers: [entry(20, 'laser')] })
    r.c.deliver({ type: 'roster', events: [{ k: 'leave', sid: BOB }] })
    expect(lasersOf(r.c.core, r.now())).toEqual([])
    r.c.deliver({ type: 'presence', peers: [entry(30, 'laser')] })
    r.c.welcome()
    expect(lasersOf(r.c.core, r.now())).toEqual([])
    // a plain entry (no t) never makes a laser
    r.c.deliver({ type: 'presence', peers: [entry(40)] })
    expect(lasersOf(r.c.core, r.now())).toEqual([])
    r.dispose()
    expect(lasersOf(r.c.core, r.now())).toEqual([])
  })

  it('a laser tool press in an older room sends nothing new (the deploy order holds with the tool on)', () => {
    for (const rev of [10, 11]) {
      const c = fakeCore()
      const offTool = setLaserToolSource(c.core, () => true)
      const hub = hubOn(c.core)
      c.welcome()
      c.deliver({ type: 'contracts', rev })
      move(hub, 1, 'down')
      move(hub, 9, 'down', [{ x: 5, y: 1 }])
      for (const m of c.sent) {
        expect(PresenceIn11.safeParse(m).success, JSON.stringify(m)).toBe(true)
        expect(m).not.toHaveProperty('t')
      }
      hub.dispose()
      offTool()
    }
  })
})

// ---- M2-6 (wave M, W2): a laser held still stays; a laser message is never coalesced away -------------------------

/**
 * A virtual clock with timers, and a core that does what the real one does with presence
 * (canvas/sync/core/engine.ts sendPresence): a message that comes within one 20 Hz interval of the last flush
 * is held, a newer one replaces it, and the timer flushes what is held. Everything flushed is delivered, as the
 * room relays it, to a second hub (the peer's) whose core sees it as an entry of `ME`.
 */
function meeting() {
  let t = 1_000
  const timers = new Map<number, { at: number; fn: () => void }>()
  let nextTimer = 1
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextTimer++
    timers.set(id, { at: t + ms, fn })
    return id
  }
  const clearTimer = (h: unknown) => void timers.delete(h as number)
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      t = Math.max(t, due[1].at)
      due[1].fn()
    }
    t = end
  }

  // the peer (Bob): receives
  const bob = fakeCore()
  const bobHub = new PresenceHub({
    core: bob.core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => [],
    view: () => null,
    readOnly: () => false,
    now: () => t,
  })
  bob.welcome()
  bob.deliver({ type: 'contracts', rev: PRESENCE_LASER_REV })

  // the sender (Alice = ME): her core coalesces like the real one, and relays to Bob
  const alice = fakeCore()
  const flushed: Record<string, unknown>[] = []
  let pending: Record<string, unknown> | null = null
  let last = Number.NEGATIVE_INFINITY
  let coreTimer: number | null = null
  const flush = () => {
    const p = pending
    pending = null
    if (!p) return
    last = t
    flushed.push(p)
    const { drag: _drag, type: _type, ...rest } = p
    bob.deliver({ type: 'presence', peers: [{ sid: ME, ...rest }] })
  }
  alice.core.sendPresence = (p: Record<string, unknown>) => {
    pending = { type: 'presence', ...p }
    const wait = last + 1000 / 20 - t
    if (wait <= 0) return flush()
    if (coreTimer === null)
      coreTimer = setTimer(() => {
        coreTimer = null
        flush()
      }, wait)
  }
  let tool = 'laser'
  const offTool = setLaserToolSource(alice.core, () => tool === 'laser')
  const aliceHub = new PresenceHub({
    core: alice.core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => [],
    view: () => ({ x: 10, y: 20, w: 800, h: 600, z: 1.5 }),
    readOnly: () => false,
    now: () => t,
    setTimer,
    clearTimer,
  })
  alice.welcome()
  alice.deliver({ type: 'contracts', rev: PRESENCE_LASER_REV })
  const sample = (
    x: number,
    button: 'up' | 'down',
    trail?: { x: number; y: number }[],
  ): Parameters<PresenceHub['onPointer']>[0] => ({
    pointer: { x, y: 1 },
    button,
    source: 'pointermove',
    pointerType: 'mouse',
    ...(trail ? { trail } : {}),
  })
  return {
    alice,
    aliceHub,
    bob,
    flushed,
    advance,
    now: () => t,
    sample,
    setTool: (v: string) => {
      tool = v
    },
    /** Bob's view of Alice's laser now */
    seen: () => lasersOf(bob.core, t).find((l) => l.sid === ME),
    dispose: () => {
      aliceHub.dispose()
      bobHub.dispose()
      offTool()
    },
  }
}

describe('M2-6: a laser held still stays visible to the others', () => {
  it('pressed and not moved for 10 s: the peer still has the laser (it fails without the re-send: gone after 3 s)', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(100, 'down'))
    m.advance(60)
    m.aliceHub.onPointer(m.sample(120, 'down', [{ x: 110, y: 1 }]))
    m.advance(200)
    expect(m.seen()?.active).toBe(true)
    // held still: no pointer event at all for 10 s
    for (let s = 1; s <= 10; s++) {
      m.advance(1_000)
      expect(m.seen()?.active, `${s} s after the last move`).toBe(true)
      // the dot is where she points
      expect(m.seen()?.points.at(-1)).toMatchObject({ x: 120, y: 1 })
    }
    // released: the peer gets t: null and the laser fades on its own
    m.aliceHub.onPointer(m.sample(120, 'up'))
    m.advance(60)
    expect(m.seen()?.active ?? false).toBe(false)
    m.advance(1_500)
    expect(m.seen()).toBeUndefined()
    m.dispose()
  })

  it('the re-send is one message a second with the laser fields only: same point, t: laser, no trail', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(100, 'down'))
    m.advance(60)
    m.aliceHub.onPointer(m.sample(120, 'down', [{ x: 110, y: 1 }]))
    m.advance(100)
    const before = m.flushed.length
    m.advance(5_000)
    const resent = m.flushed.slice(before)
    // 5 s of holding still: about a message a second (never faster than the 20 Hz cap, never silent for 2 s)
    expect(resent.length).toBeGreaterThanOrEqual(4)
    expect(resent.length).toBeLessThanOrEqual(6)
    for (const p of resent) {
      expect(p).toMatchObject({ t: 'laser', button: 'down', pointer: { x: 120, y: 1 } })
      expect(p).not.toHaveProperty('trail')
    }
    m.dispose()
  })

  it('a moving laser sends no extra messages (the re-send waits for a second of stillness)', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(100, 'down'))
    for (let i = 1; i <= 40; i++) {
      m.advance(50)
      m.aliceHub.onPointer(m.sample(100 + i * 5, 'down', [{ x: 100 + i * 5 - 2, y: 1 }]))
    }
    // 40 moves over 2 s, one message per move at the most
    expect(m.flushed.length).toBeLessThanOrEqual(41)
    m.dispose()
  })

  it('released or with the selection tool: no timer runs on (nothing is re-sent)', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(100, 'down'))
    m.aliceHub.onPointer(m.sample(100, 'up'))
    m.advance(100)
    const n = m.flushed.length
    m.advance(10_000)
    expect(m.flushed.length).toBe(n)
    m.setTool('select')
    m.aliceHub.onPointer(m.sample(100, 'down'))
    m.advance(100)
    const k = m.flushed.length
    m.advance(10_000)
    expect(m.flushed.length).toBe(k)
    m.dispose()
  })

  it('wave N.1: a press whose release was lost (still down, not moving) expires: the others see it end and nothing is re-sent after', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(100, 'down'))
    m.advance(60)
    m.aliceHub.onPointer(m.sample(120, 'down', [{ x: 110, y: 1 }]))
    // held still for a long while is a laser held still (M2-6): it stays visible up to the limit…
    m.advance(LASER_STILL_MAX_MS - 1_000)
    expect(m.seen()?.active).toBe(true)
    // …and past it the press counts as released: t: null goes out once, the laser fades on its own
    m.advance(2_000)
    expect(m.seen()?.active ?? false).toBe(false)
    expect(m.flushed.at(-1)).toMatchObject({ t: null })
    m.advance(1_500)
    expect(m.seen()).toBeUndefined()
    const n = m.flushed.length
    m.advance(20_000)
    expect(m.flushed.length).toBe(n)
    // a real pointer event after it is a new press (the person is still there and pressing)
    m.aliceHub.onPointer(m.sample(130, 'down'))
    m.advance(100)
    expect(m.seen()?.active).toBe(true)
    m.dispose()
  })

  it('a laser that keeps moving never expires, however long the press lasts', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(0, 'down'))
    for (let i = 1; i <= 80; i++) {
      m.advance(1_000)
      m.aliceHub.onPointer(m.sample(i, 'down'))
    }
    m.advance(200)
    expect(m.seen()?.active).toBe(true)
    m.dispose()
  })

  it('a rev-11 room receives nothing new: no re-send, no laser field, every message one it accepts', () => {
    for (const rev of [10, 11]) {
      const c = fakeCore()
      const offTool = setLaserToolSource(c.core, () => true)
      let t = 0
      const timers: { at: number; fn: () => void }[] = []
      const hub = new PresenceHub({
        core: c.core as unknown as LobbyEngineCore,
        overrides: null,
        elements: () => [],
        view: () => ({ x: 10, y: 20, w: 800, h: 600, z: 1.5 }),
        readOnly: () => false,
        now: () => t,
        setTimer: (fn, ms) => timers.push({ at: t + ms, fn }),
        clearTimer: () => {},
      })
      c.welcome()
      c.deliver({ type: 'contracts', rev })
      hub.onPointer({ pointer: { x: 1, y: 1 }, button: 'down', source: 'pointerdown', pointerType: 'mouse' })
      const sent = c.sent.length
      // ten seconds of holding still: any timer the hub set would fire here
      t += 10_000
      for (const x of timers) x.fn()
      expect(c.sent.length).toBe(sent)
      for (const m of c.sent) {
        expect(PresenceIn11.safeParse(m).success, JSON.stringify(m)).toBe(true)
        expect(m).not.toHaveProperty('t')
        expect(m).not.toHaveProperty('trail')
      }
      hub.dispose()
      offTool()
    }
  })

  it('a new welcome (a reconnect) stops the re-send until the next press', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(100, 'down'))
    m.advance(100)
    m.alice.welcome()
    const n = m.flushed.length
    m.advance(10_000)
    expect(m.flushed.length).toBe(n)
    m.dispose()
  })
})

describe('M2-6: a laser message is never coalesced away', () => {
  it('a camera re-send of the same sample right after a sample with a trail does not lose that trail', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(100, 'down'))
    m.advance(10)
    const sample = m.sample(160, 'down', [
      { x: 110, y: 1 },
      { x: 130, y: 1 },
      { x: 150, y: 1 },
    ])
    m.aliceHub.onPointer(sample)
    m.advance(10)
    // the board session re-sends its last sample on a camera move: no new trail, a fresh view
    m.aliceHub.onPointer(sample)
    m.advance(100)
    const trails = m.flushed.flatMap((p) => (p.trail as { x: number }[] | undefined)?.map((q) => q.x) ?? [])
    expect(trails).toEqual([100, 110, 130, 150])
    // and the peer's laser has the whole path to the last point
    expect(m.seen()?.points.map((p) => p.x)).toEqual([100, 110, 130, 150, 160])
    m.dispose()
  })

  it('moves faster than 20 Hz go out at most every 50 ms, each batch with at most 6 points ending at the latest', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(0, 'down'))
    // 125 moves a second for one second, each with two coalesced points
    for (let i = 1; i <= 125; i++) {
      m.advance(8)
      m.aliceHub.onPointer(
        m.sample(i * 4, 'down', [
          { x: i * 4 - 3, y: 1 },
          { x: i * 4 - 2, y: 1 },
        ]),
      )
    }
    m.advance(100)
    expect(m.flushed.length).toBeLessThanOrEqual(22)
    for (const p of m.flushed) expect((p.trail as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(6)
    // the peer ends where she is
    expect(m.seen()?.points.at(-1)).toMatchObject({ x: 500, y: 1 })
    m.dispose()
  })

  it('the release goes at once and nothing of the laser follows it', () => {
    const m = meeting()
    m.aliceHub.onPointer(m.sample(0, 'down'))
    m.advance(10)
    m.aliceHub.onPointer(m.sample(20, 'down', [{ x: 10, y: 1 }]))
    const waiting = m.flushed.length
    m.aliceHub.onPointer(m.sample(30, 'up'))
    m.advance(200)
    const after = m.flushed.slice(waiting)
    expect(after.at(-1)).toMatchObject({ t: null, button: 'up' })
    expect(after.filter((p) => p.t === 'laser').length).toBeLessThanOrEqual(1)
    m.dispose()
  })
})
