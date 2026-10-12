// Wave M (M7-5, CAP-MEM): the process-wide outbound budget (outbound.ts OutboundBudget), with fake sessions.
// The per-session queues were capped (256 KiB presence skip, 8 MiB close) but their sum was not: above the
// budget every session skips presence; above 1.25 times it the largest queues reconnect (4000), largest first;
// `changes` frames are never skipped (a close, never a silent drop); the sum is lobby_outbound_bytes_queued.
// Wave N.1 review: a frame many sockets hold (the cached gzip snapshot of a join storm) is one buffer, counted once.
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { CLOSE_RECONNECT } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { elementSocketOf } from '../app.ts'
import { DEFAULT_OUTBOUND_BUDGET_MB } from '../config.ts'
import type { ElementSocket } from '../engine-switch.ts'
import { RoomMetrics } from './metrics.ts'
import { OUTBOUND, Outbound, OutboundBudget } from './outbound.ts'

function socket(buffered = 0) {
  const sent: (string | Uint8Array)[] = []
  const s: ElementSocket & { sent: typeof sent; closed: [number, string] | null; bufferedAmount: number } = {
    sent,
    closed: null,
    readyState: 1,
    bufferedAmount: buffered,
    send: (d) => void sent.push(d),
    close: (c, r) => {
      s.closed = [c, r]
    },
  }
  return s
}

/** A fake session: an Outbound over a socket whose buffer holds `buffered` bytes, read by `budget`. */
function session(budget: OutboundBudget, buffered: number) {
  const sock = socket(buffered)
  const out = new Outbound(
    sock,
    () => {},
    () => {},
    budget,
  )
  return {
    sock,
    out,
    entry: {
      get pending() {
        return out.pending
      },
      close: () => out.overflow(),
    },
  }
}

describe('M7-5: the process-wide outbound budget', () => {
  it('the default is 64 MiB, the close factor 1.25; a session outside any budget is never over it', () => {
    // wave N.1 (wave M follow-up 7): 128 MiB put the close line at 160 MiB on the 0.5c-512mb instance; 64 MiB puts it
    // at 80 MiB (outbound.ts says why), and the config's default is the same number
    expect(OUTBOUND.globalBudget).toBe(64 * 1024 * 1024)
    expect(OUTBOUND.globalBudget).toBe(DEFAULT_OUTBOUND_BUDGET_MB * 1024 * 1024)
    expect(OUTBOUND.closeFactor).toBe(1.25)
    expect(OUTBOUND.globalBudget * OUTBOUND.closeFactor).toBe(80 * 1024 * 1024)
    expect(new OutboundBudget().bytes).toBe(OUTBOUND.globalBudget)
    const lone = new Outbound(socket(1_000), () => {})
    expect(lone.congested).toBe(false)
  })

  it('above the budget every session is congested (no presence), although each is far under the 256 KiB skip', () => {
    const budget = new OutboundBudget(1_000)
    const a = session(budget, 400)
    const b = session(budget, 300)
    expect(budget.check([a.entry, b.entry])).toBe(0)
    expect(budget).toMatchObject({ over: false, queued: 700 })
    expect(a.out.congested).toBe(false)
    a.sock.bufferedAmount = 800 // 1 100 in all: over 1 000, under 1 250
    expect(budget.check([a.entry, b.entry])).toBe(0)
    expect(budget).toMatchObject({ over: true, queued: 1_100 })
    expect(a.out.congested).toBe(true)
    expect(b.out.congested).toBe(true)
    expect(a.out.pending).toBeLessThan(OUTBOUND.skipPresenceAbove)
    // back under: presence again
    a.sock.bufferedAmount = 100
    budget.check([a.entry, b.entry])
    expect(a.out.congested).toBe(false)
  })

  it('above 1.25 times the budget the LARGEST queue is closed first (4000 RECONNECT), then the next, until under', () => {
    const budget = new OutboundBudget(1_000)
    const small = session(budget, 300)
    const largest = session(budget, 900)
    const middle = session(budget, 500)
    // 1 700 > 1 250: closing the largest (900) leaves 800, under 1 250 (and under the budget: presence again)
    expect(budget.check([small.entry, largest.entry, middle.entry])).toBe(1)
    expect(largest.sock.closed).toEqual([CLOSE_RECONNECT, 'RECONNECT'])
    expect(small.sock.closed).toBeNull()
    expect(middle.sock.closed).toBeNull()
    expect(budget).toMatchObject({ over: false, queued: 800 })

    const budget2 = new OutboundBudget(1_000)
    const q = [700, 650, 600, 100].map((n) => session(budget2, n))
    // 2 050: close 700 (1 350, still over 1 250), then 650 (700): two closes, largest first
    expect(budget2.check(q.map((s) => s.entry))).toBe(2)
    expect(q.map((s) => s.sock.closed?.[0] ?? null)).toEqual([CLOSE_RECONNECT, CLOSE_RECONNECT, null, null])
    expect(budget2.queued).toBe(700)
  })

  it('a `changes` frame is never skipped over the budget: it is queued and written, or its session closed', async () => {
    const budget = new OutboundBudget(1_000)
    const a = session(budget, 900)
    const b = session(budget, 200)
    budget.check([a.entry, b.entry])
    expect(budget.over).toBe(true)
    // over the budget: the room still writes changes (and acks) to everyone; only presence reads `congested`
    a.out.send('{"type":"changes","clock":7,"ops":[]}')
    b.out.send('{"type":"ack","seq":1,"clock":7,"r":[]}')
    expect(a.sock.sent).toEqual(['{"type":"changes","clock":7,"ops":[]}'])
    expect(b.sock.sent).toEqual(['{"type":"ack","seq":1,"clock":7,"r":[]}'])
    // far over (1.25x): the largest is closed (it resyncs from its clock), its later frames go nowhere, silently
    // only because the socket is closed
    a.sock.bufferedAmount = 2_000
    expect(budget.check([a.entry, b.entry])).toBe(1)
    expect(a.sock.closed).toEqual([CLOSE_RECONNECT, 'RECONNECT'])
    a.out.send('{"type":"changes","clock":8,"ops":[]}')
    expect(a.sock.sent).toHaveLength(1)
    expect(b.sock.closed).toBeNull()
  })

  it('lobby_outbound_bytes_queued (and the budget, and whether it is over) in the metrics text', () => {
    const m = new RoomMetrics(() => 0)
    const text = m.render({
      open: 1,
      sessionsByRole: {},
      boards: [],
      outbound: { queuedBytes: 123_456, budgetBytes: 128 * 1024 * 1024, over: false },
    })
    expect(text).toContain('# TYPE lobby_outbound_bytes_queued gauge')
    expect(text).toMatch(/^lobby_outbound_bytes_queued 123456$/m)
    expect(text).toMatch(/^lobby_outbound_budget_bytes 134217728$/m)
    expect(text).toMatch(/^lobby_outbound_over_budget 0$/m)
    m.stop()
  })
})

