// The board socket's heartbeat (wave 5, 2C; V1 re-check R8: a silent, half-open socket kept every push
// "in flight" until the browser gave up on it; V1 re-check round 3, H2: a socket whose upstream was dead
// while other users' frames kept arriving was never found). A fake WebSocket on the manual clock.
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../testing/manualClock.ts'
import type { TransportState } from '../types.ts'
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
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
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

const pings = (s: FakeSocket) => s.sent.filter((m) => m.includes('"ping"')).length

function start(heartbeatMs: number) {
  FakeSocket.all = []
  const clock = createManualClock()
  const states: TransportState[] = []
  const closes: { code: number; reason: string }[] = []
  const t = createSocketTransport({
    url: () => 'ws://x/connect/b',
    WebSocketImpl: FakeSocket,
    heartbeatMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    backoffMs: [100],
    // the reconnect delay is jittered by ±30 % (RECONNECT_JITTER); 0.5 draws the table value exactly, so
    // `clock.advance(100)` below reopens the socket every run instead of on one draw in two
    random: () => 0.5,
  })
  t.onState((s, c) => {
    states.push(s)
    if (c) closes.push(c)
  })
  t.connect()
  return { clock, states, closes, t }
}

describe('the board socket heartbeat', () => {
  it('pings on a fixed cadence, keeps a socket whose pongs come back, and drops one whose ping stays unanswered', async () => {
    const { clock, states, closes, t } = start(15_000)
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    // before the first beat: no ping, and an unsolicited frame changes nothing
    clock.advance(10_000)
    s1.receive({ type: 'changes', clock: 1, ops: [] })
    await flush()
    expect(pings(s1)).toBe(0)
    // 15 s: one ping, whether or not frames arrived
    clock.advance(5_000)
    expect(pings(s1)).toBe(1)
    // a pong in time keeps it
    clock.advance(10_000)
    s1.receive({ type: 'pong' })
    await flush()
    clock.advance(5_000)
    expect(s1.closed).toBeNull()
    expect(pings(s1)).toBe(2)
    // a pong keeps it again; then nothing comes back for the next ping: the drop, 15 s after it
    s1.receive({ type: 'pong' })
    await flush()
    clock.advance(15_000)
    expect(pings(s1)).toBe(3)
    expect(s1.closed).toBeNull()
    clock.advance(15_000)
    expect(s1.closed).toEqual({ code: HEARTBEAT_CLOSE.code, reason: HEARTBEAT_CLOSE.reason })
    await flush()
    expect(closes.at(-1)).toEqual({ ...HEARTBEAT_CLOSE })
    expect(states.at(-1)).toBe('closed')
    // and it reconnects with a new socket
    clock.advance(200)
    await flush()
    expect(FakeSocket.all).toHaveLength(2)
    // the dead socket's late events change nothing
    s1.onclose?.({ code: 1006, reason: '' })
    await flush()
    expect(states.at(-1)).toBe('connecting')
    t.close()
  })

  it("other users' frames do not keep a socket alive: a ping without a pong drops it (H2, a dead upstream)", async () => {
    const { clock, closes, t } = start(15_000)
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    const t0 = clock.now()
    // the server's frames keep arriving (B works on the board) while this socket's upstream is gone
    for (let i = 0; i < 20; i++) {
      clock.advance(2_000)
      s1.receive({ type: 'changes', clock: i + 1, ops: [] })
      await flush()
      if (s1.closed) break
    }
    // the first ping at 15 s got no pong: dropped at 30 s, not after a minute of "saving"
    expect(pings(s1)).toBe(1)
    expect(s1.closed).toEqual({ code: HEARTBEAT_CLOSE.code, reason: HEARTBEAT_CLOSE.reason })
    expect(clock.now() - t0).toBeLessThanOrEqual(32_000)
    await flush()
    expect(closes.at(-1)).toEqual({ ...HEARTBEAT_CLOSE })
    t.close()
  })

  it('0 turns it off', async () => {
    FakeSocket.all = []
    const clock = createManualClock()
    const t = createSocketTransport({
      url: () => 'ws://x/connect/b',
      WebSocketImpl: FakeSocket,
      heartbeatMs: 0,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    t.connect()
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    clock.advance(120_000)
    expect(s1.sent).toEqual([])
    expect(s1.closed).toBeNull()
    t.close()
  })
})

// Wave 4b, SMK-2 (2A with 2C's file): through the Render edge a refused socket got an EMPTY close frame (no
// 4099, no reason), so the page had no reason to show and the transport would have reconnected. The room now
// announces every terminal close in band (`notice` CLOSING, CONTRACTS_REV 9); the close that follows it is
// terminal with that reason, whatever the frame says.
describe('a CLOSING notice makes the close that follows terminal (SMK-2, CONTRACTS_REV 9)', () => {
  const closing = (detail: string) => ({ type: 'notice', code: 'CLOSING', detail })

  it('an empty close frame after the notice is reported as 4099 with the announced reason, and no reconnect follows', async () => {
    const { clock, closes, t } = start(0)
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    s1.receive(closing('MAINTENANCE'))
    s1.onclose?.({ code: 1005, reason: '' }) // what the edge delivered
    await flush()
    expect(closes.at(-1)).toEqual({ code: 4099, reason: 'MAINTENANCE' })
    expect(t.state).toBe('closed')
    clock.advance(5_000)
    await flush()
    expect(FakeSocket.all.length).toBe(1) // terminal: nothing reopened
    expect(t.attempts).toBe(1)
  })

  it('a 4099 close that kept its reason is reported as is; one that lost only the reason gets the announced one', async () => {
    const a = start(0)
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    s1.receive(closing('NOT_AUTHENTICATED'))
    s1.onclose?.({ code: 4099, reason: 'NOT_AUTHENTICATED' })
    await flush()
    expect(a.closes.at(-1)).toEqual({ code: 4099, reason: 'NOT_AUTHENTICATED' })
    const b = start(0)
    await flush()
    const s2 = FakeSocket.all[0] as FakeSocket
    s2.open()
    s2.receive(closing('FORBIDDEN'))
    s2.onclose?.({ code: 4099, reason: '' })
    await flush()
    expect(b.closes.at(-1)).toEqual({ code: 4099, reason: 'FORBIDDEN' })
  })

  it('without the notice an empty close still reconnects (a dropped link is not a refusal), and a notice does not outlive its socket', async () => {
    const { clock, closes, t } = start(0)
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    s1.onclose?.({ code: 1006, reason: '' })
    await flush()
    expect(closes.at(-1)).toEqual({ code: 1006, reason: '' })
    clock.advance(100)
    await flush()
    expect(FakeSocket.all.length).toBe(2)
    // a notice on the first socket (late, after its close) never colours the second socket's close
    s1.receive(closing('MAINTENANCE'))
    const s2 = FakeSocket.all[1] as FakeSocket
    s2.open()
    s2.onclose?.({ code: 1006, reason: '' })
    await flush()
    expect(closes.at(-1)).toEqual({ code: 1006, reason: '' })
    expect(t.state).toBe('closed')
    t.close()
  })

  it('a socket the room said it was closing, and that never closed, is dropped by the heartbeat as terminal', async () => {
    const { clock, closes, t } = start(1_000)
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    s1.receive(closing('MAINTENANCE'))
    await flush()
    clock.advance(1_000) // ping out
    clock.advance(1_000) // no pong: dropped
    await flush()
    expect(closes.at(-1)).toEqual({ code: 4099, reason: 'MAINTENANCE' })
    clock.advance(5_000)
    await flush()
    expect(FakeSocket.all.length).toBe(1)
    expect(t.attempts).toBe(1)
  })
})
