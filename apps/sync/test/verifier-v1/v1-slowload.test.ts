// The spike B verifier V1's probe (part-3 round), adopted as a regression (V1_REPS, default 3; V1 ran 20): Saved before the previous page's offline queue is loaded. A reloaded page's
// queue load can wait (the Web Lock of the old page, IndexedDB); the welcome may come first.
import { describe, expect, it } from 'vitest'
import { LobbyEngineCore } from '../../../web/src/canvas/sync/core/engine.ts'
import { bump, createMapScene } from '../../../web/src/canvas/sync/headless/scene.ts'
import { createSocketTransport } from '../../../web/src/canvas/sync/transport/socket.ts'
import type { OfflineEntry, OfflineQueueStore, SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { sleep, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)

describe('V1 Saved while the old queue is not loaded yet', () => {
  it('N20: a reloaded page whose queue load takes 800 ms after the welcome: is Saved shown before the queued edit is adopted?', async () => {
    const st = await h.stack()
    const out: Record<string, unknown>[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const B = await st.client({ boardId: b, user: 'bob' })
      const N = `n${rep}x`
      await B.create([rect(N, { x: 0, y: 0 })])
      const conf = B.confirmed.get(N) as Record<string, unknown>
      // the old page left one queued edit of N
      const entry: OfflineEntry = {
        element: bump(conf as unknown as SceneElement, { x: 555 }),
        groups: ['pos'],
        base: B.clock,
        queuedAt: Date.now() - 2000,
      }
      let loaded = false
      const store: OfflineQueueStore = {
        load: async () => {
          await sleep(800)
          loaded = true
          return [entry]
        },
        save: async () => {},
        clear: async () => {},
      }
      const scene = createMapScene()
      const tab = `tab-a${rep}`
      const transport = createSocketTransport({
        url: async () =>
          `${st.server.wsUrl}/connect/${b}?${new URLSearchParams({ sessionId: tab, ticket: ticketFor(b, 'alice') })}`,
        WebSocketImpl: TicketWebSocket,
      })
      const core = new LobbyEngineCore({ transport, scene, tab, offline: store })
      const states: { s: string; loaded: boolean; t: number }[] = []
      const t0 = Date.now()
      core.onSaveStatus((s) => states.push({ s: s.state, loaded, t: Date.now() - t0 }))
      core.start()
      transport.connect()
      await until(() => loaded, 'queue loaded', 5000)
      await until(() => core.saveStatus.state === 'saved' && loaded, 'saved after adoption', 10_000)
      await sleep(100)
      const stored = ((await st.snapshot(b)).elements.find((e) => e.id === N) as { x: number }).x
      const savedBeforeLoad = states.filter((s) => s.s === 'saved' && !s.loaded)
      out.push({
        rep,
        states: states.map((s) => `${s.s}${s.loaded ? '' : '(queue unread)'}@${s.t}`),
        stored,
        savedBeforeLoad: savedBeforeLoad.length,
      })
      core.stop()
      transport.close(1000, 'done')
      B.close()
    }
    vlog('N20', JSON.stringify(out))
    expect(out.filter((o) => (o.savedBeforeLoad as number) > 0 || o.stored !== 555)).toEqual([])
  }, 600_000)
})
