// The spike B verifier V1's probe (part-3 round), adopted as a regression (V1_REPS, default 3; V1 ran 20): what the offline queue keeps across a reload. The engine core on a Map scene, a
// memory offline store carried over to a second core ("the reloaded page"), the real sync server.
import { describe, expect, it } from 'vitest'
import { tagWrite } from '../../../web/src/canvas/spike/features/model.ts'
import { LobbyEngineCore } from '../../../web/src/canvas/sync/core/engine.ts'
import { createMemoryOfflineStore } from '../../../web/src/canvas/sync/core/offline-memory.ts'
import { bump, createMapScene } from '../../../web/src/canvas/sync/headless/scene.ts'
import { createSocketTransport } from '../../../web/src/canvas/sync/transport/socket.ts'
import type { OfflineEntry, SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { note } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { sleep, startProxy, until, vlog } from './support.ts'

const h = useElementHarness()
const REPS = Number(process.env.V1_REPS ?? 3)

function makeCore(
  syncUrl: string,
  boardId: string,
  user: string,
  tab: string,
  initial: readonly OfflineEntry[],
) {
  const scene = createMapScene()
  const store = createMemoryOfflineStore(initial)
  const base = syncUrl.replace(/^http/, 'ws')
  const transport = createSocketTransport({
    url: async () =>
      `${base}/connect/${boardId}?${new URLSearchParams({ sessionId: tab, ticket: ticketFor(boardId, user) })}`,
    WebSocketImpl: TicketWebSocket,
    backoffMs: [50, 100, 200],
  })
  const core = new LobbyEngineCore({ transport, scene, tab, offline: store })
  const edit = (fn: (m: Map<string, SceneElement>) => void) => {
    fn(scene.map)
    core.onSceneChange(scene.read())
  }
  return {
    core,
    scene,
    store,
    transport,
    edit,
    start() {
      core.start()
      transport.connect()
    },
    stop() {
      core.stop()
      transport.close(1000, 'reload')
    },
  }
}

describe('V1 offline queue across a reload', () => {
  it('N8: offline, A tags N with a NEW tag (tagDef doc write + tag key), then reloads and reconnects: is the tag stored?', async () => {
    const st = await h.stack()
    const out: {
      rep: number
      offlineState: string
      queued: number
      tagStored: boolean
      defStored: boolean
      rejects: string[]
    }[] = []
    for (let rep = 0; rep < REPS; rep++) {
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const tab = `tab-a${rep}`
      const A1 = makeCore(px.url, b, 'alice', tab, [])
      A1.start()
      await until(() => A1.core.saveStatus.state === 'saved' && !!A1.core.sid, 'A1 welcome')
      const N = `n${rep}x`
      A1.edit((m) => m.set(N, note(N, { x: 10, y: 10 }) as unknown as SceneElement))
      A1.core.flush()
      await until(() => A1.core.saveStatus.state === 'saved', 'N saved')
      // offline: every frame dropped, the socket cut; the reconnect never gets a welcome
      px.dropUp = true
      px.dropDown = true
      px.cutAll()
      await until(() => A1.core.saveStatus.state === 'offline', 'offline')
      const w = tagWrite(`Topic ${rep}`, { existing: () => undefined, defined: 0 })
      if (!w.ok) throw new Error('tagWrite')
      A1.core.setDoc({ [w.docKey]: w.value })
      A1.edit((m) => {
        const el = m.get(N) as SceneElement
        const cd = (el as { customData?: Record<string, unknown> }).customData ?? {}
        const lobby = (cd.lobby as Record<string, unknown> | undefined) ?? {}
        m.set(N, bump(el, { customData: { ...cd, lobby: { ...lobby, [w.elementKey]: w.value } } }))
      })
      A1.core.persistNow()
      await sleep(50)
      const offlineState = A1.core.saveStatus.state
      const entries = (A1.store as unknown as { entries(): readonly OfflineEntry[] }).entries()
      // the page reloads: a new core with the queue the old page left
      A1.stop()
      await px.close()
      const A2 = makeCore(st.server.url, b, 'alice', tab, entries)
      const rejects: string[] = []
      A2.core.on((e) => {
        if (e.kind === 'reject') rejects.push(`${e.id}:${e.code}`)
      })
      A2.start()
      await until(() => !!A2.core.sid, 'A2 welcome')
      await until(
        () => A2.core.saveStatus.state === 'saved' || A2.core.saveStatus.state === 'not-saved',
        'A2 settles',
        20_000,
      )
      const snap = await st.snapshot(b)
      const n = snap.elements.find((e) => e.id === N) as { customData?: { lobby?: Record<string, unknown> } }
      const res = await fetch(`${st.server.url}/internal/boards/${b}/snapshot`, {
        headers: { 'x-draftroom-internal-secret': 'x' },
      }).catch(() => null)
      void res
      out.push({
        rep,
        offlineState,
        queued: entries.length,
        tagStored: n?.customData?.lobby?.[w.elementKey] !== undefined,
        defStored: A2.core.doc().has(w.docKey),
        rejects,
      })
      A2.stop()
    }
    vlog('N8', JSON.stringify(out))
    expect(out.filter((o) => !o.tagStored || !o.defStored)).toEqual([])
  }, 600_000)
})
