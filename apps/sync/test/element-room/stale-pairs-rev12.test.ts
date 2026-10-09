// Wave L (W6): the stale-client pairs of CONTRACTS_REV 12, with the client code browsers run (the web's engine
// core in O2's headless client, and the web's presence hub, apps/web/src/canvas/presence/hub.ts) against the
// real server process.
//
//  1. Presence (L6-1): a rev-12 web that lasers, a rev-12 web that watches, and a third tab that meets an
//     older room (its socket's `contracts` frame says 11, and a presence message the rev-11 room's strict
//     parse would refuse closes the socket INVALID_MESSAGE). That third tab is both pairs at once: (b) a
//     rev-12 web in a rev-11 room sends nothing a rev-11 room refuses, also with the laser tool on; (a) a
//     socket that never sent `t`, as a rev-11 web's, is never sent `t` or `trail` (every frame parses with
//     rev 11's strict schemas) while another tab lasers. Cursors and follow keep working on every tab.
//  2. present.mins (L6-4): a push that sets it commits; a receive-only web tab of the previous build (whose
//     element path is this one: web clients do not validate incoming customData) keeps working and pushes
//     nothing back; one that rewrites present.index writes the whole value it knows, so mins goes (pinned:
//     W5's writes always send index, skip and mins together).

import { PRESENCE_LASER_REV } from '@draftroom/canvas-schema/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { setPresenceFollow } from '../../../web/src/canvas/presence/follow-target.ts'
import { PresenceHub } from '../../../web/src/canvas/presence/hub.ts'
import { setLaserToolSource } from '../../../web/src/canvas/presence/laser.ts'
import {
  createLobbyHeadlessClient,
  type LobbyHeadlessClient,
} from '../../../web/src/canvas/sync/headless/index.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { ticketFor } from './support/client.ts'
import { frame, rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- rev 11's strict presence schemas ---------------------------------------------------------------------------

const Rect11 = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number().positive().optional(),
})
const PresenceIn11 = z.strictObject({
  type: z.literal('presence'),
  pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  button: z.enum(['up', 'down']),
  sel: z.union([z.array(z.string()), z.strictObject({ count: z.number() })]),
  view: Rect11.nullable(),
  idle: z.boolean(),
  editing: z.string().nullable(),
  drag: z.unknown().optional(),
  f: z.string().nullable().optional(),
})
const PresenceOut11 = z.strictObject({
  type: z.literal('presence'),
  peers: z.array(
    z.strictObject({
      sid: z.string(),
      pointer: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
      button: z.enum(['up', 'down']),
      sel: z.unknown(),
      view: Rect11.nullable(),
      idle: z.boolean(),
      editing: z.string().nullable(),
      f: z.string().nullable().optional(),
    }),
  ),
  off: z.array(z.string()).optional(),
  drags: z.array(z.unknown()).optional(),
  followers: z.array(z.string()).optional(),
})

// ---- a socket that meets a rev-11 room ---------------------------------------------------------------------

interface SocketLike {
  readonly readyState: number
  binaryType: string
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { readonly data: unknown }) => void) | null
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface Rev11Room {
  /** presence messages this tab sent that a rev-11 room refuses (it would close the socket) */
  readonly refused: string[]
  /** every presence frame the room sent this tab, raw */
  readonly frames: string[]
  readonly sent: Record<string, unknown>[]
}

/**
 * A WebSocket that makes the real (rev-12) room look like a rev-11 one to the tab: its `contracts` frame says
 * 11, and a presence message with a field rev 11's strict parse refuses is not delivered: the socket closes
 * 4099 INVALID_MESSAGE, as a rev-11 room closes it.
 */
function rev11RoomSocket(log: Rev11Room): new (url: string) => SocketLike {
  return class Rev11Socket implements SocketLike {
    private readonly ws: SocketLike
    onopen: SocketLike['onopen'] = null
    onmessage: SocketLike['onmessage'] = null
    onclose: SocketLike['onclose'] = null
    onerror: SocketLike['onerror'] = null
    constructor(url: string) {
      this.ws = new TicketWebSocket(url) as unknown as SocketLike
      this.ws.onopen = (e) => this.onopen?.(e)
      this.ws.onerror = (e) => this.onerror?.(e)
      this.ws.onclose = (e) => this.onclose?.(e)
      this.ws.onmessage = (e) => {
        let data = e.data
        if (typeof data === 'string' && data.startsWith('{"type":"contracts"'))
          data = JSON.stringify({ type: 'contracts', rev: 11 })
        if (typeof data === 'string' && data.startsWith('{"type":"presence"')) log.frames.push(data)
        this.onmessage?.({ data })
      }
    }
    get readyState() {
      return this.ws.readyState
    }
    get binaryType() {
      return this.ws.binaryType
    }
    set binaryType(v: string) {
      this.ws.binaryType = v
    }
    send(data: string) {
      const m = JSON.parse(data) as Record<string, unknown>
      if (m.type === 'presence') {
        log.sent.push(m)
        if (!PresenceIn11.safeParse(m).success) {
          log.refused.push(data)
          this.ws.close(4099, 'INVALID_MESSAGE')
          return
        }
      }
      this.ws.send(data)
    }
    close(code?: number, reason?: string) {
      this.ws.close(code, reason)
    }
  }
}