const MiB = 1024 * 1024
const sizeOf = (d: string | Uint8Array) => (typeof d === 'string' ? d.length : d.byteLength)
const tick = () => new Promise<void>((r) => setImmediate(r))

/**
 * A slow client's socket: what is written stays in its buffer (bufferedAmount) until `drain` takes bytes from
 * its head; a frame's write callback runs once all of it has left, as ws's does.
 */
function slowSocket() {
  const writes: { left: number; done?: () => void }[] = []
  const s: ElementSocket & {
    bufferedAmount: number
    readyState: number
    closed: [number, string] | null
    sent: number
    drain(bytes: number): void
  } = {
    closed: null,
    readyState: 1,
    bufferedAmount: 0,
    sent: 0,
    send: (d, _o, done) => {
      s.sent++
      s.bufferedAmount += sizeOf(d)
      writes.push({ left: sizeOf(d), ...(done ? { done } : {}) })
    },
    close: (c, r) => {
      s.closed = [c, r]
    },
    drain(bytes: number) {
      let n = bytes
      while (n > 0 && writes.length) {
        const w = writes[0] as { left: number; done?: () => void }
        const k = Math.min(n, w.left)
        w.left -= k
        n -= k
        s.bufferedAmount -= k
        if (w.left === 0) {
          writes.shift()
          w.done?.()
        }
      }
    },
  }
  return s
}

/** A joiner as the service's budget timer sees it (index.ts budgetEntries). */
function joiner(budget: OutboundBudget) {
  const sock = slowSocket()
  const out = new Outbound(
    sock,
    () => {},
    () => {},
    budget,
  )
  return {
    sock,
    out,
    entry: () => ({ pending: out.pending, shared: out.shared, close: () => out.overflow() }),
  }
}

async function written(sessions: { sock: { sent: number } }[], frames: number) {
  for (let i = 0; i < 100 && sessions.some((s) => s.sock.sent < frames); i++) await tick()
  for (const s of sessions) expect(s.sock.sent).toBe(frames)
}

