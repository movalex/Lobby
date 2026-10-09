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
import { PresenceHub } from './hub.ts'
import { lasersOf, setLaserToolSource } from './laser.ts'

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
    sendPresence: (p: Record<string, unknown>) => void sent.push({ type: 'presence', ...p }),
  }
  const deliver = (message: unknown) => {
    for (const l of [...listeners]) l({ kind: 'message', message: message as ServerMessage })
  }
  return { core, sent, deliver, welcome: () => deliver({ type: 'welcome', drags: [] }) }
}

const hubOn = (core: ReturnType<typeof fakeCore>['core']) =>
  new PresenceHub({
    core: core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => [],
    view: () => ({ x: 10, y: 20, w: 800, h: 600, z: 1.5 }),
    readOnly: () => false,
  })

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
    const hub = hubOn(c.core)
    c.welcome()
    c.deliver({ type: 'contracts', rev: PRESENCE_LASER_REV })
    return {
      c,
      hub,
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
    move(
      r.hub,
      400,
      'down',
      Array.from({ length: 30 }, (_, i) => ({ x: 50 + i * 10, y: 1 })),
    )
    expect((r.c.sent.at(-1)?.trail as unknown[] | undefined)?.length).toBe(MAX_LASER_TRAIL_POINTS)
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
    r.hub.onPointer(sample)
    expect(r.c.sent.at(-1)).toMatchObject({ t: 'laser', trail: [{ x: 25, y: 1 }] })
    r.hub.onPointer(sample)
    expect(r.c.sent.at(-1)).toMatchObject({ t: 'laser', pointer: { x: 40, y: 1 } })
    expect(r.c.sent.at(-1)).not.toHaveProperty('trail')
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
    const now = performance.now()
    expect(lasersOf(r.c.core, now).map((l) => [l.sid, l.active, l.points.map((p) => p.x)])).toEqual([
      [BOB, true, [5, 10]],
    ])
    r.c.deliver({ type: 'presence', peers: [], off: [BOB] })
    expect(lasersOf(r.c.core, performance.now())).toEqual([])
    r.c.deliver({ type: 'presence', peers: [entry(20, 'laser')] })
    r.c.deliver({ type: 'roster', events: [{ k: 'leave', sid: BOB }] })
    expect(lasersOf(r.c.core, performance.now())).toEqual([])
    r.c.deliver({ type: 'presence', peers: [entry(30, 'laser')] })
    r.c.welcome()
    expect(lasersOf(r.c.core, performance.now())).toEqual([])
    // a plain entry (no t) never makes a laser
    r.c.deliver({ type: 'presence', peers: [entry(40)] })
    expect(lasersOf(r.c.core, performance.now())).toEqual([])
    r.dispose()
    expect(lasersOf(r.c.core, performance.now())).toEqual([])
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
