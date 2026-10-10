// M6-5 (wave M, CAP-RESTART): after the room closes a socket 4000 RECONNECT (a sync restart or deploy closes every
// room's sockets at once) the first reconnect waits a uniform random 0-3 s, or 0-0.5 s when the tab has changes not
// yet acknowledged; the backoff table is otherwise unchanged. Before, every tab came back within 175-325 ms, one
// burst of hellos and welcomes on a 0.5 CPU (CAP-L1: 98-102 %).

import { hashElements } from '@draftroom/canvas-schema/hash'
import { type ClientMessage, encodeSnapshotFrame } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { createLobbyHeadlessClient } from '../headless/index.ts'
import { rect } from '../testing/elements.ts'
import { FakeRoom, stored } from '../testing/fakeRoom.ts'
import { createManualClock, type ManualClock } from '../testing/manualClock.ts'
import type { ServerInbound } from '../types.ts'
import {
  createSocketTransport,
  HEARTBEAT_CLOSE,
  isRestartClose,
  RESTART_SPREAD_MS,
  RESTART_SPREAD_UNSENT_MS,
  restartSpreadMs,
  type WebSocketLike,
} from './socket.ts'

/** A small seeded generator (mulberry32): the same draws every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { readonly data: unknown }) => void) | null = null
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send() {}
  close() {}
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** One transport on a manual clock; `delays` are the reconnect timers it set (the heartbeat is off). */
function transportOn(clock: ManualClock, o: { random?: () => number; hasUnsent?: () => boolean } = {}) {
  FakeSocket.all = []
  const delays: number[] = []
  const t = createSocketTransport({
    url: () => 'ws://x/connect/b',
    WebSocketImpl: FakeSocket,
    heartbeatMs: 0,
    now: clock.now,
    random: o.random,
    hasUnsent: o.hasUnsent,
    setTimer: (fn, ms) => {
      delays.push(ms)
      return clock.setTimer(fn, ms)
    },
    clearTimer: clock.clearTimer,
  })
  return { t, delays }
}

describe('restartSpreadMs: the distribution and its bounds', () => {
  it('uniform over 0..3 s, or 0..0.5 s with unsent changes, never outside', () => {
    expect(restartSpreadMs(false, () => 0)).toBe(0)
    expect(restartSpreadMs(false, () => 0.5)).toBe(1500)
    expect(restartSpreadMs(false, () => 0.999_999_9)).toBe(RESTART_SPREAD_MS)
    expect(restartSpreadMs(true, () => 0.999_999_9)).toBe(RESTART_SPREAD_UNSENT_MS)
    expect(restartSpreadMs(false, () => 7)).toBe(RESTART_SPREAD_MS)
    expect(restartSpreadMs(false, () => -1)).toBe(0)
    const draw = seeded(42)
    const all: number[] = []
    const unsent: number[] = []
    for (let i = 0; i < 20_000; i++) {
      all.push(restartSpreadMs(false, draw))
      unsent.push(restartSpreadMs(true, draw))
    }
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...all)).toBeLessThanOrEqual(3000)
    expect(Math.max(...unsent)).toBeLessThanOrEqual(500)
    const mean = all.reduce((a, b) => a + b, 0) / all.length
    expect(mean).toBeGreaterThan(1450)
    expect(mean).toBeLessThan(1550)
    // every tenth of the range gets its share (uniform, not a cluster)
    const buckets = new Array(10).fill(0) as number[]
    for (const d of all) {
      const b = Math.min(9, Math.floor(d / 300))
      buckets[b] = (buckets[b] ?? 0) + 1
    }
    for (const n of buckets) {
      expect(n).toBeGreaterThan(1700)
      expect(n).toBeLessThan(2300)
    }
  })

  it("the room's 4000 RECONNECT is a restart close; the client's own heartbeat drop and other closes are not", () => {
    expect(isRestartClose({ code: 4000, reason: 'RECONNECT' })).toBe(true)
    expect(isRestartClose({ code: 4000, reason: '' })).toBe(true)
    expect(isRestartClose(HEARTBEAT_CLOSE)).toBe(false)
    expect(isRestartClose({ code: 1006, reason: '' })).toBe(false)
    expect(isRestartClose({ code: 4099, reason: 'FORBIDDEN' })).toBe(false)
  })
})

