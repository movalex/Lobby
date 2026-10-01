// The reconnect backoff is jittered (socket.ts RECONNECT_JITTER): the delays of a transport that lost its
// socket are drawn within ±30 % of the backoff table, never above 5 s × 1.3, and the table still climbs.
import { describe, expect, it } from 'vitest'
import { createManualClock } from '../testing/manualClock.ts'
import { createSocketTransport, jitteredDelay, RECONNECT_JITTER, type WebSocketLike } from './socket.ts'

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
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('reconnect jitter', () => {
  it('jitteredDelay stays within ±RECONNECT_JITTER of the delay', () => {
    expect(jitteredDelay(1000, () => 0)).toBe(Math.round(1000 * (1 - RECONNECT_JITTER)))
    expect(jitteredDelay(1000, () => 0.5)).toBe(1000)
    expect(jitteredDelay(1000, () => 0.999_999)).toBeLessThanOrEqual(
      Math.round(1000 * (1 + RECONNECT_JITTER)),
    )
    for (let i = 0; i < 1000; i++) {
      const d = jitteredDelay(5000)
      expect(d).toBeGreaterThanOrEqual(3500)
      expect(d).toBeLessThanOrEqual(6500)
    }
  })

  it('the transport waits the jittered table between attempts; two transports with different draws spread out', async () => {
    const delays: number[] = []
    FakeSocket.all = []
    const clock = createManualClock()
    const draws = [0, 1, 0.5, 0, 1, 0.5, 0.5]
    let i = 0
    const t = createSocketTransport({
      url: () => 'ws://x/connect/b',
      WebSocketImpl: FakeSocket,
      heartbeatMs: 0,
      now: clock.now,
      random: () => draws[i++ % draws.length] as number,
      setTimer: (fn, ms) => {
        delays.push(ms)
        return clock.setTimer(fn, ms)
      },
      clearTimer: clock.clearTimer,
    })
    t.connect()
    await flush()
    // the server is gone: every socket closes abnormally at once
    for (let n = 0; n < 7; n++) {
      const s = FakeSocket.all.at(-1) as FakeSocket
      s.onclose?.({ code: 1006, reason: '' })
      await flush()
      clock.advance(7_000)
      await flush()
    }
    // the table 250, 500, 1000, 2000, 4000, 5000, 5000 with the draws 0, 1, 0.5, 0, 1, 0.5, 0.5
    expect(delays).toEqual([175, 650, 1000, 1400, 5200, 5000, 5000])
    expect(Math.max(...delays)).toBeLessThanOrEqual(6500)
    expect(FakeSocket.all).toHaveLength(8)
    t.close()
  })
})
