// Wave E (E2, the D5 note): a busy page must not tear down a healthy socket. Inbound frames are processed
// strictly in arrival order, and a snapshot's decode is asynchronous, so later frames wait behind a slow one.
// The heartbeat's pong waited there too: behind a slow decode the next beat found the ping "unanswered" and
// dropped a socket whose pong had arrived; and the drop's close and reconnect were themselves chained behind
// the same decode. Now the pong counts at receipt, the drop is reported and reconnected at once, and a new
// socket's frames do not wait for the old socket's chain. A fake WebSocket on the manual clock; the slow
// frame is a binary frame whose bytes the test hands over when it wants (`arrayBuffer()` pending until then).
import { encodeSnapshotFrame, type ServerMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../testing/manualClock.ts'
import type { ServerInbound, TransportState } from '../types.ts'
import { createSocketTransport, HEARTBEAT_CLOSE, type WebSocketLike } from './socket.ts'

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { readonly data: unknown }) => void) | null = null
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  receive(m: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  /** a binary frame whose bytes arrive when `release` is called (a slow snapshot decode, a busy page) */
  receiveSlow(): { release(bytes: Uint8Array): void } {
    let release: (b: ArrayBuffer) => void = () => {}
    const pending = new Promise<ArrayBuffer>((r) => {
      release = r
    })
    this.onmessage?.({ data: { arrayBuffer: () => pending } })
    return {
      release: (bytes) =>
        release(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer),
    }
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    // a half-open socket: the close handshake never completes, no onclose comes
    this.closed = { code, reason }
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
/** real time for the platform's gzip stream to run (the decode takes event-loop turns, not microtasks) */
const until = async (ok: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const pings = (s: FakeSocket) => s.sent.filter((m) => m.includes('"ping"')).length
const snapshot = (clock: number) =>
  encodeSnapshotFrame({ type: 'snapshot', epoch: 'e1', clock, horizon: 0, elements: [], doc: {} })

function start(heartbeatMs = 15_000) {
  FakeSocket.all = []
  const clock = createManualClock()
  const states: TransportState[] = []
  const closes: { code: number; reason: string }[] = []
  const got: ServerInbound[] = []
  const t = createSocketTransport({
    url: () => 'ws://x/connect/b',
    WebSocketImpl: FakeSocket,
    heartbeatMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    backoffMs: [100],
    random: () => 0.5,
  })
  t.onState((s, c) => {
    states.push(s)
    if (c) closes.push(c)
  })
  t.onMessage((m) => got.push(m))
  t.connect()
  return { clock, states, closes, got, t }
}

describe('the heartbeat on a busy page (a slow frame ahead of the pong)', () => {
  it('a pong that arrived behind a slow frame keeps the socket; frames are still delivered in arrival order', async () => {
    const { clock, got, t } = start()
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    // 15 s: the first ping; a large snapshot arrives and its decode is slow
    clock.advance(15_000)
    expect(pings(s1)).toBe(1)
    const slow = s1.receiveSlow()
    // the room answers at once; the pong is behind the snapshot in the frame chain
    s1.receive({ type: 'pong' })
    await flush()
    expect(got).toEqual([])
    // 30 s: the next beat. Before, the pong was still waiting in the chain: dropped as dead (4000 heartbeat)
    clock.advance(15_000)
    expect(s1.closed).toBeNull()
    expect(pings(s1)).toBe(2)
    // the decode finishes: the snapshot first, then the pong (arrival order kept)
    slow.release(await snapshot(7))
    await until(() => got.length === 2)
    expect(got.map((m) => m.type)).toEqual(['snapshot', 'pong'])
    // a ping that really goes unanswered still drops the socket
    clock.advance(15_000)
    expect(s1.closed).toEqual({ code: HEARTBEAT_CLOSE.code, reason: HEARTBEAT_CLOSE.reason })
    t.close()
  })

  it('a dead socket behind a slow frame is reported and reconnected at once; the new socket does not wait for the old chain', async () => {
    const { clock, states, closes, got, t } = start()
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    clock.advance(15_000) // ping out
    const slow = s1.receiveSlow() // a decode that does not finish, and no pong
    await flush()
    clock.advance(15_000) // unanswered: dropped
    expect(s1.closed).toEqual({ code: HEARTBEAT_CLOSE.code, reason: HEARTBEAT_CLOSE.reason })
    // before: the close waited behind the decode (the page stayed "online" on a dead socket, no reconnect)
    expect(states.at(-1)).toBe('closed')
    expect(closes.at(-1)).toEqual({ ...HEARTBEAT_CLOSE })
    clock.advance(100)
    await flush()
    expect(FakeSocket.all).toHaveLength(2)
    const s2 = FakeSocket.all[1] as FakeSocket
    s2.open()
    expect(states.at(-1)).toBe('open')
    // the new socket's frames are delivered although the old socket's decode is still pending
    s2.receive({ type: 'pong' })
    s2.receive({ type: 'notice', code: 'PREPARING' })
    await flush()
    expect(got.map((m) => m.type)).toEqual(['pong', 'notice'])
    // the old socket's decode finishing late delivers nothing (its socket is gone)
    slow.release(await snapshot(3))
    await new Promise((r) => setTimeout(r, 50))
    await flush()
    expect(got.map((m) => m.type)).toEqual(['pong', 'notice'])
    t.close()
  })

  it('a frame that only looks like a pong does not count as one (the schema decides, as before)', async () => {
    const { clock, t } = start()
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    clock.advance(15_000)
    s1.onmessage?.({ data: '{"type":"pong","extra":1}' })
    s1.onmessage?.({ data: '{"type":"notice","code":"PREPARING","detail":"pong"}' })
    s1.onmessage?.({ data: '"pong"' })
    await flush()
    clock.advance(15_000)
    expect(s1.closed).toEqual({ code: HEARTBEAT_CLOSE.code, reason: HEARTBEAT_CLOSE.reason })
    t.close()
  })

  it('a pong of a previous socket does not keep the new one', async () => {
    const { clock, t } = start()
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    s1.onclose?.({ code: 1006, reason: '' })
    await flush()
    clock.advance(100)
    await flush()
    const s2 = FakeSocket.all[1] as FakeSocket
    s2.open()
    clock.advance(15_000) // s2's ping
    s1.receive({ type: 'pong' }) // late, on the old socket
    await flush()
    clock.advance(15_000)
    expect(s2.closed).toEqual({ code: HEARTBEAT_CLOSE.code, reason: HEARTBEAT_CLOSE.reason })
    t.close()
  })
})
