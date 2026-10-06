// The spike B verifier V1's probe (part-3 round), adopted as a regression (V1_REPS, default 3; V1 ran 20): the STALE rule for old offline replays end to end (plan §2.4.3 step 8, §2.5.6):
// "a replayed op older than 10 minutes, for a group someone else wrote after its base, gets STALE". The
// engine core with an injected clock (its `off` is 11 minutes), a real reconnect, the real server.
import { describe, expect, it } from 'vitest'
import { LobbyEngineCore } from '../../../web/src/canvas/sync/core/engine.ts'
import { createMemoryOfflineStore } from '../../../web/src/canvas/sync/core/offline-memory.ts'
import { bump, createMapScene } from '../../../web/src/canvas/sync/headless/scene.ts'
import { createSocketTransport } from '../../../web/src/canvas/sync/transport/socket.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { sleep, startProxy, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)

describe('V1 STALE for old offline replays', () => {
  it("N17: A edits x offline, B edits x (acked), A comes back 11 minutes later (client clock): STALE per the plan, B's x kept", async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      let skew = 0
      const now = () => Date.now() + skew
      const scene = createMapScene()
      const tab = `tab-a${rep}`
      const base = px.url.replace(/^http/, 'ws')
      const transport = createSocketTransport({
        url: async () =>
          `${base}/connect/${b}?${new URLSearchParams({ sessionId: tab, ticket: ticketFor(b, 'alice') })}`,
        WebSocketImpl: TicketWebSocket,
        backoffMs: [50, 100, 200],
      })
      const core = new LobbyEngineCore({ transport, scene, tab, offline: createMemoryOfflineStore(), now })
      const rejects: string[] = []
      core.on((e) => {
        if (e.kind === 'reject') rejects.push(e.code)
      })
      core.start()
      transport.connect()
      await until(() => !!core.sid && core.saveStatus.state === 'saved', 'A welcome')
      const N = `n${rep}x`
      const byB = rep % 2 === 1
      const B = await st.client({ boardId: b, user: 'bob' })
      if (byB) {
        await B.create([rect(N, { x: 0, y: 0 })])
        await until(() => core.confirmed(N) !== undefined, 'A sees N')
      } else {
        scene.map.set(N, rect(N, { x: 0, y: 0 }) as unknown as SceneElement)
        core.onSceneChange(scene.read())
        core.flush()
        await until(() => core.saveStatus.state === 'saved', 'N saved')
      }
      await B.until(() => B.confirmed.has(N), 'B sees N')
      // A offline
      px.dropUp = true
      px.dropDown = true
      px.cutAll()
      await until(() => core.saveStatus.state === 'offline', 'A offline')
      scene.map.set(N, bump(scene.map.get(N) as SceneElement, { x: 111 }))
      core.onSceneChange(scene.read())
      // B writes x meanwhile
      await B.push([{ k: 'p', id: N, pv: B.confirmed.get(N)?.version, g: { pos: { x: 222, y: 0 } } }])
      // eleven minutes pass on A's clock; A reconnects
      skew = 11 * 60_000
      px.dropUp = false
      px.dropDown = false
      px.cutAll()
      await until(
        () => core.saveStatus.state === 'saved' || core.saveStatus.state === 'not-saved',
        'A settles',
        20_000,
      )
      await sleep(200)
      const pushed = core
        .pushLog()
        .slice(-3)
        .flatMap((p) =>
          p.ops.map((o) => ({
            seq: p.seq,
            base: p.base,
            at: p.at,
            id: (o as { id?: string }).id,
            g: Object.keys((o as { g?: object }).g ?? {}),
            off: (o as { off?: number }).off ?? null,
          })),
        )
      const stored = ((await st.snapshot(b)).elements.find((e) => e.id === N) as { x: number }).x
      out.push({
        rep,
        creator: byB ? 'B' : 'A',
        stored,
        rejects,
        state: core.saveStatus.state,
        pushes: pushed,
        ok: stored === 222 && rejects.includes('STALE'),
      })
      core.stop()
      transport.close(1000, 'done')
      B.close()
      await px.close()
    }
    vlog('N17', JSON.stringify(out))
    expect(out.filter((o) => !o.ok)).toEqual([])
  }, 600_000)
})
