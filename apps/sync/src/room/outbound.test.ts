// outbound.ts: small frames are written at once; a frame of DEFER_ABOVE_BYTES or more (or a promise) is
// written by the flusher in a later macrotask, with everything queued behind it, in order; the flusher's
// slices stop at FLUSH_SLICE_MS; backpressure and closing are unchanged.

import { describe, expect, it } from 'vitest'
import type { ElementSocket } from '../engine-switch.ts'
import { DEFER_ABOVE_BYTES, flusher, NO_COMPRESS, Outbound } from './outbound.ts'

function socket() {
  const sent: (string | Uint8Array)[] = []
  const s: ElementSocket & { sent: typeof sent; closed: [number, string] | null } = {
    sent,
    closed: null,
    readyState: 1,
    bufferedAmount: 0,
    send: (d) => void sent.push(d),
    close: (c, r) => {
      s.closed = [c, r]
    },
  }
  return s
}
const tick = () => new Promise<void>((r) => setImmediate(r))
const big = 'x'.repeat(DEFER_ABOVE_BYTES)

describe('outbound deferral', () => {
  it('a small frame goes out at once; a large one on the next macrotask, the small one behind it waits', async () => {
    const s = socket()
    const o = new Outbound(s, () => {})
    o.send('a')
    expect(s.sent).toEqual(['a'])
    o.send(big)
    o.send('b')
    expect(s.sent).toEqual(['a']) // nothing more in this task
    expect(o.pending).toBe(big.length + 1)
    await tick()
    expect(s.sent).toEqual(['a', big, 'b'])
    expect(o.pending).toBe(0)
    // after the flush the session is back to writing small frames at once
    o.send('c')
    expect(s.sent).toEqual(['a', big, 'b', 'c'])
  })

  it('a promise entry (a welcome whose size is not known yet) defers the queue and keeps the order', async () => {
    const s = socket()
    const o = new Outbound(s, () => {})
    let resolve!: (v: string) => void
    const welcome = new Promise<string>((r) => {
      resolve = r
    })
    o.send(welcome)
    o.send(new Uint8Array([1, 2, 3]))
    o.send('after')
    await tick()
    expect(s.sent).toEqual([]) // the welcome has not resolved
    resolve('welcome')
    await tick()
    await tick()
    expect(s.sent.map((f) => (typeof f === 'string' ? f : `bin${f.byteLength}`))).toEqual([
      'welcome',
      'bin3',
      'after',
    ])
  })

  it('many sessions with a large frame each are written across slices, every one of them, in order of marking', async () => {
    const sockets = Array.from({ length: 40 }, () => socket())
    const outs = sockets.map((s) => new Outbound(s, () => {}))
    const before = flusher.slices
    for (const o of outs) o.send(big)
    for (const s of sockets) expect(s.sent).toEqual([])
    for (let i = 0; i < 50 && sockets.some((s) => s.sent.length === 0); i++) await tick()
    for (const s of sockets) expect(s.sent).toEqual([big])
    expect(flusher.slices).toBeGreaterThanOrEqual(before + 1)
    expect(flusher.size).toBe(0)
  })

  it('a closed session writes nothing, deferred or not; a socket that is not open drops the frame', async () => {
    const s = socket()
    const o = new Outbound(s, () => {})
    o.send(big)
    o.close()
    await tick()
    expect(s.sent).toEqual([])
    const s2 = socket()
    ;(s2 as { readyState: number }).readyState = 0
    const o2 = new Outbound(s2, () => {})
    o2.send('x')
    expect(s2.sent).toEqual([])
    expect(o2.pending).toBe(0)
  })
})

describe('M7-2: the gzip snapshot is never deflated again', () => {
  it('a binary frame (the snapshot) is sent with compress: false; a text frame with the socket’s default', async () => {
    const calls: { data: string | Uint8Array; opts: unknown }[] = []
    const s: ElementSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (data, opts) => void calls.push({ data, opts }),
      close: () => {},
    }
    const o = new Outbound(s, () => {})
    const snapshot = new Uint8Array([0x1f, 0x8b, 8, 0])
    o.send('{"type":"welcome"}')
    o.send(Promise.resolve(snapshot)) // as the room queues it: compressed off the event loop
    o.send(big)
    for (let i = 0; i < 5 && calls.length < 3; i++) await tick()
    expect(calls.map((c) => [typeof c.data === 'string' ? 'text' : 'binary', c.opts])).toEqual([
      ['text', undefined],
      ['binary', { compress: false }],
      ['text', undefined],
    ])
    expect(NO_COMPRESS).toEqual({ compress: false })
  })
})
