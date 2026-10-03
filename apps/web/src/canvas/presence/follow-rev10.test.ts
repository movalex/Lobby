// CR-3C-1 and CR-3CF-1 (wave A, A2; CONTRACTS_REV 10) on the client: the hub sends whom this tab follows
// (`f`) and its zoom (`view.z`) only to a room that announced rev 10, so a rev-10 tab never gets a rev-9
// room to close its socket (deploy order); the peer store gives `following`, `zoom` and the followers the
// room lists past the cursor cap; the follow part sets the target and hands the camera rule the leader's
// zoom; Gather's readable camera prefers that zoom to the one its summon implied.
import {
  PRESENCE_FOLLOW_REV,
  PresenceIn,
  type RosterEntry,
  type ServerMessage,
} from '@draftroom/canvas-schema/protocol'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { leaderZoomOf, readableFollowCamera } from '../../features/workshops/ported/camera.ts'
import { atom } from '../../lib/signals.ts'
import type { LobbyCanvas, RemoteCursor } from '../api/lobby-canvas.ts'
import { createFollowPart } from '../api/parts/follow.ts'
import { PeerStore } from '../board/peers.ts'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import { presenceFollowOf, setPresenceFollow } from './follow-target.ts'
import { PresenceHub } from './hub.ts'

/** Rev 9's `presence` in, as a rev-9 room parses it (strict: no `f`, no `view.z`). */
const PresenceIn9 = z.strictObject({
  type: z.literal('presence'),
  pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  button: z.enum(['up', 'down']),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]),
  view: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  idle: z.boolean(),
  editing: z.string().nullable(),
  drag: z.unknown().optional(),
})

const ME = 'usr_me:tab-1'
const BOB = 'usr_bob:tab-1'

/** A fake engine core: the hub's event stream, roster, sid and what it sends. */
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
  const welcome = () => deliver({ type: 'welcome', drags: [] })
  return { core, sent, roster, deliver, welcome }
}

function hubOn(core: ReturnType<typeof fakeCore>['core']) {
  return new PresenceHub({
    core: core as unknown as LobbyEngineCore,
    overrides: null,
    elements: () => [],
    view: () => ({ x: 10, y: 20, w: 800, h: 600, z: 1.23456 }),
    readOnly: () => false,
  })
}

const move = (hub: PresenceHub, x: number) =>
  hub.onPointer({ pointer: { x, y: 1 }, button: 'up', source: 'pointermove', pointerType: 'mouse' })

describe('the hub against a rev-9 room and a rev-10 room (deploy order, CONTRACTS_REV 10)', () => {
  it('a rev-9 room (no contracts frame): every message is one a rev-9 room accepts, follow or not', () => {
    const c = fakeCore()
    const hub = hubOn(c.core)
    c.welcome()
    move(hub, 1)
    setPresenceFollow(c.core, BOB)
    move(hub, 2)
    expect(c.sent.length).toBeGreaterThanOrEqual(2)
    for (const m of c.sent) {
      expect(PresenceIn9.safeParse(m).success, JSON.stringify(m)).toBe(true)
      expect(m).not.toHaveProperty('f')
    }
    expect(hub.rev10).toBe(false)
    hub.dispose()
    setPresenceFollow(c.core, null)
  })

  it('a rev-10 room: the contracts frame makes the hub say so at once (`f`), then `f` and `view.z` always', () => {
    const c = fakeCore()
    const hub = hubOn(c.core)
    c.welcome()
    move(hub, 1)
    const before = c.sent.length
    c.deliver({ type: 'contracts', rev: PRESENCE_FOLLOW_REV })
    expect(hub.rev10).toBe(true)
    // sent at once, without a pointer move: the room now knows this socket reads rev 10
    expect(c.sent.length).toBe(before + 1)
    const hello = c.sent.at(-1) as Record<string, unknown>
    expect(hello.f).toBeNull()
    expect(hello.view).toEqual({ x: 10, y: 20, w: 800, h: 600, z: 1.235 })
    expect(PresenceIn.safeParse(hello).success).toBe(true)
    // following someone goes out at once too, and stays in every message
    setPresenceFollow(c.core, BOB)
    expect(c.sent.at(-1)?.f).toBe(BOB)
    move(hub, 3)
    expect(c.sent.at(-1)?.f).toBe(BOB)
    // never itself
    setPresenceFollow(c.core, ME)
    expect(c.sent.at(-1)?.f).toBeNull()
    setPresenceFollow(c.core, null)
    expect(c.sent.at(-1)?.f).toBeNull()
    for (const m of c.sent.slice(before)) expect(PresenceIn.safeParse(m).success).toBe(true)
    hub.dispose()
  })

  it('a reconnect to an older room (a new welcome, no contracts frame) goes back to rev-9 messages', () => {
    const c = fakeCore()
    const hub = hubOn(c.core)
    c.welcome()
    c.deliver({ type: 'contracts', rev: 10 })
    setPresenceFollow(c.core, BOB)
    expect(c.sent.at(-1)?.f).toBe(BOB)
    c.welcome() // the socket dropped; the new room (a rolled-back service) says nothing
    const from = c.sent.length
    move(hub, 5)
    setPresenceFollow(c.core, null)
    setPresenceFollow(c.core, BOB)
    move(hub, 6)
    expect(c.sent.length).toBeGreaterThan(from)
    for (const m of c.sent.slice(from)) expect(PresenceIn9.safeParse(m).success, JSON.stringify(m)).toBe(true)
    hub.dispose()
    setPresenceFollow(c.core, null)
  })

  it('a zoom out of range is left out rather than sent (the room would refuse the message)', () => {
    const c = fakeCore()
    const hub = new PresenceHub({
      core: c.core as unknown as LobbyEngineCore,
      overrides: null,
      elements: () => [],
      view: () => ({ x: 0, y: 0, w: 10, h: 10, z: 0.0001 }),
      readOnly: () => false,
    })
    c.welcome()
    c.deliver({ type: 'contracts', rev: 10 })
    const m = c.sent.at(-1) as Record<string, unknown>
    expect(m.view).toEqual({ x: 0, y: 0, w: 10, h: 10 })
    expect(PresenceIn.safeParse(m).success).toBe(true)
    hub.dispose()
  })
})