// ---- tabs ---------------------------------------------------------------------------------------------------------

interface Tab {
  readonly c: LobbyHeadlessClient
  readonly hub: PresenceHub
  view: { x: number; y: number; w: number; h: number; z?: number }
  laser: boolean
  readonly frames: string[]
  sid(): string
  move(x: number, y: number, button: 'up' | 'down', trail?: { x: number; y: number }[]): void
}

const opened: Tab[] = []
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) f()
  for (const t of opened.splice(0)) {
    t.hub.dispose()
    await t.c.close().catch(() => {})
  }
})

async function tab(wsUrl: string, boardId: string, user: string, room11?: Rev11Room): Promise<Tab> {
  const frames: string[] = []
  const c = createLobbyHeadlessClient({
    syncUrl: wsUrl,
    boardId,
    tab: `tab-${user}`,
    ticket: ticketFor(boardId, user),
    WebSocketImpl: (room11 ? rev11RoomSocket(room11) : TicketWebSocket) as never,
    reconnect: false,
  })
  const t: Tab = {
    c,
    hub: undefined as unknown as PresenceHub,
    view: { x: 0, y: 0, w: 800, h: 600, z: 1 },
    laser: false,
    frames,
    sid: () => c.core.sid ?? '',
    move(x, y, button, trail) {
      t.hub.onPointer({ pointer: { x, y }, button, source: 'pointermove', pointerType: 'mouse', trail })
    },
  }
  ;(t as { hub: PresenceHub }).hub = new PresenceHub({
    core: c.core,
    overrides: null,
    elements: () => [...c.scene.values()],
    view: () => t.view,
    readOnly: () => false,
  })
  cleanups.push(setLaserToolSource(c.core, () => t.laser))
  const off = c.core.on((e) => {
    if (e.kind === 'message' && e.message.type === 'presence') frames.push(JSON.stringify(e.message))
  })
  cleanups.push(off)
  opened.push(t)
  await c.connect()
  return t
}

const entriesOf = (frames: readonly string[], sid: string) =>
  frames
    .map((f) => JSON.parse(f) as { peers: Record<string, unknown>[] })
    .flatMap((m) => m.peers)
    .filter((p) => p.sid === sid)

async function until(test: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`no ${what} within ${ms} ms`)
    await sleep(25)
  }
}

