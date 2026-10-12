// Wave M (M7-5, CAP-MEM): the process-wide outbound budget (outbound.ts OutboundBudget), with fake sessions.
// The per-session queues were capped (256 KiB presence skip, 8 MiB close) but their sum was not: above the
// budget every session skips presence; above 1.25 times it the largest queues reconnect (4000), largest first;
// `changes` frames are never skipped (a close, never a silent drop); the sum is lobby_outbound_bytes_queued.
import { CLOSE_RECONNECT } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
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