describe('the peer store with rev-10 presence', () => {
  const peerFrame = (sid: string, over: Record<string, unknown> = {}) => ({
    sid,
    pointer: { x: 1, y: 2 },
    button: 'up',
    sel: [],
    view: { x: 0, y: 0, w: 100, h: 50 },
    idle: false,
    editing: null,
    ...over,
  })

  it('following and zoom from the frames; followers past the cap as entries with no point', () => {
    const c = fakeCore()
    const carol = 'usr_carol:tab-9'
    c.roster.set(carol, {
      sid: carol,
      uid: 'usr_carol',
      name: 'Carol',
      color: '#333333',
      role: 'viewer',
      guest: false,
    })
    const store = new PeerStore(c.core)
    // a rev-9 frame: nothing new on the cursor (an older room or client)
    c.deliver({ type: 'presence', peers: [peerFrame(BOB)] })
    expect(store.peer(BOB)).not.toHaveProperty('following')
    expect(store.peer(BOB)).not.toHaveProperty('zoom')
    // rev 10: Bob follows someone else and zooms; Carol (not streamed) follows this tab
    c.deliver({
      type: 'presence',
      peers: [peerFrame(BOB, { view: { x: 0, y: 0, w: 100, h: 50, z: 2 }, f: 'usr_x:t' })],
      followers: [carol],
    })
    expect(store.peer(BOB)?.following).toBe('usr_x:t')
    expect(store.peer(BOB)?.zoom).toBe(2)
    expect(store.peer(carol)).toMatchObject({
      name: 'Carol',
      point: null,
      view: null,
      selection: [],
      following: ME,
    })
    expect(store.followers()).toEqual([carol])
    // Bob starts following this tab: the room's list says so
    c.deliver({ type: 'presence', peers: [], followers: [BOB, carol] })
    expect(store.peer(BOB)?.following).toBe(ME)
    // Carol leaves: gone from both
    c.deliver({ type: 'roster', events: [{ k: 'leave', sid: carol }] })
    expect(store.peer(carol)).toBeNull()
    expect(store.followers()).toEqual([BOB])
    // a new welcome starts afresh (a rev-10 room lists the followers again)
    c.deliver({ type: 'welcome', drags: [] })
    expect(store.peers()).toEqual([])
    expect(store.followers()).toEqual([])
    store.dispose()
  })
})