describe('the transport after a restart close', () => {
  it('waits the spread before its first reconnect, then the backoff table as before', async () => {
    const clock = createManualClock()
    const { t, delays } = transportOn(clock, { random: () => 0.6 })
    t.connect()
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).open()
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.({ code: 4000, reason: 'RECONNECT' })
    await flush()
    expect(delays).toEqual([1800])
    // the server is not back yet: that attempt fails, and the table goes on from its second step
    clock.advance(1800)
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.({ code: 1006, reason: '' })
    await flush()
    // the second step (500 ms) with the jitter of the draw 0.6: 500 × (0.7 + 0.36)
    expect(delays).toEqual([1800, 530])
    t.close()
  })

  it('the unsent-changes shortcut: at most 0.5 s', async () => {
    const clock = createManualClock()
    let unsent = true
    const { t, delays } = transportOn(clock, { random: () => 0.6, hasUnsent: () => unsent })
    t.connect()
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).open()
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.({ code: 4000, reason: 'RECONNECT' })
    await flush()
    expect(delays).toEqual([300])
    clock.advance(300)
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).open()
    unsent = false
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.({ code: 4000, reason: 'RECONNECT' })
    await flush()
    expect(delays).toEqual([300, 1800])
    t.close()
  })

  it('a hasUnsent that throws counts as none; a heartbeat drop and a network drop keep the jittered table', async () => {
    const clock = createManualClock()
    const { t, delays } = transportOn(clock, {
      random: () => 0.5,
      hasUnsent: () => {
        throw new Error('boom')
      },
    })
    t.connect()
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).open()
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.({ code: 4000, reason: 'RECONNECT' })
    await flush()
    expect(delays).toEqual([1500])
    clock.advance(1500)
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).open()
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.(HEARTBEAT_CLOSE)
    await flush()
    // the socket had opened: the table starts over at 250 ms (± 30 %, the draw 0.5 = 250)
    expect(delays).toEqual([1500, 250])
    clock.advance(250)
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).open()
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.({ code: 1006, reason: '' })
    await flush()
    expect(delays).toEqual([1500, 250, 250])
    t.close()
  })

  it('a terminal close (announced or not) never reconnects', async () => {
    const clock = createManualClock()
    const { t, delays } = transportOn(clock, { random: () => 0.5 })
    t.connect()
    await flush()
    ;(FakeSocket.all.at(-1) as FakeSocket).open()
    ;(FakeSocket.all.at(-1) as FakeSocket).onclose?.({ code: 4099, reason: 'MAINTENANCE' })
    await flush()
    expect(delays).toEqual([])
    expect(t.state).toBe('closed')
    t.close()
  })
})

// ---- the restart suite: 20 headless clients ---------------------------------------------------------------------

const realClock = {
  now: () => Date.now(),
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
} as unknown as ManualClock

/** A WebSocket class whose network is `room`; every socket's construction time is kept (`opened`). */
function roomSockets(room: FakeRoom) {
  return class RoomWS {
    static readonly all: RoomWS[] = []
    static readonly opened: { ticket: string; at: number }[] = []
    readyState = 0
    binaryType = 'blob'
    onopen: ((ev: unknown) => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: { code: number; reason: string }) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    readonly t: ReturnType<FakeRoom['connect']>
    constructor(url: string) {
      const u = new URL(url)
      const tab = u.searchParams.get('sessionId') ?? 'tab'
      const uid = u.searchParams.get('ticket') ?? 'anon'
      RoomWS.opened.push({ ticket: uid, at: performance.now() })
      this.t = room.connect({ uid, tab })
      RoomWS.all.push(this)
      this.t.onState((s, c) => {
        if (s === 'open') {
          this.readyState = 1
          this.onopen?.({})
        } else if (s === 'closed') {
          this.readyState = 3
          this.onclose?.({ code: c?.code ?? 1006, reason: c?.reason ?? '' })
        }
      })
      this.t.onMessage((m: ServerInbound) => {
        if (m.type === 'snapshot')
          void encodeSnapshotFrame(m).then((bytes) =>
            this.onmessage?.({
              data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            }),
          )
        else this.onmessage?.({ data: JSON.stringify(m) })
      })
    }
    send(data: string) {
      this.t.send(JSON.parse(data) as ClientMessage)
    }
    close(code?: number, reason?: string) {
      this.t.close(code, reason)
    }
    /** the room closes this socket as a restart does (element-room.ts close-all: 4000 RECONNECT) */
    restart() {
      this.t.close(4000, 'RECONNECT')
    }
  }
}

const until = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('the restart suite', () => {
  it('20 headless clients come back over at least 2 s after a restart, not within 100 ms, and converge', async () => {
    const room = new FakeRoom({ clock: realClock })
    room.seed([stored(rect('r1', 'a0'))])
    const WS = roomSockets(room)
    const clients = Array.from({ length: 20 }, (_, i) =>
      createLobbyHeadlessClient({
        syncUrl: 'http://127.0.0.1:1',
        boardId: 'b1',
        tab: `t${i}`,
        ticket: `u${i}`,
        WebSocketImpl: WS,
        random: seeded(1000 + i),
      }),
    )
    await Promise.all(clients.map((c) => c.connect()))
    expect(WS.opened).toHaveLength(20)
    const before = WS.opened.length
    const closedAt = performance.now()
    // the sync restarts: every socket is closed 4000 RECONNECT in the same moment
    for (const s of [...WS.all]) s.restart()
    await until(() => clients.every((c) => c.transport.attempts === 2), 8_000)
    const back = WS.opened.slice(before).map((o) => o.at - closedAt)
    expect(back).toHaveLength(20)
    const first = Math.min(...back)
    const last = Math.max(...back)
    expect(last - first, `reconnects spread over ${Math.round(last - first)} ms`).toBeGreaterThanOrEqual(2000)
    expect(last).toBeLessThanOrEqual(RESTART_SPREAD_MS + 500)
    // a ramp, not a burst: no 100 ms window holds more than a handful of them
    const sorted = [...back].sort((a, b) => a - b)
    let densest = 0
    for (let i = 0; i < sorted.length; i++) {
      let j = i
      while (j + 1 < sorted.length && (sorted[j + 1] as number) - (sorted[i] as number) <= 100) j++
      densest = Math.max(densest, j - i + 1)
    }
    expect(densest, 'the most reconnects inside one 100 ms window').toBeLessThanOrEqual(5)
    // and they all converge on the room
    await until(
      () => clients.every((c) => c.core.welcome !== null && c.core.saveStatus.state === 'saved'),
      5_000,
    )
    const want = await hashElements(room.snapshot())
    for (const c of clients) expect(await hashElements(c.core.elements().values())).toBe(want)
    await Promise.all(clients.map((c) => c.close()))
  }, 20_000)
})