describe('wave N.1 review: a frame many sockets hold (the cached gzip snapshot) counts once in the budget', () => {
  it('the same 2 MiB snapshot to 50 joiners (100 MiB summed per socket, one buffer held) closes nobody', async () => {
    const budget = new OutboundBudget()
    const snapshot = new Uint8Array(2 * MiB)
    // as the room queues it (element-room.ts: one promise per cached snapshot)
    const bytes = Promise.resolve(snapshot)
    const welcome = '{"type":"welcome","reset":true}'
    const joiners = Array.from({ length: 50 }, () => joiner(budget))
    for (const j of joiners) {
      j.out.send(Promise.resolve(welcome))
      j.out.send(bytes)
    }
    await written(joiners, 2)
    // every joiner's socket still holds it all (slow clients): 50 times 2 MiB by `pending`
    for (const j of joiners) expect(j.out.pending).toBe(2 * MiB + welcome.length)
    expect(budget.check(joiners.map((j) => j.entry()))).toBe(0)
    for (const j of joiners) expect(j.sock.closed).toBeNull()
    expect(budget.queued).toBe(2 * MiB + 50 * welcome.length)
    expect(budget.over).toBe(false)
    // once a joiner's socket has written it all, it holds nothing; the last one releases the buffer
    for (const j of joiners) j.sock.drain(welcome.length + 2 * MiB)
    for (const j of joiners) expect(j.out.shared).toEqual([])
    budget.check(joiners.map((j) => j.entry()))
    expect(budget.queued).toBe(0)
  })

  it('50 distinct 2 MiB frames still cross the 80 MiB line: the largest close, until the sum is under it', async () => {
    const budget = new OutboundBudget()
    const joiners = Array.from({ length: 50 }, () => joiner(budget))
    for (const j of joiners) j.out.send(new Uint8Array(2 * MiB))
    await written(joiners, 1)
    // 100 MiB of distinct buffers: ten closes bring it to 80 MiB
    expect(budget.check(joiners.map((j) => j.entry()))).toBe(10)
    expect(joiners.filter((j) => j.sock.closed?.[0] === CLOSE_RECONNECT)).toHaveLength(10)
    expect(budget.queued).toBe(80 * MiB)
  })

  it("a joiner's own bytes behind the shared snapshot still count, also once part of the snapshot has gone out", async () => {
    const budget = new OutboundBudget()
    const snapshot = new Uint8Array(2 * MiB)
    // the catch-up and the changes since, after the snapshot: one string here, but bytes of every socket's own, since ws
    // copies a text frame into each socket's buffer as it writes it
    const text = 'x'.repeat(2.5 * MiB)
    const joiners = Array.from({ length: 30 }, () => joiner(budget))
    for (const j of joiners) {
      j.out.send(snapshot)
      j.out.send(text)
    }
    await written(joiners, 2)
    // 2 MiB once and 30 times 2.5 MiB: 77 MiB, over the budget, under the close line
    expect(budget.check(joiners.map((j) => j.entry()))).toBe(0)
    expect(budget.queued).toBe(77 * MiB)
    expect(budget.over).toBe(true)
    // 1 MiB of each socket's snapshot has gone out: the buffer is still held (once), each joiner's 2.5 MiB too
    for (const j of joiners) j.sock.drain(MiB)
    expect(budget.check(joiners.map((j) => j.entry()))).toBe(0)
    expect(budget.queued).toBe(77 * MiB)
    // ten more joiners with text of their own: 102 MiB, and closing a joiner frees its own 2.5 MiB only, the
    // shared buffer once its last holder is gone
    const more = Array.from({ length: 10 }, () => joiner(budget))
    for (const j of more) {
      j.out.send(snapshot)
      j.out.send(text)
    }
    await written(more, 2)
    const all = [...joiners, ...more]
    expect(budget.check(all.map((j) => j.entry()))).toBe(9)
    expect(budget.queued).toBe(2 * MiB + 31 * 2.5 * MiB)
  })

  it('a snapshot dropped unsent (a socket no longer open) or a closed session holds nothing', async () => {
    const budget = new OutboundBudget()
    const snapshot = new Uint8Array(2 * MiB)
    const a = joiner(budget)
    const b = joiner(budget)
    a.sock.readyState = 3
    a.out.send(snapshot)
    b.out.send(snapshot)
    await written([b], 1)
    expect(a.out.shared).toEqual([])
    expect(b.out.shared).toHaveLength(1)
    b.out.overflow()
    expect(b.out.shared).toEqual([])
  })

  it('over a real ws socket (app.ts elementSocketOf) the snapshot is held until ws has written all of it', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    const accepted = once(wss, 'connection') as Promise<[WebSocket]>
    const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`)
    const got = new Promise<number>((r) => client.once('message', (d: Buffer) => r(d.byteLength)))
    const [ws] = await accepted
    try {
      const out = new Outbound(elementSocketOf(ws), () => {})
      const snapshot = new Uint8Array(2 * MiB)
      out.send(snapshot)
      expect(out.shared).toEqual([{ frame: snapshot, bytes: 2 * MiB, counted: 2 * MiB }])
      expect(await got).toBe(2 * MiB)
      for (let i = 0; i < 100 && out.shared.length; i++) await tick()
      expect(out.shared).toEqual([])
      expect(out.pending).toBe(0)
    } finally {
      client.close()
      wss.close()
    }
  })
})