describe('CONTRACTS_REV 12 stale-client pairs, with the web client code (presence)', () => {
  it('a laser in a rev-12 room; a tab in a rev-11 room sends nothing it refuses and is never sent t; cursors and follow work', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const room11: Rev11Room = { refused: [], frames: [], sent: [] }
    const L = await tab(st.server.wsUrl, b, 'leader')
    const W = await tab(st.server.wsUrl, b, 'watcher')
    const X = await tab(st.server.wsUrl, b, 'older-room', room11)
    // each tab's hub says hello to its room's revision (the contracts frame): t only where it said 12
    await until(() => room11.sent.length > 0, 'the stale tab’s first presence')
    // the stale tab follows the leader, with the laser tool in hand (a rev-11 room must still get rev-11 messages)
    X.laser = true
    setPresenceFollow(X.c.core, L.sid())
    X.view = { x: 5, y: 5, w: 400, h: 300, z: 2 }
    X.move(10, 10, 'down')
    X.move(20, 10, 'down', [{ x: 15, y: 10 }])
    X.move(30, 10, 'up')
    // the leader lasers across its view
    L.laser = true
    L.view = { x: 100, y: 100, w: 1200, h: 800, z: 1.25 }
    L.move(100, 100, 'down')
    for (let i = 1; i <= 6; i++) {
      await sleep(60)
      L.move(100 + i * 40, 100, 'down', [
        { x: 100 + i * 40 - 30, y: 100 },
        { x: 100 + i * 40 - 15, y: 100 },
      ])
    }
    await sleep(60)
    L.move(400, 100, 'up')
    const lsid = L.sid()
    await until(
      () => entriesOf(W.frames, lsid).some((p) => p.pointer && (p.pointer as { x: number }).x === 400),
      'the release at W',
    )
    await until(
      () => entriesOf(X.frames, lsid).some((p) => p.pointer && (p.pointer as { x: number }).x === 400),
      'the release at X',
    )
    // the rev-12 watcher got the laser and its trail
    const atW = entriesOf(W.frames, lsid)
    expect(atW.some((p) => p.t === 'laser' && Array.isArray(p.trail) && p.trail.length > 0)).toBe(true)
    expect(atW.at(-1)).not.toHaveProperty('t')
    // (a) the stale tab never got a laser field: every frame parses with rev 11's strict schema
    for (const f of room11.frames) expect(PresenceOut11.safeParse(JSON.parse(f)).success, f).toBe(true)
    for (const p of entriesOf(room11.frames, lsid)) {
      expect(p).not.toHaveProperty('t')
      expect(p).not.toHaveProperty('trail')
    }
    // ... and its cursors and follow work: the leader's pointer moved, its view and zoom arrived
    const atX = entriesOf(room11.frames, lsid)
    expect(new Set(atX.map((p) => (p.pointer as { x: number } | null)?.x)).size).toBeGreaterThan(2)
    expect(atX.some((p) => (p.view as { z?: number } | null)?.z === 1.25)).toBe(true)
    // (b) the stale tab sent only what a rev-11 room accepts, with f (it follows) and never t
    expect(room11.refused).toEqual([])
    expect(room11.sent.some((m) => m.f === lsid)).toBe(true)
    for (const m of room11.sent) expect(m).not.toHaveProperty('t')
    // the leader sees that the stale tab follows it (rev 10's followers list)
    await until(
      () =>
        L.frames.some(
          (f) => (JSON.parse(f) as { followers?: string[] }).followers?.includes(X.sid()) ?? false,
        ),
      'the followers list',
    )
    // nobody's socket was closed, and every tab is still the same session
    for (const t of [L, W, X]) {
      expect(t.c.core.sid).not.toBeNull()
      expect(t.hub.rev10).toBe(true)
    }
    expect(L.hub.rev12 && W.hub.rev12).toBe(true)
    expect(X.hub.rev12).toBe(false)
    expect(PRESENCE_LASER_REV).toBe(12)
  })
})

describe('L6-4: present.mins through the web core', () => {
  it('a push that sets mins commits; a receive-only tab keeps working and pushes nothing back; an index-only rewrite drops mins (pinned)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const A = await tab(st.server.wsUrl, b, 'facilitator')
    const B = await tab(st.server.wsUrl, b, 'previous-build')
    A.c.edit((s) => {
      s.set(
        'f1',
        frame('f1', {
          name: 'Intro',
          customData: { lobby: { present: { index: 0, mins: 5 } } },
        }) as SceneElement,
      )
      s.set('r1', rect('r1', { x: 2000 }) as SceneElement)
    })
    A.c.core.flush()
    await A.c.saved(20_000)
    const stored = (await st.snapshot(b)).elements.find((e) => e.id === 'f1')
    expect((stored?.customData as { lobby?: unknown } | undefined)?.lobby).toEqual({
      present: { index: 0, mins: 5 },
    })
    // the other tab gets it, applies it and pushes nothing back (the echo rule)
    await until(() => B.c.core.clock >= A.c.core.clock, 'the change at B')
    const atB = B.c.scene.get('f1') as { customData?: { lobby?: unknown } } | undefined
    expect(atB?.customData?.lobby).toEqual({ present: { index: 0, mins: 5 } })
    await sleep(300)
    expect(B.c.core.pushLog()).toEqual([])
    // ... and keeps working: its own edit lands
    B.c.change('r1', { x: 2100 })
    B.c.core.flush()
    await B.c.saved(20_000)
    expect((await st.snapshot(b)).elements.find((e) => e.id === 'r1')?.x).toBe(2100)
    // an older build that reorders frames writes the whole `present` it knows (index only): mins goes
    B.c.change('f1', { customData: { lobby: { present: { index: 2 } } } })
    B.c.core.flush()
    await B.c.saved(20_000)
    const after = (await st.snapshot(b)).elements.find((e) => e.id === 'f1')
    expect((after?.customData as { lobby?: unknown } | undefined)?.lobby).toEqual({ present: { index: 2 } })
  })
})