describe('the follow part with presence f (CR-3C-1) and the leader zoom (CR-3CF-1)', () => {
  function canvasFor(core: object, peers: ReturnType<typeof atom<RemoteCursor[]>>) {
    const roster = atom<RosterEntry[]>('roster', [
      { sid: ME, uid: 'usr_me', name: 'Me', color: '#111111', role: 'editor', guest: false },
      { sid: BOB, uid: 'usr_bob', name: 'Bob', color: '#222222', role: 'editor', guest: false },
    ])
    const set = vi.fn()
    const canvas = {
      engine: Object.assign(core, { welcome: { sid: ME } }),
      collaborators: () => roster.get(),
      presence: { peer: (sid: string) => peers.get().find((p) => p.sid === sid) ?? null },
      viewport: { screenRect: () => ({ x: 0, y: 0, width: 400, height: 400 }), set },
      on: () => () => {},
    } as unknown as LobbyCanvas
    return { canvas, set, roster }
  }
  const bob = (view: RemoteCursor['view'], zoom?: number): RemoteCursor => ({
    sid: BOB,
    uid: 'usr_bob',
    name: 'Bob',
    color: '#222222',
    guest: false,
    point: null,
    view,
    selection: [],
    idle: false,
    editing: null,
    ...(zoom ? { zoom } : {}),
  })

  it('start sets the presence follow target, stop clears it; the camera rule gets the leader zoom', () => {
    const core = {}
    const peers = atom<RemoteCursor[]>('peers', [bob({ x: 0, y: 0, width: 800, height: 400 }, 1.5)])
    const { canvas } = canvasFor(core, peers)
    const part = createFollowPart({ port: {} as never, registries: {} as never, self: () => canvas })
    const rule = vi.fn(() => null)
    part.follow.start(BOB, { camera: rule })
    expect(presenceFollowOf(core)).toBe(BOB)
    expect(rule).toHaveBeenLastCalledWith(expect.objectContaining({ leaderZoom: 1.5 }))
    // a zoom alone changing (the same rectangle) still reaches the rule
    peers.set([bob({ x: 0, y: 0, width: 800, height: 400 }, 3)])
    expect(rule).toHaveBeenLastCalledWith(expect.objectContaining({ leaderZoom: 3 }))
    // from an older end there is none
    peers.set([bob({ x: 0, y: 0, width: 800, height: 400 })])
    expect((rule.mock.lastCall as unknown as [{ leaderZoom?: number }])[0]).not.toHaveProperty('leaderZoom')
    part.follow.stop()
    expect(presenceFollowOf(core)).toBeNull()
  })

  it('following someone else replaces the target in one step; their leaving clears it', async () => {
    const core = {}
    const peers = atom<RemoteCursor[]>('peers', [bob({ x: 0, y: 0, width: 10, height: 10 })])
    const { canvas, roster } = canvasFor(core, peers)
    const part = createFollowPart({ port: {} as never, registries: {} as never, self: () => canvas })
    part.follow.start(BOB)
    expect(presenceFollowOf(core)).toBe(BOB)
    roster.set(roster.get().filter((r) => r.sid !== BOB))
    await new Promise((r) => setTimeout(r, 0))
    expect(part.follow.current()).toBeNull()
    expect(presenceFollowOf(core)).toBeNull()
  })
})

describe("Gather's readable camera with the leader's own zoom (CR-3CF-1)", () => {
  const leader = { x: 0, y: 0, width: 2_000, height: 1_000 }
  const phone = { width: 390, height: 844 }
  const fit = { x: 0, y: -2_064, zoom: 390 / 2_000 }

  it("prefers the presence zoom to the summon's canvas size, and works without a summon size", () => {
    expect(leaderZoomOf(leader, 0.8, { w: 1_440, h: 900 })).toBe(0.8)
    expect(leaderZoomOf(leader, null, { w: 1_440, h: 900 })).toBeCloseTo(0.9)
    expect(leaderZoomOf(leader, null, null)).toBe(0)
    // a leader whose window got taller since the summon: the summon size says 0.9, presence says 0.5
    const withZoom = readableFollowCamera({ w: 1_440, h: 900 })({
      leader,
      screen: phone,
      fit,
      leaderZoom: 0.5,
    })
    const fromSummon = readableFollowCamera({ w: 1_440, h: 900 })({ leader, screen: phone, fit })
    expect(withZoom?.zoom).toBeCloseTo(0.5)
    expect(fromSummon?.zoom).toBeCloseTo(0.5) // READABLE_FOLLOW_ZOOM caps it
    // a leader further out than READABLE_FOLLOW_ZOOM: the phone matches the leader's own zoom
    const far = readableFollowCamera({ w: 1_440, h: 900 })({ leader, screen: phone, fit, leaderZoom: 0.4 })
    expect(far?.zoom).toBeCloseTo(0.4)
    // the fit is close enough to the leader's zoom (above NARROW_FOLLOW_RATIO of it): the fit stays
    expect(
      readableFollowCamera({ w: 1_440, h: 900 })({ leader, screen: phone, fit, leaderZoom: 0.3 }),
    ).toBeNull()
    // no summon size (a rev-10 leader): the readable camera still applies
    expect(readableFollowCamera(null)({ leader, screen: phone, fit, leaderZoom: 0.4 })?.zoom).toBeCloseTo(0.4)
    expect(readableFollowCamera(null)({ leader, screen: phone, fit })).toBeNull()
  })
})
