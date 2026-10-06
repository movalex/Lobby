// The spike B verifier V1's probe (part-3 round), adopted as a regression (V1_REPS, default 3; V1 ran 20): N16's captured divergence (a Saved client holding an element with the server's
// version and content but another versionNonce), made deterministic. A recolours X; before A's coalesced
// push goes out, B's identical recolour lands; A's flush then finds nothing to send for the dirty group.
// A's timers are manual (the flush runs when the test calls it).
import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { createLobbyHeadlessClient } from '../../../web/src/canvas/sync/headless/index.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { sleep, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)

describe('V1 a dirty group overtaken by the same remote value', () => {
  it('N18: A recolours X, B makes the same recolour first; A flushes: A is Saved and must hold exactly the server copy', async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const pending: (() => void)[] = []
      const A = createLobbyHeadlessClient({
        syncUrl: st.server.url,
        boardId: b,
        tab: `tab-a${rep}`,
        ticket: ticketFor(b, 'alice'),
        WebSocketImpl: TicketWebSocket,
        // manual timers: coalesced flushes (and the rest) run only when the test says
        setTimer: (fn: () => void) => {
          pending.push(fn)
          return pending.length
        },
        clearTimer: () => {},
      })
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      const X = `x${rep}x`
      const field = rep % 2 === 0 ? 'strokeColor' : 'opacity'
      const value = rep % 2 === 0 ? '#e03131' : 60
      await B.create([rect(X, { x: 0, y: 0 })])
      await until(() => A.core.confirmed(X) !== undefined, 'A sees X')
      A.change(X, { [field]: value })
      const ack = await B.push([
        { k: 'p', id: X, pv: B.confirmed.get(X)?.version, g: { style: { [field]: value } } },
      ])
      await until(() => A.core.clock >= ack.clock, 'A applied B')
      A.core.flush()
      await sleep(150)
      const sceneX = A.scene.get(X) as { version: number; versionNonce: number }
      const conf = A.core.confirmed(X) as { version: number; versionNonce: number }
      const snap = await st.snapshot(b)
      const digest = await hashElements(snap.elements)
      const mine = await hashElements(A.core.elements().values())
      out.push({
        rep,
        field,
        state: A.core.saveStatus.state,
        pushed: A.core.pushLog().filter((p) => p.ops.some((o) => (o.k === 'c' ? o.el.id : o.id) === X))
          .length,
        scene: [sceneX.version, sceneX.versionNonce],
        server: [conf.version, conf.versionNonce],
        converged: mine === digest,
        ok: mine === digest && sceneX.versionNonce === conf.versionNonce && sceneX.version === conf.version,
      })
      await A.close()
      B.close()
    }
    vlog('N18', JSON.stringify(out))
    expect(out.filter((o) => !o.ok)).toEqual([])
  }, 600_000)
})
