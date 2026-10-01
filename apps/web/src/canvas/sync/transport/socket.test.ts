// The board socket's heartbeat (wave 5, 2C; V1 re-check R8: a silent, half-open socket kept every push
// "in flight" until the browser gave up on it). A fake WebSocket on the manual clock.
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

describe('the board socket heartbeat', () => {
  it('pings after silence, and drops a socket that stays silent: the page reconnects', async () => {
    FakeSocket.all = []
    const clock = createManualClock()
    const states: TransportState[] = []
    const closes: { code: number; reason: string }[] = []
    const t = createSocketTransport({
      url: () => 'ws://x/connect/b',
      WebSocketImpl: FakeSocket,
      heartbeatMs: 15_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      backoffMs: [100],
    })
    t.onState((s, c) => {
      states.push(s)
      if (c) closes.push(c)
    })
    t.connect()
    await flush()
    const s1 = FakeSocket.all[0] as FakeSocket
    s1.open()
    // frames keep it alive: no ping
    clock.advance(10_000)
    s1.receive({ type: 'pong' })
    await flush()
    clock.advance(10_000)
    expect(s1.sent.filter((m) => m.includes('"ping"'))).toEqual([])
    // 15 s of silence: one ping
    clock.advance(10_000)
    expect(s1.sent.filter((m) => m.includes('"ping"'))).toHaveLength(1)
    // a pong in time keeps it
    s1.receive({ type: 'pong' })
    await flush()
    clock.advance(20_000)
    expect(s1.closed).toBeNull()
    // then nothing at all: a ping, then the drop
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
